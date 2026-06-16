-- migration_v17_guarantor_consent.sql
-- Guarantor consent call system: isolated table + mirror columns on loan_applications.
-- Idempotent (IF NOT EXISTS) — safe to re-run.

CREATE TABLE IF NOT EXISTS guarantor_consent_calls (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL UNIQUE REFERENCES loan_applications(id) ON DELETE CASCADE,
    bank_id         UUID,
    bank_name       TEXT,
    guarantor_name  VARCHAR(255),
    guarantor_phone VARCHAR(20),
    borrower_name   VARCHAR(255),
    loan_amount     NUMERIC,
    language        VARCHAR(30) DEFAULT 'hindi',
    status          VARCHAR(30) DEFAULT 'pending',   -- pending|calling|completed|no_answer|failed
    consent         VARCHAR(10),                     -- yes|no|NULL
    consent_note    TEXT,
    room_name       VARCHAR(255),
    recording_url   TEXT,
    transcript      JSONB DEFAULT '[]'::jsonb,
    retry_count     INTEGER DEFAULT 0,
    scheduled_at    TIMESTAMPTZ DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gcc_status_scheduled
    ON guarantor_consent_calls (status, scheduled_at);

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS guarantor_consent     VARCHAR(10),
    ADD COLUMN IF NOT EXISTS guarantor_consent_at  TIMESTAMPTZ;
