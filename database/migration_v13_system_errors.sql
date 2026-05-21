-- ============================================
-- Migration V13 — system_errors (durable error log)
-- ============================================
-- Why: /ops/errors was backed by an in-memory ring buffer (event_bus). That
-- ring works great for live tailing — but every backend restart (deploys,
-- crashes, even `next build` clashes that bounce uvicorn) wipes it. The
-- operator sees an empty dashboard despite the system having had errors,
-- which destroys trust in the page.
--
-- Fix: persist every error to this table in the same call site as the
-- event_bus publish, so DB is the durable source of truth and the ring
-- is just the hot-path cache. /ops/errors will GET the recent N from
-- here on mount, then subscribe to SSE for live additions on top.
--
-- Retention: there's no built-in TTL trigger — operations adds a cron
-- (or pg_cron job) that deletes rows older than 30 days. For local dev
-- the table just grows; the LIMIT 500 on the read endpoint keeps the
-- page bounded. The idx_system_errors_ts_desc index makes BOTH the
-- read query AND the future prune cheap.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS system_errors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Same 7-source enum as /api/internal/errors VALID_SOURCES
    source          TEXT NOT NULL CHECK (source IN (
                        'backend', 'agent', 'livekit', 'sip',
                        'docker', 'postgres', 'frontend'
                    )),
    level           TEXT NOT NULL DEFAULT 'error' CHECK (level IN ('error', 'warning')),
    exc_type        TEXT NOT NULL,
    message         TEXT NOT NULL,
    correlation_id  TEXT,
    route           TEXT,
    method          TEXT,
    trace           TEXT,
    metadata        JSONB,
    -- The wall-clock timestamp from the publish call (Unix epoch seconds).
    -- We keep this separately from created_at because the publisher (e.g.
    -- a webhook from a GPU box) can stamp its own ts that differs from
    -- when we received the row. Both are useful: ts for ordering, created_at
    -- for "when did our DB see it".
    ts              DOUBLE PRECISION NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reads: "give me last 100 errors, newest first" — newest is highest ts.
CREATE INDEX IF NOT EXISTS idx_system_errors_ts_desc
    ON system_errors (ts DESC);

-- Filter by source for the /ops/errors source-pill filter.
CREATE INDEX IF NOT EXISTS idx_system_errors_source_ts
    ON system_errors (source, ts DESC);

-- Dedup helper — if the same (correlation_id, ts) somehow gets posted
-- twice (publisher retry, browser auto-capture race), the partial index
-- below prevents a duplicate row when correlation_id is set.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_system_errors_cid_ts
    ON system_errors (correlation_id, ts)
    WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE system_errors IS
    'Durable error log backing /ops/errors. Written from event_bus.publish("errors", ...) '
    'and from /api/internal/errors + /api/internal/frontend-error. Read by '
    'GET /api/ops/errors?limit=N on /ops/errors page mount. The in-memory '
    'ring buffer in lib/event_bus.py remains as the hot path for SSE replay '
    'within a live session; DB is the source of truth across restarts.';
