"""
Operations endpoints: /healthz, /readyz, /version.

/healthz — liveness probe. Returns 200 unconditionally if the process is
           up enough to serve HTTP. Used by k8s liveness probes / Docker
           healthcheck. MUST NOT do DB or network checks (those belong in
           /readyz) — if /healthz fails, the orchestrator restarts the
           process, which is destructive.

/readyz  — readiness probe. Returns 200 only if the backend can actually
           serve requests: DB pool acquires within 2s, all circuit breakers
           are CLOSED, job worker pool is alive. Returns 503 with a per-
           component breakdown so ops can see WHAT is unhealthy without
           opening the logs.

/version — build info. Reports the git commit (set via VERSION env at deploy
           time) and basic environment metadata. Useful for "is this the
           version I just deployed?" during rollouts.

No authentication on any of these. They are routinely hit by orchestrators
that don't carry tokens.
"""

from __future__ import annotations

import asyncio
import os
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


router = APIRouter(tags=["ops"])

# Process start time, used to report uptime.
_PROCESS_STARTED = time.monotonic()


@router.get("/healthz")
async def healthz():
    """Liveness probe — process is alive enough to serve HTTP."""
    return {"status": "ok"}


@router.get("/readyz")
async def readyz(request: Request):
    """Readiness probe — every dependency the app NEEDS is reachable.

    Returns 200 with {component: "ok"} for each healthy dependency.
    Returns 503 if any check fails, with per-component status.
    """
    checks: dict[str, str] = {}
    overall_ok = True

    # ─── DB pool: acquire a conn + SELECT 1 within 2s ────────────────────
    db_pool = getattr(request.app.state, "db_pool", None) or _module_db_pool()
    if db_pool is None:
        checks["db"] = "uninitialized"
        overall_ok = False
    else:
        try:
            async with asyncio.timeout(2.0):
                async with db_pool.acquire() as conn:
                    one = await conn.fetchval("SELECT 1")
                    if one == 1:
                        checks["db"] = "ok"
                    else:
                        checks["db"] = "unexpected_result"
                        overall_ok = False
        except asyncio.TimeoutError:
            checks["db"] = "timeout"
            overall_ok = False
        except Exception as e:
            checks["db"] = f"error: {type(e).__name__}"
            overall_ok = False

    # ─── Circuit breakers: any not-CLOSED is a degraded signal ───────────
    try:
        from lib.circuit_breaker import all_breakers
        breakers = all_breakers()
        if breakers:
            unhealthy = {n: s for n, s in breakers.items() if s != "closed"}
            if unhealthy:
                checks["circuits"] = f"open: {','.join(sorted(unhealthy))}"
                overall_ok = False
            else:
                checks["circuits"] = "ok"
        else:
            checks["circuits"] = "none_registered"
    except Exception as e:
        checks["circuits"] = f"error: {type(e).__name__}"
        # Don't fail readiness just because the inspection helper broke.

    # ─── Job worker pool: must have workers alive ────────────────────────
    job_pool = getattr(request.app.state, "job_worker_pool", None) or _module_job_pool()
    if job_pool is None:
        checks["job_workers"] = "uninitialized"
        # Not fatal — backend can still serve API without the queue running.
    else:
        try:
            active = sum(1 for t in job_pool._tasks if not t.done())
            checks["job_workers"] = f"alive={active}/{job_pool.n_workers}"
            if active == 0 and job_pool.n_workers > 0:
                overall_ok = False
        except Exception as e:
            checks["job_workers"] = f"error: {type(e).__name__}"

    body = {
        "status": "ok" if overall_ok else "degraded",
        "checks": checks,
        "uptime_seconds": int(time.monotonic() - _PROCESS_STARTED),
    }
    status_code = 200 if overall_ok else 503
    return JSONResponse(status_code=status_code, content=body)


@router.get("/version")
async def version():
    """Build info. VERSION env should be set by the deploy script to the
    short git SHA. Falls back to 'dev' for local runs."""
    return {
        "version": os.getenv("VERSION", "dev"),
        "env": os.getenv("LOS_ENV", "development"),
        "uptime_seconds": int(time.monotonic() - _PROCESS_STARTED),
    }


# ── /api/ops/phone-pools ────────────────────────────────────────────────────
# Initial-state seed for /ops/phones. SSE "phones" topic merges deltas on top
# of this snapshot. Returns one row per phone_number joined to its pool, so
# the UI can render a flat table sortable by utilization / cooldown / total.
#
# This router is mounted WITHOUT a shared prefix (the probe endpoints live at
# the root for k8s convention), so api-style routes spell their full path
# in the decorator.

@router.get("/api/ops/phone-pools")
async def phone_pools():
    """Snapshot of every phone pool + its numbers (live counters from DB).

    Response shape:
        {
          "pools": [
            {
              "id": "...",  "name": "pusad-default",
              "capacity": 5, "cooldown_seconds_min": 180, "cooldown_seconds_max": 300,
              "bank_id": "...",
              "numbers": [
                {
                  "id": "...",
                  "phone_number": "+91...",
                  "active_calls": 0, "total_calls": 142,
                  "cooldown_until": "2026-05-20T..." | null,
                  "status": "active" | "disabled" | "quarantined",
                  "updated_at": "..."
                }
              ]
            }
          ]
        }
    """
    from fastapi.responses import JSONResponse
    pool = _module_db_pool()
    if pool is None:
        return JSONResponse({"pools": [], "error": "db pool not ready"}, status_code=503)

    try:
        # One round-trip: pools + their numbers, ordered for deterministic UI
        rows = await pool.fetch(
            """SELECT
                 pp.id AS pool_id, pp.name AS pool_name, pp.bank_id, pp.capacity,
                 pp.cooldown_seconds_min, pp.cooldown_seconds_max,
                 pn.id AS pn_id, pn.phone_number, pn.active_calls, pn.total_calls,
                 pn.cooldown_until, pn.status, pn.updated_at
               FROM phone_pools pp
               LEFT JOIN phone_numbers pn ON pn.pool_id = pp.id
               ORDER BY pp.name ASC, pn.phone_number ASC NULLS LAST"""
        )
    except Exception as e:
        return JSONResponse(
            {"pools": [], "error": f"{type(e).__name__}: {e}"},
            status_code=503,
        )

    by_pool: dict[str, dict] = {}
    for r in rows:
        pid = str(r["pool_id"])
        if pid not in by_pool:
            by_pool[pid] = {
                "id": pid,
                "name": r["pool_name"],
                "bank_id": str(r["bank_id"]) if r["bank_id"] else None,
                "capacity": int(r["capacity"]) if r["capacity"] is not None else 5,
                "cooldown_seconds_min": int(r["cooldown_seconds_min"] or 0),
                "cooldown_seconds_max": int(r["cooldown_seconds_max"] or 0),
                "numbers": [],
            }
        if r["pn_id"] is not None:
            by_pool[pid]["numbers"].append({
                "id": str(r["pn_id"]),
                "phone_number": r["phone_number"],
                "active_calls": int(r["active_calls"] or 0),
                "total_calls": int(r["total_calls"] or 0),
                "cooldown_until": r["cooldown_until"].isoformat() if r["cooldown_until"] else None,
                "status": r["status"],
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            })

    return {"pools": list(by_pool.values())}


# ── /api/ops/errors ─────────────────────────────────────────────────────────
# Durable history for /ops/errors. The page mounts → GET this for the recent
# history → then subscribes to SSE for live additions on top. Reducer dedups
# on (correlation_id, ts) so the two paths overlap safely.
#
# This is the FIX for "ring buffer wiped on every backend restart" — DB is
# now the source of truth. Ring buffer remains as the within-session hot
# path for SSE replay.
#
# No auth: matches the rest of /api/ops/* (operator visibility).

@router.get("/api/ops/errors")
async def list_recent_errors(
    limit: int = 100,
    source: str | None = None,
    since_ts: float | None = None,
):
    """Return recent errors from system_errors, newest first.

    Args:
        limit: max rows (default 100, capped at 500).
        source: optional filter (agent / livekit / sip / docker / postgres / backend / frontend).
        since_ts: Unix epoch float — only rows with ts > this. Useful for
                  pagination ("load older" by passing the oldest seen ts).
    """
    pool = _module_db_pool()
    if pool is None:
        return {"errors": [], "note": "db pool not ready"}

    # Clamp
    if limit < 1: limit = 1
    if limit > 500: limit = 500

    where: list[str] = []
    args: list = []
    if source:
        args.append(source); where.append(f"source = ${len(args)}")
    if since_ts is not None:
        args.append(since_ts); where.append(f"ts > ${len(args)}")
    args.append(limit)

    sql = (
        "SELECT id, source, level, exc_type, message, correlation_id, route, "
        "method, trace, metadata, ts, created_at "
        "FROM system_errors "
    )
    if where:
        sql += "WHERE " + " AND ".join(where) + " "
    sql += f"ORDER BY ts DESC LIMIT ${len(args)}"

    rows = await pool.fetch(sql, *args)
    return {
        "errors": [
            {
                "type": "error",  # shape match for the SSE reducer
                "id": str(r["id"]),
                "source": r["source"],
                "level": r["level"],
                "exc_type": r["exc_type"],
                "message": r["message"],
                "correlation_id": r["correlation_id"] or "-",
                "route": r["route"],
                "method": r["method"],
                "trace": r["trace"],
                "metadata": r["metadata"],
                "ts": float(r["ts"]),
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ],
    }


# ── POST /api/ops/errors/cleanup ────────────────────────────────────────────
# Manual trigger for the same DELETE the daily APScheduler job runs at 03:00
# IST. Useful when the operator wants to clear the table on-demand (e.g. after
# a noisy incident drowned out signal). Accepts ?days=N override; default is
# the same LOS_ERROR_RETENTION_DAYS env value as the scheduled job.
#
# No auth — matches the rest of /api/ops/* operator endpoints.

@router.post("/api/ops/errors/cleanup")
async def cleanup_errors(days: int | None = None):
    """Delete system_errors older than `days` (default = LOS_ERROR_RETENTION_DAYS env, fallback 1).

    Same DELETE the daily 03:00 IST scheduler job runs; this exposes it to
    operators for emergency / testing use without waiting for the cron tick.
    """
    pool = _module_db_pool()
    if pool is None:
        return JSONResponse({"error": "db pool not ready"}, status_code=503)

    if days is None:
        try:
            days = int(os.getenv("LOS_ERROR_RETENTION_DAYS", "1"))
        except ValueError:
            days = 1
    if days < 1:
        days = 1
    cutoff_ts = time.time() - days * 86400.0
    before = await pool.fetchval("SELECT COUNT(*) FROM system_errors")
    result = await pool.execute(
        "DELETE FROM system_errors WHERE ts < $1", cutoff_ts,
    )
    deleted = int(result.split()[-1]) if result else 0
    after = await pool.fetchval("SELECT COUNT(*) FROM system_errors")
    return {"deleted": deleted, "rows_before": before, "rows_after": after, "retention_days": days}


# ── Compatibility shims ─────────────────────────────────────────────────────
# main.py keeps its db_pool / job_worker_pool as module-level globals rather
# than on app.state. We try both paths so future refactors are smooth.

def _module_db_pool():
    try:
        import main as _main
        return getattr(_main, "db_pool", None)
    except Exception:
        return None


def _module_job_pool():
    try:
        import main as _main
        return getattr(_main, "job_worker_pool", None)
    except Exception:
        return None
