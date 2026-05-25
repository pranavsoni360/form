-- ============================================================================
-- v14 — agent_batches.preferred_phone_id
-- ============================================================================
-- Lets the operator pick a specific phone_numbers row to dial FROM on a per-
-- batch basis (via the "From number" dropdown on /ops/batch).
--
-- When set, the dispatcher restricts trunk acquisition to that one row —
-- ignores least-loaded balancing across the rest of the pool. When NULL
-- (the default), behavior is unchanged: auto-pick least-loaded across the
-- pool.
--
-- ON DELETE SET NULL — if the operator deletes a phone row mid-batch, the
-- column nullifies and the dispatcher falls back to pool defaults rather
-- than the batch failing hard.
-- ============================================================================

ALTER TABLE agent_batches
  ADD COLUMN IF NOT EXISTS preferred_phone_id UUID
  REFERENCES phone_numbers(id) ON DELETE SET NULL;

-- Partial index — most batches won't set this, so we only index non-null rows
CREATE INDEX IF NOT EXISTS idx_agent_batches_preferred_phone
  ON agent_batches(preferred_phone_id)
  WHERE preferred_phone_id IS NOT NULL;
