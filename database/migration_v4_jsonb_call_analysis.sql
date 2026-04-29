-- ============================================
-- Fix: agent_calls.call_analysis must be JSONB, not TEXT
-- migration_v2.sql created the column as TEXT.
-- migration_agent_tables.sql declares it JSONB but uses
-- CREATE TABLE IF NOT EXISTS, so the corrected type is a no-op
-- when the v2 table already exists. agent_routes.py queries
-- this column with the JSONB ->> operator and 500s otherwise.
-- ============================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_calls'
          AND column_name = 'call_analysis'
          AND data_type <> 'jsonb'
    ) THEN
        ALTER TABLE agent_calls
            ALTER COLUMN call_analysis TYPE JSONB
            USING NULLIF(call_analysis, '')::jsonb;
    END IF;
END$$;
