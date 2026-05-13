-- ============================================
-- M2 — Migration V6
-- _migrations tracker: lets the auto-runner skip applied files
-- ============================================
-- This is the FIRST migration the auto-runner expects to find.
-- Bootstrap order in backend/db_migrations.py:
--   1. Create _migrations table (raw SQL inside the runner)
--   2. Apply this file (which is idempotent — re-runs are safe)
--   3. Backfill rows for v2-v5 + base schema so they are never re-applied
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS _migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT
);

-- Backfill: mark all pre-v6 migrations as already applied so the runner skips them.
-- 'manual' checksum indicates these were applied via run.sh before the tracker existed.
INSERT INTO _migrations (filename, checksum) VALUES
    ('schema.sql',                          'manual'),
    ('migration_v2.sql',                    'manual'),
    ('migration_v3_address_split.sql',      'manual'),
    ('migration_agent_tables.sql',          'manual'),
    ('migration_v4_jsonb_call_analysis.sql','manual'),
    ('migration_v5_agent_type.sql',         'manual')
ON CONFLICT (filename) DO NOTHING;
