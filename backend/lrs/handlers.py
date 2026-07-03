"""LRS job handler + persistence.

`lrs_score` is registered in services.job_handlers.HANDLERS. It fetches the
application, runs the scoring pipeline, and persists the result to lrs_scores +
mirrors a headline score/suggestion onto loan_applications for the portal.
"""
import json
import logging
import uuid

from lrs import service

logger = logging.getLogger("lrs-handler")


async def lrs_score(payload: dict, db_pool) -> None:
    """Job handler for job_type='lrs_score'.

    On success returns (worker marks 'done'). On transient failure raises
    (worker retries w/ backoff). Idempotent: skips if already scored.
    """
    application_id = uuid.UUID(str(payload["application_id"]))
    await run_and_persist(db_pool, application_id)


async def run_and_persist(db_pool, application_id, *, force: bool = False) -> dict | None:
    """Score one application and persist. Returns the result dict (or None if skipped)."""
    existing = await db_pool.fetchrow(
        "SELECT status FROM lrs_scores WHERE application_id = $1", application_id
    )
    if existing and existing["status"] == "scored" and not force:
        logger.info("LRS already scored app=%s (skip)", application_id)
        return None

    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1", application_id
    )
    if not app_row:
        logger.warning("LRS: application not found app=%s", application_id)
        return None
    app = dict(app_row)

    # Mark in-flight (create the row if the trigger didn't).
    await db_pool.execute(
        """INSERT INTO lrs_scores (application_id, status, created_at, updated_at)
           VALUES ($1, 'fetching', NOW(), NOW())
           ON CONFLICT (application_id)
           DO UPDATE SET status = 'fetching', updated_at = NOW()""",
        application_id,
    )

    try:
        result = await service.score_application(app)
    except Exception as e:
        await db_pool.execute(
            "UPDATE lrs_scores SET status='failed', error=$2, updated_at=NOW() "
            "WHERE application_id=$1",
            application_id, f"{type(e).__name__}: {e}"[:2000],
        )
        logger.exception("LRS scoring failed app=%s", application_id)
        raise  # let the job worker retry

    await _persist(db_pool, application_id, result)
    logger.info(
        "LRS scored app=%s total=%s decision=%s incomplete=%s",
        application_id, result["total_score"], result["decision"], result["incomplete"],
    )
    return result


async def _persist(db_pool, application_id, r: dict) -> None:
    async with db_pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """UPDATE lrs_scores SET
                     status='scored', total_score=$2, decision=$3, rating=$4,
                     recommended_amount=$5, recommended_tenure_m=$6, recommended_emi=$7,
                     interest_rate=$8, pillar_scores=$9::jsonb, effective_weights=$10::jsonb,
                     missing_pillars=$11, incomplete=$12, raw_provider_data=$13::jsonb,
                     config_version=$14, error=NULL, scored_at=NOW(), updated_at=NOW()
                   WHERE application_id=$1""",
                application_id,
                r["total_score"], r["decision"], r["rating"],
                r["recommended_amount"], r["recommended_tenure_m"], r["recommended_emi"],
                r["interest_rate"], json.dumps(r["pillar_scores"]),
                json.dumps(r["effective_weights"]), list(r["missing_pillars"]),
                r["incomplete"], json.dumps(r["raw_provider_data"]),
                r["config_version"],
            )
            # Mirror a headline onto loan_applications for the portal list/detail.
            await conn.execute(
                """UPDATE loan_applications
                     SET system_score=$2, system_suggestion=$3, system_reviewed_at=NOW()
                   WHERE id=$1""",
                application_id, r["total_score"], r["system_suggestion"],
            )
