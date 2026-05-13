-- ============================================
-- M2 — Migration V9
-- agent_call_metrics table + composite/GIN indexes for production-scale queries
-- ============================================
-- Why: at 5000 calls/day, dashboard queries on bank_id + status + created_at
-- without composite indexes become sequential scans. JSONB queries on
-- transcript / collected_data / call_analysis without GIN indexes are even
-- worse. agent_call_metrics gives us a normalized place to store latency
-- percentiles, turn counts, VAD events, and SIP error codes per call.
--
-- Safe to re-run.
-- Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction, so the
-- migration runner applies this file with autocommit (one statement at a time).

-- Per-call metrics inserted by the agent when the call ends.
-- One row per call. Used by /ops/live latency sparklines and /ops/errors.
CREATE TABLE IF NOT EXISTS agent_call_metrics (
    call_id                 UUID PRIMARY KEY REFERENCES agent_calls(id) ON DELETE CASCADE,
    response_latency_ms     INTEGER,    -- end-to-end (user stops talking → agent first audio out)
    asr_latency_ms          INTEGER,    -- Deepgram final transcript latency
    llm_latency_ms          INTEGER,    -- Gemini/Groq response latency
    tts_latency_ms          INTEGER,    -- Sarvam first-byte audio latency
    turn_count              INTEGER,    -- number of user↔agent exchanges
    interruption_count      INTEGER,    -- times user interrupted agent
    sip_error_code          INTEGER,    -- 482/486/503/etc. if call failed at SIP layer
    recording_uploaded_at   TIMESTAMPTZ -- set by recording_archive_b2 job
);

CREATE INDEX IF NOT EXISTS idx_agent_call_metrics_uploaded
    ON agent_call_metrics (recording_uploaded_at);

-- Composite indexes for dashboard queries. CONCURRENTLY avoids locking
-- agent_calls/loan_applications while the index is built on a live table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_calls_bank_status_created
    ON agent_calls (bank_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loan_apps_bank_status_created
    ON loan_applications (bank_id, status, created_at DESC);

-- GIN indexes on hot JSONB columns. These take longer to build than B-tree but
-- transform `WHERE collected_data @> '{...}'` from seq-scan to index-scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gin_agent_calls_transcript
    ON agent_calls USING gin (transcript);

CREATE INDEX CONCURRENTLY IF NOT EXISTS gin_agent_calls_collected_data
    ON agent_calls USING gin (collected_data);

-- Note: call_analysis was migrated from TEXT to JSONB in migration_v4. The GIN
-- index below assumes JSONB. If your DB still has TEXT (shouldn't, but just in
-- case), the CREATE will fail loudly — re-run migration_v4 first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gin_agent_calls_call_analysis
    ON agent_calls USING gin (call_analysis);

-- loan_applications.field_sources tracks which API/source filled each field.
-- field_sources column exists from migration_v3_address_split.
-- Check column type before creating index; field_sources was added as JSONB.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gin_loan_apps_field_sources
    ON loan_applications USING gin (field_sources);
