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
