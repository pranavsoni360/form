-- ============================================
-- M2 — Migration V7
-- Phone pools + numbers with cooldown (SalkAI-style dispatcher foundation)
-- ============================================
-- Why: the new concurrent dispatcher (M4) needs explicit phone-number inventory
-- with per-number active_calls + cooldown_until state. Today phone numbers live
-- inside agent_system_config as a JSON blob, which doesn't support concurrency
-- control or cooldown tracking.
--
-- Safe to re-run.

-- Pool = a named bucket of numbers for a bank. One pool can have many numbers.
CREATE TABLE IF NOT EXISTS phone_pools (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_id                 UUID REFERENCES banks(id) ON DELETE CASCADE,
    name                    TEXT NOT NULL,
    capacity                INTEGER NOT NULL DEFAULT 5,
    cooldown_seconds_min    INTEGER NOT NULL DEFAULT 180,
    cooldown_seconds_max    INTEGER NOT NULL DEFAULT 300,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bank_id, name)
);

CREATE INDEX IF NOT EXISTS idx_phone_pools_bank ON phone_pools(bank_id);

-- Each physical phone number with a LiveKit SIP trunk + per-number runtime state.
-- active_calls is incremented at dispatch, decremented on release.
-- cooldown_until is set at release(success=true) to a random point 3-5 min ahead.
-- status: active = available, disabled = manually paused, quarantined = auto-paused
-- after repeated failures.
CREATE TABLE IF NOT EXISTS phone_numbers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pool_id             UUID NOT NULL REFERENCES phone_pools(id) ON DELETE CASCADE,
    phone_number        TEXT NOT NULL,
    livekit_trunk_id    TEXT,
    active_calls        INTEGER NOT NULL DEFAULT 0,
    total_calls         BIGINT NOT NULL DEFAULT 0,
    cooldown_until      TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','disabled','quarantined')),
    last_failure_reason TEXT,
    last_failed_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pool_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_pool_status_cooldown
    ON phone_numbers(pool_id, status, cooldown_until);

-- updated_at maintenance trigger (reuses existing fn from schema.sql)
DROP TRIGGER IF EXISTS trg_phone_numbers_updated_at ON phone_numbers;
CREATE TRIGGER trg_phone_numbers_updated_at
    BEFORE UPDATE ON phone_numbers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed a default pool for Pusad if the bank exists. Operator must manually
-- INSERT phone_numbers rows afterwards (numbers + livekit_trunk_id come from
-- the Viva SIP trunk setup; see Desktop/livekit/.../sip_scripts/create_trunks.py).
DO $$
DECLARE
    v_bank_id UUID;
    v_pool_exists BOOLEAN;
BEGIN
    SELECT id INTO v_bank_id FROM banks WHERE code = 'PUSAD' LIMIT 1;
    IF v_bank_id IS NULL THEN
        RAISE NOTICE 'PUSAD bank not found, skipping default pool seed';
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM phone_pools WHERE bank_id = v_bank_id AND name = 'pusad-default'
    ) INTO v_pool_exists;

    IF NOT v_pool_exists THEN
        INSERT INTO phone_pools (bank_id, name, capacity)
        VALUES (v_bank_id, 'pusad-default', 5);
        RAISE NOTICE 'Created default pool pusad-default for PUSAD';
    END IF;
END $$;
