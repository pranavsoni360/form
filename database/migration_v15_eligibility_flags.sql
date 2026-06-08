-- migration_v15_eligibility_flags.sql
-- Adds two boolean eligibility-confirmation columns to loan_applications.
-- These are set by the voice agent after asking the customer the two
-- eligibility screening questions at the start of the call:
--   1. "Are you a salaried employee?"     → is_salaried
--   2. "Is this for individual purpose?"  → individual_purpose
-- Both are stored as BOOLEAN so the ops/admin dashboard can filter
-- applications that passed eligibility vs. those that slipped through.

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS is_salaried        BOOLEAN,
    ADD COLUMN IF NOT EXISTS individual_purpose BOOLEAN;

COMMENT ON COLUMN loan_applications.is_salaried        IS 'TRUE = customer confirmed salaried employee during voice call eligibility check';
COMMENT ON COLUMN loan_applications.individual_purpose IS 'TRUE = customer confirmed loan is for personal/individual use (not business) during voice call eligibility check';

-- Index for quick dashboard filtering
CREATE INDEX IF NOT EXISTS idx_loan_apps_is_salaried        ON loan_applications(is_salaried);
CREATE INDEX IF NOT EXISTS idx_loan_apps_individual_purpose ON loan_applications(individual_purpose);
