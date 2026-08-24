-- migration_v43_per_bank_calling_stop.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-bank emergency stop, so one tenant can halt its own calling without
-- halting everyone else's.
--
-- Until now "emergency stop" was a single row in agent_system_config
-- (key = 'emergency_stop'), read by the dispatcher before every call, by the
-- batch runner, by the cron auto-chain and by the guarantor runner. Any bank
-- user could set it, and it stopped calling for EVERY tenant on the platform —
-- and /resume-calling un-paused every paused batch, including batches another
-- bank had deliberately stopped.
--
-- The model after this migration:
--   agent_system_config.emergency_stop  -> PLATFORM-wide kill switch. Operator
--                                          (admin token) only. Still checked
--                                          first, so VGIPL can stop everything.
--   banks.calling_emergency_stopped     -> that ONE bank's stop. Set and cleared
--                                          by that bank, or by an operator on
--                                          its behalf.
--
-- A call is blocked if EITHER is set.
--
-- Why not reuse banks.calling_paused: that column is owned by the billing
-- trigger (fn_credit_ledger_after sets it from credit_balance <= 0). If a
-- resume cleared it, a bank with no balance would start dialling again. The two
-- reasons for "not dialling" have to stay independent.
--
-- Additive and idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE banks
    ADD COLUMN IF NOT EXISTS calling_emergency_stopped BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS emergency_stopped_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS emergency_stopped_by      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS emergency_stop_reason     TEXT;

COMMENT ON COLUMN banks.calling_emergency_stopped IS
    'Per-bank emergency stop. TRUE = do not dial for this bank. Independent of '
    'calling_paused, which the billing trigger owns (balance <= 0).';
COMMENT ON COLUMN banks.emergency_stopped_by IS
    'Username that last set or cleared the stop, for the audit trail.';

-- The dispatcher reads this once per call, so keep the lookup cheap. Partial:
-- only the stopped rows matter, and there will be very few of them.
CREATE INDEX IF NOT EXISTS idx_banks_emergency_stopped
    ON banks (id) WHERE calling_emergency_stopped = TRUE;

-- The runtime role needs to read and write the new columns. GRANTs on the table
-- already cover added columns in Postgres, but be explicit for the scoped role
-- so a least-privilege setup does not silently lose the ability to resume.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'los_app_qa') THEN
        GRANT SELECT, UPDATE ON banks TO los_app_qa;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'los_app') THEN
        GRANT SELECT, UPDATE ON banks TO los_app;
    END IF;
END$$;
