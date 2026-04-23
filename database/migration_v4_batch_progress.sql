-- ============================================
-- Migration v4 — Batch progress tracking
-- Adds fields needed for cancellable, progress-
-- tracked, concurrency-clamped batch calling.
-- Safe to re-run (all IF NOT EXISTS).
-- ============================================

ALTER TABLE agent_batches
    ADD COLUMN IF NOT EXISTS max_concurrent INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS progress       JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS error          TEXT;

-- Faster per-batch status aggregation for progress queries.
CREATE INDEX IF NOT EXISTS idx_agent_calls_batch_status
    ON agent_calls(batch_id, status);

-- Admin batch listings sort by newest first and filter by status.
CREATE INDEX IF NOT EXISTS idx_agent_batches_status
    ON agent_batches(status, created_at DESC);
