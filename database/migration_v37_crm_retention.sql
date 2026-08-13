-- ============================================================================
--  migration_v37_crm_retention.sql   (task #7 — CRM + retention)
--
--    1. bank_contacts — the people at each bank (primary / billing / technical /
--       compliance). One flagged primary per bank.
--    2. banks.account_manager_id — the platform-side person who owns the
--       relationship (FK -> platform_admins). Additive nullable column.
--    3. bank_retention_config — per-bank data-retention policy (DPDP): how long
--       call recordings / documents / PII are kept, and whether auto-purge is
--       on. One row per bank. Feeds the #9 compliance surfaces.
--
--  Additive + idempotent.
-- ============================================================================

-- ── 1. bank_contacts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_contacts (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id    uuid NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
    name       text NOT NULL,
    role       text NOT NULL DEFAULT 'primary'
                    CHECK (role IN ('primary','billing','technical','compliance','escalation')),
    email      text,
    phone      text,
    is_primary boolean NOT NULL DEFAULT false,
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_contacts_bank ON bank_contacts (bank_id);
-- at most one primary contact per bank
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_primary_contact
    ON bank_contacts (bank_id) WHERE is_primary;

DROP TRIGGER IF EXISTS trg_bank_contacts_upd ON bank_contacts;
CREATE TRIGGER trg_bank_contacts_upd BEFORE UPDATE ON bank_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 2. account manager on the bank ──────────────────────────────────────────
ALTER TABLE banks
    ADD COLUMN IF NOT EXISTS account_manager_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_banks_account_manager ON banks (account_manager_id);

-- ── 3. bank_retention_config (DPDP) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_retention_config (
    bank_id                       uuid PRIMARY KEY REFERENCES banks(id) ON DELETE CASCADE,
    call_recording_retention_days int,           -- NULL = keep indefinitely
    document_retention_days       int,
    pii_retention_days            int,
    auto_purge_enabled            boolean NOT NULL DEFAULT false,
    updated_at                    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_retention_upd ON bank_retention_config;
CREATE TRIGGER trg_retention_upd BEFORE UPDATE ON bank_retention_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
