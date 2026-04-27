-- ============================================================
-- Wipe script — drops every LOS table so schema_v3.sql can
-- be applied cleanly. Safe to run against a dev database.
-- ============================================================

-- Drop in reverse-dependency order; IF EXISTS handles missing tables.
DROP TABLE IF EXISTS agent_system_config CASCADE;
DROP TABLE IF EXISTS agent_calls CASCADE;
DROP TABLE IF EXISTS agent_batches CASCADE;
DROP TABLE IF EXISTS whatsapp_messages CASCADE;
DROP TABLE IF EXISTS rate_limits CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS form_autosave_log CASCADE;
DROP TABLE IF EXISTS status_transitions CASCADE;
DROP TABLE IF EXISTS loan_sessions CASCADE;
DROP TABLE IF EXISTS otp_verifications CASCADE;
DROP TABLE IF EXISTS form_tokens CASCADE;
DROP TABLE IF EXISTS loan_applications CASCADE;
DROP TABLE IF EXISTS login_attempts CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS vendors CASCADE;
DROP TABLE IF EXISTS banks CASCADE;

-- Legacy tables from v1/v2 (pre-unification)
DROP TABLE IF EXISTS bank_users CASCADE;
DROP TABLE IF EXISTS admin_users CASCADE;

-- Functions
DROP FUNCTION IF EXISTS touch_updated_at() CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
