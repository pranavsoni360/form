-- ============================================================================
-- v15 — agent_calls callback columns (scheduled_callback_at, callback_reason)
-- ============================================================================
-- Why: the callback-detection feature (see
-- docs/superpowers/specs/2026-05-25-callback-llm-detection-design.md) added
-- these two columns to the local dev DB by hand, but NO migration ever
-- captured them. As a result every fresh database (including the GPU
-- production DB) lacks them.
--
-- Impact when missing: services/dispatcher.py (the batch dialer) and
-- agent/callbacks.py both FILTER and ORDER on scheduled_callback_at, e.g.
--   WHERE ... (scheduled_callback_at IS NULL OR scheduled_callback_at <= NOW())
--   ORDER BY COALESCE(scheduled_callback_at, created_at) ASC
-- so the _scheduled_batch_run cron crashes every tick with
--   asyncpg.exceptions.UndefinedColumnError: column "scheduled_callback_at" does not exist
-- and automated outbound calling / callbacks never fire.
--
-- This migration is idempotent (ADD COLUMN IF NOT EXISTS) so it is a safe
-- no-op on databases that already have the columns (local dev).
-- ============================================================================

ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS scheduled_callback_at TIMESTAMPTZ;

ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS callback_reason TEXT;

-- Partial index — only a small fraction of rows are scheduled callbacks.
-- Both the dispatcher (scheduled_callback_at <= NOW() filter + COALESCE
-- ordering) and agent/callbacks.py (ORDER BY scheduled_callback_at ASC)
-- benefit from indexing just the non-null rows.
CREATE INDEX IF NOT EXISTS idx_agent_calls_scheduled_callback_at
  ON agent_calls(scheduled_callback_at)
  WHERE scheduled_callback_at IS NOT NULL;
