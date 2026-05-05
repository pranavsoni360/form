-- ============================================
-- migration_v5_agent_type.sql
-- Additive: existing rows default to 'loan_enquiry'. No data loss.
-- Context: adding a second agent type (union_account_opening) alongside
-- the existing loan_enquiry agent. The batch dispatcher uses agent_type
-- to determine which LiveKit worker to dispatch for each call.
-- ============================================

ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';

ALTER TABLE agent_batches
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';
