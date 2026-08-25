-- ============================================================================
--  v44 — Make every document the customer form collects actually readable
--
--  WHY
--  ---
--  The loan form asks for 7 documents, two of which have NO COLUMN on
--  loan_applications: `salary_slips_url` and `itr_form16_url`. The upload path
--  already knows this — main.py catches the failure and logs
--  "Legacy *_url update skipped", relying on `application_documents` as the
--  durable record — so no file is lost. But nothing can read those two back from
--  the application row, which means:
--
--    * the form's own required-check passes only because it trusts its local
--      state, not the persisted row: a customer who uploads salary slips and
--      then RELOADS sees the field empty again and has to re-upload;
--    * scoring cannot see them at all.
--
--  Two further mismatches in the same family:
--
--    * lrs/normalize.py builds a `_doc_bank_statement_url` flag from the
--      SINGULAR column, while the form writes the PLURAL `bank_statements_url`.
--      Both columns exist (schema.sql:127 and the form's own field), so the flag
--      is computed from a column nothing populates.
--    * normalize.py also checks `income_proof_url`, which NO form collects. It
--      is a leftover from an earlier document set.
--
--  None of this is currently visible because zero scorecard parameters set
--  `doc_required` — the whole `_doc_*` capping mechanism is wired and inert. The
--  moment it is switched on, bank statements and salary slips would read as
--  "not provided" for every applicant and silently cap their scores.
--
--  This migration fixes the storage half. The normalize.py half is fixed in the
--  same commit.
-- ============================================================================

-- ── CORRECTION (2026-08-25) ─────────────────────────────────────────────────
-- v44 as first written assumed `bank_statements_url` already existed ("Both
-- columns exist"). It does not, and never did — not in los_form_qa and not in
-- production. The only *_url columns on loan_applications were:
--
--     aadhaar_front_url, aadhaar_back_url, pan_card_url, photo_url,
--     income_proof_url, bank_statement_url (SINGULAR), quotation_url
--
-- so the UPDATE at the foot of this file raised
-- `UndefinedColumnError: column "bank_statements_url" does not exist` and
-- aborted the whole QA migration run before any service restarted.
--
-- Comparing main.py's field_mapping and loanDocuments.ts against the live
-- schema, FIVE of the twelve document targets had no column, not two:
--
--     salary_slips_url             (v44 added)
--     itr_form16_url               (v44 added)
--     bank_statements_url          <- required:true in the form catalogue
--     proof_of_identification_url  <- read by the new normalize.py
--     proof_of_residence_url       <- read by the new normalize.py
--
-- The bank-statements one is not cosmetic. The same commit made required
-- documents actually enforced (`d.required && !formData[d.key]`), and that check
-- reads the persisted row: with no column to persist into, a customer who
-- uploads bank statements and reloads could never satisfy the requirement and
-- so could never submit. All five are added here.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS salary_slips_url            TEXT,
    ADD COLUMN IF NOT EXISTS itr_form16_url              TEXT,
    ADD COLUMN IF NOT EXISTS bank_statements_url         TEXT,
    ADD COLUMN IF NOT EXISTS proof_of_identification_url TEXT,
    ADD COLUMN IF NOT EXISTS proof_of_residence_url      TEXT;

COMMENT ON COLUMN loan_applications.salary_slips_url IS
    'Last 3 months salary slips. Collected by the loan form; had no column until v44, so uploads were stored only in application_documents.';
COMMENT ON COLUMN loan_applications.itr_form16_url IS
    'ITR / Form 16. Optional income evidence. Collected by the loan form; had no column until v44.';
COMMENT ON COLUMN loan_applications.bank_statements_url IS
    'Bank statements (last 6 months). Canonical column; the form writes this name. Added in v44 - it was assumed to exist and did not.';
COMMENT ON COLUMN loan_applications.proof_of_identification_url IS
    'Proof of identification. Optional. Collected by the loan form; had no column until v44.';
COMMENT ON COLUMN loan_applications.proof_of_residence_url IS
    'Proof of residence. Optional. Collected by the loan form; had no column until v44.';

-- ── Reconcile the two bank-statement columns ────────────────────────────────
-- `bank_statement_url` (singular, schema.sql) predates the form's
-- `bank_statements_url` (plural). Both exist; the form writes the plural and
-- scoring reads the singular. Rather than drop either — old rows may hold data
-- in either one — backfill the singular from the plural so any consumer of the
-- historical name keeps working, and point normalize.py at the plural going
-- forward.
-- Carry the history FORWARD first. Every bank statement collected to date is
-- in the singular column, because the plural did not exist; normalize.py now
-- reads the plural first, so without this every historical applicant reads as
-- "no bank statement" the moment a scorecard parameter sets doc_required -
-- precisely the silent score-capping this migration was written to prevent.
UPDATE loan_applications
   SET bank_statements_url = bank_statement_url
 WHERE bank_statements_url IS NULL
   AND bank_statement_url IS NOT NULL;

-- ...then keep the deprecated alias populated, as originally intended. A no-op
-- on the first run (nothing has ever written the plural); it earns its place on
-- re-runs and for any row written between the code deploy and this migration.
UPDATE loan_applications
   SET bank_statement_url = bank_statements_url
 WHERE bank_statement_url IS NULL
   AND bank_statements_url IS NOT NULL;

COMMENT ON COLUMN loan_applications.bank_statement_url IS
    'DEPRECATED alias of bank_statements_url, kept because older rows and code may reference it. v44 backfills it; new writes go to bank_statements_url.';
