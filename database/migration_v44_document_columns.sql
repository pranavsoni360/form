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

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS salary_slips_url TEXT,
    ADD COLUMN IF NOT EXISTS itr_form16_url   TEXT;

COMMENT ON COLUMN loan_applications.salary_slips_url IS
    'Last 3 months salary slips. Collected by the loan form; had no column until v44, so uploads were stored only in application_documents.';
COMMENT ON COLUMN loan_applications.itr_form16_url IS
    'ITR / Form 16. Optional income evidence. Collected by the loan form; had no column until v44.';

-- ── Reconcile the two bank-statement columns ────────────────────────────────
-- `bank_statement_url` (singular, schema.sql) predates the form's
-- `bank_statements_url` (plural). Both exist; the form writes the plural and
-- scoring reads the singular. Rather than drop either — old rows may hold data
-- in either one — backfill the singular from the plural so any consumer of the
-- historical name keeps working, and point normalize.py at the plural going
-- forward.
UPDATE loan_applications
   SET bank_statement_url = bank_statements_url
 WHERE bank_statement_url IS NULL
   AND bank_statements_url IS NOT NULL;

COMMENT ON COLUMN loan_applications.bank_statement_url IS
    'DEPRECATED alias of bank_statements_url, kept because older rows and code may reference it. v44 backfills it; new writes go to bank_statements_url.';
