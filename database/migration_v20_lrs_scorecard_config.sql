-- migration_v20_lrs_scorecard_config.sql
-- Bank-configurable scorecard: single-row config table (JSONB).
-- The application seeds this from scorecard.json on first startup.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS lrs_scorecard_config (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    config      JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT  single_row CHECK (id = 1)
);
