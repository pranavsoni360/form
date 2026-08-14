-- ============================================================================
--  migration_v39_relax_bank_code_validate_guards.sql
--
--  Two DB-readiness cleanups so the governance guards cover EXISTING data, not
--  just new writes:
--
--   1. chk_banks_code_format was uppercase-only (^[A-Z0-9_]{2,20}$), but real
--      onboarded banks use lowercase codes ('newbank', 'virtualgalaxytesting').
--      Relax to allow lowercase — still blocks whitespace / symbols / junk like
--      '@@#@#'. Recreated WITHOUT NOT VALID so it validates immediately (verified:
--      no bank in prod or QA violates the relaxed pattern).
--
--   2. Validate chk_maker_ne_checker (added NOT VALID in v38). The one QA test row
--      where officer=supervisor was corrected (supervisor nulled) and prod had no
--      violations, so both can now enforce maker != checker on existing rows too.
--      Guarded: if any violation remains it stays NOT VALID rather than aborting.
--
--  Idempotent.
-- ============================================================================

ALTER TABLE banks DROP CONSTRAINT IF EXISTS chk_banks_code_format;
ALTER TABLE banks ADD CONSTRAINT chk_banks_code_format
    CHECK (code ~ '^[A-Za-z0-9_]{2,20}$');

DO $$
BEGIN
    ALTER TABLE loan_applications VALIDATE CONSTRAINT chk_maker_ne_checker;
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'chk_maker_ne_checker still has violating rows — left NOT VALID; clean the data and re-run VALIDATE CONSTRAINT.';
END $$;
