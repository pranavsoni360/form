-- ============================================
-- M2 — Migration V8
-- call_processing_jobs: async job queue for post-call work
-- ============================================
-- Why: today the analytics LLM runs synchronously inside a 2-min APScheduler
-- cron tick. A slow Gemini call blocks the cron thread and starves subsequent
-- work. The job queue moves transcript_analyze, whatsapp_send_retry, and
-- recording_verify/recording_archive_b2 off the cron and onto N workers that
-- claim rows via FOR UPDATE SKIP LOCKED (multi-worker safe).
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS call_processing_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type        TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','done','failed','dead')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    locked_by       TEXT,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: workers poll for pending/failed jobs whose scheduled_at has passed.
-- Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_jobs_pending_scheduled
    ON call_processing_jobs (scheduled_at)
    WHERE status IN ('pending','failed');

-- Useful for ops dashboards filtering "show me all transcript_analyze jobs that died"
CREATE INDEX IF NOT EXISTS idx_jobs_type_status
    ON call_processing_jobs (job_type, status);

-- Recovery index: find rows orphaned because a worker crashed mid-run.
-- A startup task in JobWorkerPool re-queues these.
CREATE INDEX IF NOT EXISTS idx_jobs_running_locked
    ON call_processing_jobs (locked_at)
    WHERE status = 'running';

-- updated_at maintenance
DROP TRIGGER IF EXISTS trg_call_jobs_updated_at ON call_processing_jobs;
CREATE TRIGGER trg_call_jobs_updated_at
    BEFORE UPDATE ON call_processing_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
