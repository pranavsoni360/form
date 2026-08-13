-- ============================================================================
--  migration_v33_stress_fixes.sql
--
--  Fixes the three issues the stress test surfaced. Additive + idempotent.
--
--  BUG #1 (correctness): a multi-row INSERT into credit_ledger makes every row
--    read the pre-statement balance (snapshot visibility), corrupting the
--    running balance_after / banks.credit_balance. The app only ever inserts
--    one row at a time, so guard the invariant: reject multi-row inserts.
--  BUG #2 (minor): banks.updated_at was never auto-maintained (v26 added the
--    column but no BEFORE UPDATE trigger).
--  BUG #3 (scale perf): FK columns with no supporting index -> slow joins and
--    slow cascade deletes at volume.
-- ============================================================================

-- ── BUG #1: reject multi-row credit_ledger inserts ──────────────────────────
CREATE OR REPLACE FUNCTION fn_credit_ledger_single_row() RETURNS trigger AS $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM new_rows;
    IF n > 1 THEN
        RAISE EXCEPTION
            'credit_ledger requires single-row inserts to keep the running balance correct (attempted % rows). Insert one entry per statement.', n;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_credit_ledger_single_row ON credit_ledger;
CREATE TRIGGER trg_credit_ledger_single_row
    AFTER INSERT ON credit_ledger
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION fn_credit_ledger_single_row();

-- ── BUG #2: keep banks.updated_at fresh ─────────────────────────────────────
DROP TRIGGER IF EXISTS trg_banks_upd ON banks;
CREATE TRIGGER trg_banks_upd BEFORE UPDATE ON banks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── BUG #3: index the FK columns the stress test found unindexed ────────────
CREATE INDEX IF NOT EXISTS idx_agent_calls_agent_config   ON agent_calls (agent_config_id);
CREATE INDEX IF NOT EXISTS idx_agent_configs_pool         ON agent_configs (pool_id);
CREATE INDEX IF NOT EXISTS idx_agent_configs_template     ON agent_configs (template_id);
CREATE INDEX IF NOT EXISTS idx_bank_subscriptions_plan    ON bank_subscriptions (plan_id);
CREATE INDEX IF NOT EXISTS idx_bank_users_reports_to      ON bank_users (reports_to);
CREATE INDEX IF NOT EXISTS idx_banks_rate_card            ON banks (rate_card_id);
CREATE INDEX IF NOT EXISTS idx_form_tokens_bank           ON form_tokens (bank_id);
CREATE INDEX IF NOT EXISTS idx_invoices_rate_card         ON invoices (rate_card_id);
CREATE INDEX IF NOT EXISTS idx_loan_applications_officer  ON loan_applications (officer_id);
CREATE INDEX IF NOT EXISTS idx_loan_applications_super    ON loan_applications (supervisor_id);
CREATE INDEX IF NOT EXISTS idx_loan_sessions_application  ON loan_sessions (application_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm      ON role_permissions (permission_id);
CREATE INDEX IF NOT EXISTS idx_roles_bank                 ON roles (bank_id);
CREATE INDEX IF NOT EXISTS idx_scorecard_versions_product ON scorecard_versions (product_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_invoice      ON usage_records (invoice_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_bank            ON user_roles (bank_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role            ON user_roles (role_id);
CREATE INDEX IF NOT EXISTS idx_vendor_settlements_app     ON vendor_settlements (application_id);
