"""
Async job queue worker pool.

Backed by the `call_processing_jobs` table (created in migration_v8). Multiple
workers can run concurrently — each claims its next job via `FOR UPDATE SKIP
LOCKED`, so two workers never grab the same row.

Design:
- N workers run as asyncio tasks under `JobWorkerPool.start()`.
- Each worker loops: claim → dispatch to handler → mark done OR retry with
  exponential backoff OR mark dead after max_attempts.
- At pool startup, orphaned `status='running'` rows whose `locked_at` is older
  than ORPHAN_TIMEOUT are re-queued (worker crashed mid-job).
- A separate asyncpg pool is recommended for jobs so a misbehaving handler
  cannot starve the API request pool.

Handlers register a callable per job_type. Handler signature:
    async def handler(payload: dict, db_pool: asyncpg.Pool) -> None
On success: return normally. On failure: raise. The worker handles the rest.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import uuid
from datetime import timedelta
from typing import Awaitable, Callable

import asyncpg


logger = logging.getLogger(__name__)

HandlerFn = Callable[[dict, asyncpg.Pool], Awaitable[None]]

# Re-queue jobs whose worker crashed mid-run after this many seconds.
ORPHAN_TIMEOUT_SECONDS = 600

# Max sleep when no jobs are available. Workers poll, but keep this short so a
# newly enqueued job is picked up quickly.
IDLE_POLL_INTERVAL_SECONDS = 2.0

# Cap on backoff seconds for failed jobs.
MAX_BACKOFF_SECONDS = 300


def _worker_id() -> str:
    """Unique identifier per worker. host:pid:uuid4 — short enough to read."""
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


class JobWorker:
    """A single worker that pulls jobs from the queue and dispatches to handlers."""

    def __init__(
        self,
        worker_id: str,
        db_pool: asyncpg.Pool,
        handlers: dict[str, HandlerFn],
        idle_interval: float = IDLE_POLL_INTERVAL_SECONDS,
    ) -> None:
        self.worker_id = worker_id
        self.db_pool = db_pool
        self.handlers = handlers
        self.idle_interval = idle_interval
        self._stop = asyncio.Event()

    def stop(self) -> None:
        """Signal the worker loop to exit after the current job (if any) finishes."""
        self._stop.set()

    async def run_forever(self) -> None:
        """Main worker loop. Returns when stop() is called and current job done."""
        logger.info("Job worker %s starting", self.worker_id)
        while not self._stop.is_set():
            try:
                got_job = await self._process_one()
            except asyncio.CancelledError:
                logger.info("Job worker %s cancelled", self.worker_id)
                raise
            except Exception:
                logger.exception("Worker %s top-level loop error", self.worker_id)
                got_job = False

            if not got_job:
                # No work; sleep but wake early if stop is signalled.
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.idle_interval)
                except asyncio.TimeoutError:
                    pass
        logger.info("Job worker %s exiting", self.worker_id)

    async def _process_one(self) -> bool:
        """Claim and process exactly one job. Returns True if a job was found."""
        async with self.db_pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """SELECT id, job_type, payload, attempts, max_attempts
                       FROM call_processing_jobs
                       WHERE status IN ('pending', 'failed')
                         AND scheduled_at <= NOW()
                       ORDER BY scheduled_at
                       FOR UPDATE SKIP LOCKED
                       LIMIT 1"""
                )
                if row is None:
                    return False

                job_id = row["id"]
                await conn.execute(
                    """UPDATE call_processing_jobs
                       SET status = 'running',
                           locked_at = NOW(),
                           locked_by = $2,
                           attempts = attempts + 1,
                           updated_at = NOW()
                       WHERE id = $1""",
                    job_id,
                    self.worker_id,
                )

        # Now process outside the transaction so the row isn't held locked
        # for the handler's duration. The row's status='running' prevents
        # other workers from claiming it.
        await self._dispatch(
            job_id=row["id"],
            job_type=row["job_type"],
            payload=_coerce_payload(row["payload"]),
            attempts=row["attempts"] + 1,
            max_attempts=row["max_attempts"],
        )
        return True

    async def _dispatch(
        self,
        job_id: uuid.UUID,
        job_type: str,
        payload: dict,
        attempts: int,
        max_attempts: int,
    ) -> None:
        handler = self.handlers.get(job_type)
        if handler is None:
            err = f"No handler registered for job_type={job_type!r}"
            logger.error("Job %s: %s", job_id, err)
            await self._mark_dead(job_id, err)
            return

        try:
            await handler(payload, self.db_pool)
        except NotImplementedError as e:
            # Handler exists but isn't wired yet (M5/M8 work). Mark dead so the
            # job doesn't loop forever burning retries.
            logger.warning("Job %s (%s) not implemented yet: %s", job_id, job_type, e)
            await self._mark_dead(job_id, f"not_implemented: {e}")
        except Exception as e:
            logger.exception("Job %s (%s) failed on attempt %d", job_id, job_type, attempts)
            await self._mark_failed_or_dead(job_id, attempts, max_attempts, str(e))
        else:
            await self._mark_done(job_id)
            logger.info("Job %s (%s) done", job_id, job_type)

    async def _mark_done(self, job_id: uuid.UUID) -> None:
        await self.db_pool.execute(
            "UPDATE call_processing_jobs SET status = 'done', updated_at = NOW() WHERE id = $1",
            job_id,
        )

    async def _mark_failed_or_dead(
        self,
        job_id: uuid.UUID,
        attempts: int,
        max_attempts: int,
        err: str,
    ) -> None:
        if attempts >= max_attempts:
            await self._mark_dead(job_id, err)
            return
        # Exponential backoff: 2, 4, 8, 16, 32, ... capped at MAX_BACKOFF_SECONDS
        backoff = min(MAX_BACKOFF_SECONDS, 2 ** attempts)
        await self.db_pool.execute(
            """UPDATE call_processing_jobs
               SET status = 'failed',
                   last_error = $2,
                   scheduled_at = NOW() + ($3 || ' seconds')::interval,
                   locked_at = NULL,
                   locked_by = NULL,
                   updated_at = NOW()
               WHERE id = $1""",
            job_id,
            err[:2000],  # truncate long stack traces
            str(backoff),
        )
        logger.info("Job %s requeued with %ds backoff (attempt %d/%d)",
                    job_id, backoff, attempts, max_attempts)

    async def _mark_dead(self, job_id: uuid.UUID, err: str) -> None:
        await self.db_pool.execute(
            """UPDATE call_processing_jobs
               SET status = 'dead',
                   last_error = $2,
                   updated_at = NOW()
               WHERE id = $1""",
            job_id,
            err[:2000],
        )
        logger.error("Job %s marked DEAD: %s", job_id, err)


def _coerce_payload(payload) -> dict:
    """asyncpg returns JSONB as a str unless type codec is registered. Be
    defensive — accept dict (codec registered) OR str (not registered)."""
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            return {}
    return {}


class JobWorkerPool:
    """Manages N JobWorker tasks. Single instance per uvicorn worker."""

    def __init__(
        self,
        db_pool: asyncpg.Pool,
        handlers: dict[str, HandlerFn],
        n_workers: int = 4,
    ) -> None:
        self.db_pool = db_pool
        self.handlers = handlers
        self.n_workers = n_workers
        self._workers: list[JobWorker] = []
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        """Recover orphaned jobs, then launch worker tasks."""
        await self._recover_orphans()
        for i in range(self.n_workers):
            w = JobWorker(
                worker_id=_worker_id() + f":w{i}",
                db_pool=self.db_pool,
                handlers=self.handlers,
            )
            self._workers.append(w)
            self._tasks.append(asyncio.create_task(w.run_forever(), name=f"jobworker-{i}"))
        logger.info("JobWorkerPool started with %d worker(s)", self.n_workers)

    async def stop(self) -> None:
        """Signal workers to exit; wait briefly then cancel any stragglers."""
        for w in self._workers:
            w.stop()
        if not self._tasks:
            return
        # Give workers up to 5s to finish their current job gracefully
        try:
            await asyncio.wait_for(
                asyncio.gather(*self._tasks, return_exceptions=True),
                timeout=5.0,
            )
        except asyncio.TimeoutError:
            logger.warning("Some job workers did not stop within 5s; cancelling")
            for t in self._tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*self._tasks, return_exceptions=True)
        logger.info("JobWorkerPool stopped")

    async def _recover_orphans(self) -> None:
        """Re-queue rows that a crashed worker left in `running` state."""
        result = await self.db_pool.execute(
            """UPDATE call_processing_jobs
               SET status = 'failed',
                   last_error = COALESCE(last_error, '') || ' | orphan recovery (worker crashed)',
                   locked_at = NULL,
                   locked_by = NULL,
                   scheduled_at = NOW(),
                   updated_at = NOW()
               WHERE status = 'running'
                 AND locked_at < NOW() - ($1 || ' seconds')::interval""",
            str(ORPHAN_TIMEOUT_SECONDS),
        )
        # asyncpg execute returns a string like "UPDATE 3"
        count = int(result.split()[-1]) if result and result.startswith("UPDATE") else 0
        if count:
            logger.warning("Recovered %d orphaned job(s) on startup", count)


async def enqueue_job(
    db_pool: asyncpg.Pool,
    job_type: str,
    payload: dict,
    max_attempts: int = 5,
    scheduled_at_delta_seconds: float = 0,
) -> uuid.UUID:
    """Insert a new job into the queue. Returns the new job id.

    Callers (analytics cron, transcript webhook, etc.) use this to schedule
    work. Idempotency must be implemented inside each handler.
    """
    job_id = await db_pool.fetchval(
        """INSERT INTO call_processing_jobs (job_type, payload, max_attempts, scheduled_at)
           VALUES ($1, $2::jsonb, $3, NOW() + ($4 || ' seconds')::interval)
           RETURNING id""",
        job_type,
        json.dumps(payload),
        max_attempts,
        str(scheduled_at_delta_seconds),
    )
    return job_id
