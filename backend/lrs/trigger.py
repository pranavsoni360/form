"""Enqueue LRS scoring when a loan form is submitted.

Best-effort + additive: any failure here MUST NOT break form submission
(mirrors backend/guarantor/trigger.py).
"""
import logging

logger = logging.getLogger("lrs-trigger")


async def enqueue_lrs_scoring(db_pool, application_id) -> None:
    """Enqueue an `lrs_score` job for the application. Non-blocking / best-effort.

    Called from the form-submit endpoints right after the guarantor enqueue.
    Idempotent: seeds a `pending` lrs_scores row (ON CONFLICT DO NOTHING) and
    enqueues the job; the handler skips if already scored.
    """
    app = await db_pool.fetchrow(
        "SELECT id, loan_amount_requested, monthly_gross_income, pan_number "
        "FROM loan_applications WHERE id = $1",
        application_id,
    )
    if not app:
        return

    # Need at least an income or a PAN to score meaningfully.
    if not app["monthly_gross_income"] and not app["pan_number"]:
        logger.info("LRS enqueue skipped (no income or PAN) app=%s", application_id)
        return

    await db_pool.execute(
        """INSERT INTO lrs_scores (application_id, status, created_at, updated_at)
           VALUES ($1, 'pending', NOW(), NOW())
           ON CONFLICT (application_id) DO NOTHING""",
        application_id,
    )

    try:
        from services.job_worker import enqueue_job
        job_id = await enqueue_job(
            db_pool,
            job_type="lrs_score",
            payload={"application_id": str(application_id)},
            max_attempts=3,
        )
        logger.info("LRS scoring enqueued app=%s job=%s", application_id, job_id)
    except Exception as e:
        # Job queue unavailable — the runner reconciliation loop will pick it up.
        logger.warning("LRS enqueue_job failed (runner will retry): %s", e)
