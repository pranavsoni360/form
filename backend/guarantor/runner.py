# backend/guarantor/runner.py
"""Cron-driven guarantor dispatch lane. Respects calling hours + emergency stop
(reused from agent.batch). Concurrency-capped so it can't starve customer calls
on the shared trunk pool.

Owns RETRY: before dispatching fresh pending rows, it promotes retryable
no_answer/failed rows back to pending with escalating backoff. retry_count is
incremented at claim time (in dispatch._claim) so it equals attempts made.
APScheduler default max_instances=1 prevents overlapping ticks; the atomic
claim in dispatch makes any residual overlap harmless.
"""
import os
import asyncio
import logging

from guarantor.dispatch import dispatch_guarantor_call

logger = logging.getLogger("guarantor-runner")

_CONCURRENCY = int(os.getenv("GUARANTOR_CONCURRENCY", "2"))
_MAX_ATTEMPTS = int(os.getenv("GUARANTOR_MAX_ATTEMPTS", "3"))


async def _promote_retryable(db_pool) -> None:
    """Re-queue no_answer/failed rows that still have attempts left, once their
    per-attempt backoff has elapsed. retry_count = attempts already made."""
    await db_pool.execute(
        """UPDATE guarantor_consent_calls
             SET status='pending', scheduled_at=NOW(), updated_at=NOW()
           WHERE status IN ('no_answer','failed')
             AND retry_count < $1
             AND ended_at IS NOT NULL
             AND ended_at <= NOW() - (CASE retry_count
                    WHEN 1 THEN INTERVAL '5 minutes'
                    WHEN 2 THEN INTERVAL '15 minutes'
                    ELSE INTERVAL '30 minutes' END)""",
        _MAX_ATTEMPTS,
    )


async def _reclaim_stuck(db_pool) -> None:
    """Recover rows wedged in 'calling' (backend restart / worker down). The
    dispatch wait caps at ~370s, so 10 min is safely past any live call."""
    await db_pool.execute(
        """UPDATE guarantor_consent_calls
             SET status='failed', ended_at=NOW(), updated_at=NOW()
           WHERE status='calling' AND started_at < NOW() - INTERVAL '10 minutes'"""
    )


async def _mark_exhausted_unreached(db_pool) -> None:
    """Once all attempts are spent without consent, reflect a terminal
    'no_answer' on the application so the UI stops showing 'pending' forever."""
    await db_pool.execute(
        """UPDATE loan_applications la
             SET guarantor_consent='no_answer', guarantor_consent_at=NOW()
           FROM guarantor_consent_calls g
           WHERE g.application_id = la.id
             AND g.status IN ('no_answer','failed')
             AND g.retry_count >= $1
             AND la.guarantor_consent = 'pending'""",
        _MAX_ATTEMPTS,
    )


async def process_guarantor_run() -> None:
    from agent import state as _state
    from agent.state import is_within_calling_hours, is_emergency_stop_active

    if not is_within_calling_hours():
        return
    try:
        stop = is_emergency_stop_active()
        if asyncio.iscoroutine(stop):
            stop = await stop
    except Exception:
        # Fail closed: the swallow used to fall through and keep dialing during
        # a declared emergency stop. Skip this tick instead.
        logger.warning("guarantor runner: emergency-stop check failed; skipping tick",
                       exc_info=True)
        return
    if stop:
        return

    await _reclaim_stuck(_state.db_pool)
    await _promote_retryable(_state.db_pool)
    await _mark_exhausted_unreached(_state.db_pool)

    # Exclude banks that have stopped their own calling. The tick above already
    # honours the platform switch; this is the per-bank one. LEFT JOIN so a row
    # with no bank_id behaves exactly as before.
    rows = await _state.db_pool.fetch(
        """SELECT g.* FROM guarantor_consent_calls g
        LEFT JOIN banks bk ON bk.id = g.bank_id
             WHERE g.status='pending' AND g.scheduled_at <= NOW()
               AND NOT COALESCE(bk.calling_emergency_stopped, false)
             ORDER BY g.scheduled_at ASC
             LIMIT $1""",
        _CONCURRENCY,
    )
    if not rows:
        return

    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _one(r):
        async with sem:
            await dispatch_guarantor_call(_state.db_pool, dict(r))

    await asyncio.gather(*[_one(r) for r in rows], return_exceptions=True)
    logger.info("Guarantor run dispatched %d call(s)", len(rows))
