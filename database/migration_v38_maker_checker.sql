-- ============================================================================
--  migration_v38_maker_checker.sql   (task #7 — governance / maker-checker)
--
--    1. chk_maker_ne_checker — a loan cannot be approved by the same person who
--       acted as its officer (maker) and supervisor (checker). Added NOT VALID
--       so existing (possibly single-user test) rows are not rejected, but every
--       new/updated row must satisfy maker != checker.
--    2. loan_products.second_approver_threshold — loan amount above which a
--       second approver is required (per product; NULL = no second approver).
--    3. application_approvals — the maker-checker audit trail: one row per
--       approval/rejection decision (officer / supervisor / second_approver), so
--       "who approved what, when" is a first-class record rather than inferred
--       from status columns.
--
--    Auditor read-only: the 'bank_auditor' role already exists in the
--    bank_users role CHECK (added in v28). Enforcing its read-only permission
--    set lives in the RBAC roles/permissions seed (colleague's domain), so this
--    migration does not duplicate it.
--
--  Additive + idempotent.
-- ============================================================================

-- ── 1. maker != checker guard ───────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_maker_ne_checker'
          AND conrelid = 'loan_applications'::regclass
    ) THEN
        ALTER TABLE loan_applications
            ADD CONSTRAINT chk_maker_ne_checker
            CHECK (officer_id IS NULL OR supervisor_id IS NULL OR officer_id <> supervisor_id)
            NOT VALID;
    END IF;
END$$;

-- ── 2. second-approver threshold per product ────────────────────────────────
ALTER TABLE loan_products
    ADD COLUMN IF NOT EXISTS second_approver_threshold numeric(15,2);

-- ── 3. application_approvals (maker-checker audit trail) ─────────────────────
CREATE TABLE IF NOT EXISTS application_approvals (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id uuid NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id        uuid REFERENCES banks(id) ON DELETE SET NULL,
    approver_type  text NOT NULL
                        CHECK (approver_type IN ('officer','supervisor','second_approver')),
    approver_id    uuid,
    approver_name  text,
    decision       text NOT NULL CHECK (decision IN ('approved','rejected')),
    decision_at    timestamptz NOT NULL DEFAULT now(),
    notes          text
);
CREATE INDEX IF NOT EXISTS idx_app_approvals_application ON application_approvals (application_id, decision_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_approvals_bank        ON application_approvals (bank_id);
