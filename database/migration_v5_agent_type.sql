-- ============================================
-- migration_v5_agent_type.sql
-- Additive: existing rows default to 'loan_enquiry'. No data loss.
-- Context: adding a second agent type (account_opening) alongside
-- the existing loan_enquiry agent. The batch dispatcher uses agent_type
-- to determine which LiveKit worker to dispatch for each call.
-- 2026-05-05
-- ============================================

ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';

ALTER TABLE agent_batches
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(50) NOT NULL DEFAULT 'loan_enquiry';

-- CHECK constraints: reject any agent_type value not known to this system
ALTER TABLE agent_calls
  DROP CONSTRAINT IF EXISTS chk_agent_calls_agent_type;
ALTER TABLE agent_calls
  ADD CONSTRAINT chk_agent_calls_agent_type
    CHECK (agent_type IN ('loan_enquiry', 'account_opening'));

ALTER TABLE agent_batches
  DROP CONSTRAINT IF EXISTS chk_agent_batches_agent_type;
ALTER TABLE agent_batches
  ADD CONSTRAINT chk_agent_batches_agent_type
    CHECK (agent_type IN ('loan_enquiry', 'account_opening'));

-- Indexes for batch-status queries that filter by agent_type
CREATE INDEX IF NOT EXISTS idx_agent_calls_agent_type
  ON agent_calls(agent_type);

CREATE INDEX IF NOT EXISTS idx_agent_batches_agent_type
  ON agent_batches(agent_type);
