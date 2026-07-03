"""LRS reconciliation runner (cron safety-net).

The durable job queue already retries individual jobs; this loop catches
applications whose scoring was never enqueued or got stuck, and re-queues them.
Mirrors backend/guarantor/runner.py. Registered in agent/batch.py.
"""
import logging

from lrs.trigger import enqueue_lrs_scoring

logger = logging.getLogger("lrs-runner")

_STUCK_MINUTES = 15
_RETRY_MINUTES = 10
_BATCH_LIMIT = 50


async def process_lrs_run(db_pool=None) -> None:
    """Reclaim stuck rows and re-enqueue pending/failed scoring jobs.

    db_pool defaults to agent.state.db_pool so the scheduler can call it
    arg-less (like the guarantor runner); tests pass an explicit pool.
    """
    if db_pool is None:
        from agent import state as _state
        db_pool = _state.db_pool
    # Reclaim rows stuck 'fetching' (worker likely died mid-run).
    await db_pool.execute(
        f"""UPDATE lrs_scores SET status='pending', updated_at=NOW()
             WHERE status='fetching'
               AND updated_at < NOW() - INTERVAL '{_STUCK_MINUTES} minutes'"""
    )

    rows = await db_pool.fetch(
        f"""SELECT application_id FROM lrs_scores
             WHERE status IN ('pending', 'failed')
               AND updated_at < NOW() - INTERVAL '{_RETRY_MINUTES} minutes'
             ORDER BY updated_at
             LIMIT {_BATCH_LIMIT}"""
    )
    if not rows:
        return

    logger.info("LRS runner re-enqueuing %d application(s)", len(rows))
    for row in rows:
        try:
            await enqueue_lrs_scoring(db_pool, row["application_id"])
        except Exception as e:
            logger.warning("LRS runner enqueue failed app=%s: %s", row["application_id"], e)
