-- ============================================================================
--  migration_v30_fix_loan_status_check.sql
--
--  BUG: loan_applications_status_check omitted 'documents_requested' (and
--  'disbursed'/'cancelled'/'withdrawn'), but the app writes those statuses —
--  so "Request Documents" (and disburse / cancel / withdraw) 500 in production.
--
--  Fix: replace the CHECK with the full union of the lending workflow — every
--  status the current constraint allowed PLUS every status the code actually
--  writes. All existing rows already fall inside this set (verified), so the
--  constraint validates cleanly. Idempotent.
-- ============================================================================

ALTER TABLE loan_applications DROP CONSTRAINT IF EXISTS loan_applications_status_check;
ALTER TABLE loan_applications ADD CONSTRAINT loan_applications_status_check
    CHECK (status IN (
        'draft',
        'submitted',
        'system_reviewed',
        'officer_approved',
        'officer_rejected',
        'supervisor_rejected',
        'documents_requested',
        'documents_submitted',
        'approved',
        'disbursed',
        'cancelled',
        'withdrawn'
    ));
