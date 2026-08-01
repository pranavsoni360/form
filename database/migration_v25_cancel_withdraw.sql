-- migration_v25_cancel_withdraw.sql
--
-- Adds two new terminal actions to the loan-application lifecycle:
--   * staff  "cancel"   -> status = 'cancelled'  (bank officer/supervisor voids an app)
--   * customer "delete" -> status = 'withdrawn'  (soft-delete; hidden from customer,
--                                                  full audit trail preserved)
--
-- Both are only permitted BEFORE money is out. "Money out" is signalled by
-- loan_applications.disbursed_at IS NOT NULL (see routers/vendors.py) — the
-- bank-side status stays 'approved', so the guards check disbursed_at, not a
-- status string.
--
-- Idempotent and safe to re-run (matches the db_migrations runner contract).

-- 1. Audit columns for the two new actions.
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS withdrawn_at        TIMESTAMPTZ;

-- 2. Expand the status CHECK constraint with 'cancelled' + 'withdrawn'.
--    Existing allowed values are preserved verbatim so no current row or code
--    path changes behaviour. (The pre-existing absence of 'documents_requested'
--    / 'disbursed' is intentionally left as-is — out of scope for this change.)
ALTER TABLE loan_applications DROP CONSTRAINT IF EXISTS loan_applications_status_check;
ALTER TABLE loan_applications ADD CONSTRAINT loan_applications_status_check
    CHECK (status IN (
        'draft', 'submitted', 'system_reviewed',
        'officer_approved', 'officer_rejected',
        'documents_submitted',
        'approved', 'supervisor_rejected',
        'cancelled', 'withdrawn'
    ));
