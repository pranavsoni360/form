-- migration_v42_aa_statement.sql
-- Account Aggregator / Statement Upload: session tracking + pre-mapped LRS inputs
-- on loan_applications. Idempotent.

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS aa_request_id   TEXT,
    ADD COLUMN IF NOT EXISTS aa_txn_id       TEXT,
    ADD COLUMN IF NOT EXISTS aa_initiated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS aa_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS aa_lrs_inputs   JSONB;

CREATE INDEX IF NOT EXISTS idx_loan_apps_aa_request
    ON loan_applications (aa_request_id)
    WHERE aa_request_id IS NOT NULL;
