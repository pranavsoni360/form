# backend/agent/batch.py
import os
import io
import secrets
import time
import asyncio
import logging
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pandas as pd
import csv
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query, BackgroundTasks, Depends
from fastapi.responses import StreamingResponse
from livekit import api
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.events import EVENT_JOB_ERROR

from . import state as _state
from .state import (
    get_current_bank_user, _bank_uuid,
    now_ist, now_ist_str, is_within_calling_hours,
    acquire_batch_lock, release_batch_lock, is_emergency_stop_active,
    set_emergency_stop, cleanup_stuck_calls, _init_system_state,
    _row_to_dict, _rows_to_list, _serialize_call,
    LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
    SIP_TRUNK_ID, AGENT_NAME, UNION_BANK_AGENT_NAME, DEMO_MODE, CALL_START_HOUR, CALL_END_HOUR,
    MAX_RETRIES, IST,
)
from .analytics import process_analytics_batch

logger = logging.getLogger("agent-batch")
router = APIRouter()


def _ist_day_bounds(date_from: Optional[str], date_to: Optional[str]):
    """Resolve an inclusive [date_from, date_to] day range into (lo, hi)
    IST-midnight datetimes for a half-open [lo, hi) SQL window (hi = date_to + 1
    day). Unparseable values are ignored. Mirrors calls._date_range_bounds so
    the batch dashboards use the same IST day definition as Call Logs."""
    def _p(d):
        if not d:
            return None
        try:
            return IST.localize(datetime.strptime(d, "%Y-%m-%d"))
        except ValueError:
            return None
    lo = _p(date_from)
    hi_day = _p(date_to)
    hi = (hi_day + timedelta(days=1)) if hi_day is not None else None
    return lo, hi

_scheduler: AsyncIOScheduler = None


def _on_job_error(event):
    """apscheduler EVENT_JOB_ERROR -> /ops/errors (source=backend).

    Background cron jobs (batch runner, analytics, error cleanup) run OUTSIDE
    the HTTP request path, so the FastAPI global exception handler never sees
    their failures. This listener mirrors that handler's publish so every
    scheduled-job crash also surfaces on /ops/errors (and the status pill),
    not just in logs/GlitchTip.
    """
    try:
        from lib.event_bus import event_bus
        exc = getattr(event, "exception", None)
        event_bus.publish("errors", {
            "type": "error",
            "source": "backend",
            "level": "error",
            "exc_type": type(exc).__name__ if exc else "ScheduledJobError",
            "message": f"scheduled job '{getattr(event, 'job_id', '?')}' failed: {str(exc)[:280]}",
            "metadata": {"job_id": getattr(event, "job_id", None)},
        })
    except Exception:
        pass  # never raise from the error-reporting path


async def agent_startup():
    """Call from main app's startup event (after set_db_pool)."""
    global _scheduler
    await _init_system_state()
    await release_batch_lock()
    await cleanup_stuck_calls()
    # Reconcile the phone-pool concurrency counter. phone_numbers.active_calls is
    # +1 on dial and -1 in the dispatcher's finally; a crash/restart mid-call leaks
    # it permanently and can wedge the pool (active_calls stays >= capacity → the
    # number is never selected again). cleanup_stuck_calls() just reset any stale
    # 'Calling' rows, so on this fresh process nothing is truly dialing — clear any
    # leaked counter back to 0.
    try:
        reset = await _state.db_pool.execute(
            "UPDATE phone_numbers SET active_calls = 0, updated_at = NOW() WHERE active_calls <> 0"
        )
        if reset and not str(reset).endswith(" 0"):
            logger.warning("Startup reconcile: cleared leaked phone_numbers.active_calls (%s)", reset)
    except Exception as _e:
        logger.warning("Startup active_calls reconcile failed: %s", _e)

    _scheduler = AsyncIOScheduler(timezone="Asia/Kolkata")

    # Batch runner every 5 minutes — only processes batches in "running" state.
    # Cron hour range is derived from CALL_START_HOUR / CALL_END_HOUR env so it
    # always matches is_within_calling_hours().
    _last_active_hour = (CALL_END_HOUR - 1) % 24  # cron's hour='X-Y' is inclusive
    _hour_expr = f"{CALL_START_HOUR}-{_last_active_hour}" if CALL_START_HOUR <= _last_active_hour else f"{CALL_START_HOUR}-23,0-{_last_active_hour}"
    _scheduler.add_job(
        _scheduled_batch_run,
        CronTrigger(hour=_hour_expr, minute="*/5", timezone="Asia/Kolkata"),
        id="batch_runner",
        replace_existing=True,
    )
    # Analytics every 2 minutes
    _scheduler.add_job(
        _scheduled_analytics,
        CronTrigger(minute="*/2", timezone="Asia/Kolkata"),
        id="analytics_runner",
        replace_existing=True,
    )
    from guarantor.runner import process_guarantor_run
    _scheduler.add_job(
        process_guarantor_run,
        CronTrigger(hour=_hour_expr, minute="*/3", timezone="Asia/Kolkata"),
        id="guarantor_runner",
        replace_existing=True,
    )
    from lrs.runner import process_lrs_run
    _scheduler.add_job(
        process_lrs_run,
        CronTrigger(minute="*/5", timezone="Asia/Kolkata"),
        id="lrs_runner",
        replace_existing=True,
    )
    # Daily system_errors cleanup — runs at 03:00 IST (low-traffic window).
    # Retention configurable via LOS_ERROR_RETENTION_DAYS env, default 1 day.
    # Bounded DELETE so the table never grows unbounded across deployments.
    _scheduler.add_job(
        _scheduled_error_cleanup,
        CronTrigger(hour=3, minute=0, timezone="Asia/Kolkata"),
        id="error_cleanup",
        replace_existing=True,
    )
    _scheduler.add_listener(_on_job_error, EVENT_JOB_ERROR)
    _scheduler.start()
    logger.info(f"Agent scheduler started (calls {CALL_START_HOUR}:00-{CALL_END_HOUR}:00 IST cron='{_hour_expr}', analytics every 2m, error_cleanup daily 03:00 IST, max_retries={MAX_RETRIES})")


async def agent_shutdown():
    """Call from main app's shutdown event."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)

    # M4-lite: signal any in-flight dispatchers to stop accepting new calls
    # from the queue. In-flight per-call tasks finish naturally (they may
    # still be awaiting wait_for_call_completion). On next backend startup,
    # cleanup_stuck_calls() resets anything left at 'Calling' for >10 min.
    try:
        from services.dispatcher import manager as dispatcher_mgr
        n = dispatcher_mgr.stop_all()
        if n:
            logger.info(f"Signaled {n} active dispatcher(s) to stop")
    except Exception:
        logger.exception("Error signaling dispatcher shutdown (non-fatal)")

    await release_batch_lock()
    logger.info("Agent scheduler stopped")


async def _scheduled_batch_run():
    await process_batch_run()


async def _scheduled_analytics():
    await process_analytics_batch()


async def _scheduled_error_cleanup():
    """Daily DELETE on system_errors older than LOS_ERROR_RETENTION_DAYS (default 1).

    The table is purely an audit feed for /ops/errors — Sentry is the long-term
    archive — so a short retention is fine. Configurable via env so a team
    that wants 7 days for forensic work can bump it without a code change.
    Logs the row count so the operator can see the job actually ran.
    """
    try:
        retention_days = int(os.getenv("LOS_ERROR_RETENTION_DAYS", "1"))
    except ValueError:
        retention_days = 1
    if retention_days < 1:
        retention_days = 1
    cutoff_ts = (datetime.now(timezone.utc) - timedelta(days=retention_days)).timestamp()
    try:
        result = await _state.db_pool.execute(
            "DELETE FROM system_errors WHERE ts < $1", cutoff_ts,
        )
        deleted = int(result.split()[-1]) if result else 0
        logger.info(
            "error_cleanup_done",
            extra={"deleted": deleted, "retention_days": retention_days},
        )
    except Exception:
        logger.exception("error_cleanup failed")


# ============================================================================
# BATCH PROCESSING (sequential, one call at a time)
# ============================================================================

async def wait_for_call_completion(call_id: str, room_name: str, timeout: int = 600):
    """Poll Postgres until the call reaches a terminal status (set by the
    transcript webhook) or we time out.

    Classification uses the room's participant history. The agent is dispatched
    into the room BEFORE the SIP leg, so a healthy call has >=1 participant almost
    immediately. Therefore:
      • a room that stays EMPTY (0 participants) means nothing ever joined — the
        agent worker isn't running or the SIP call never connected → mark
        'Call Not Connected' and fail FAST (don't hang the dispatcher slot for
        10 min, which is what made batches 'falter').
      • if the agent was ever present, an incomplete call is a genuine
        'Not Answered'.
    """
    call_uuid = uuid.UUID(call_id)
    poll_interval = 3
    elapsed = 0
    max_participants = 0          # peak participants ever seen in the room
    empty_room_since = None       # elapsed secs when the room was first seen with 0 participants
    EMPTY_ROOM_GRACE = 60         # sustained-empty window that means "never connected"

    async def _finalize(status: str, error: str):
        await _state.db_pool.execute(
            """UPDATE agent_calls
               SET status = $1, ended_at = $2, updated_at = $2,
                   error_message = $3, retry_count = retry_count + 1
               WHERE id = $4""",
            status, now_ist(), error, call_uuid,
        )
        r = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
        return _row_to_dict(r)

    while elapsed < timeout:
        await asyncio.sleep(poll_interval)
        elapsed += poll_interval

        row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
        if not row:
            return None
        doc = _row_to_dict(row)
        if doc.get("status") != "Calling":
            return doc  # terminal status already written by the transcript webhook

        # Inspect the room from ~15s in, every ~9s.
        if elapsed >= 15 and elapsed % 9 == 0:
            try:
                lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
                rooms = await lk.room.list_rooms(api.ListRoomsRequest(names=[room_name]))
                await lk.aclose()
                if not rooms.rooms:
                    # Room gone — wait up to 60s for a late transcript, then classify
                    # by whether the agent was ever in the room.
                    logger.info(f"Room {room_name} gone. Waiting up to 60s for transcript...")
                    for _ in range(12):
                        await asyncio.sleep(5)
                        row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
                        if row and dict(row).get("status") != "Calling":
                            return _row_to_dict(row)
                    if max_participants >= 1:
                        return await _finalize("Not Answered", "Room ended, no transcript after 60s")
                    return await _finalize(
                        "Call Not Connected",
                        "Call never connected — agent/SIP never joined the room",
                    )
                else:
                    np = rooms.rooms[0].num_participants
                    max_participants = max(max_participants, np)
                    if np == 0:
                        if empty_room_since is None:
                            empty_room_since = elapsed
                        elif (elapsed - empty_room_since) >= EMPTY_ROOM_GRACE and max_participants == 0:
                            # Nothing ever joined for a full minute → not a real
                            # connection. Fail fast + classify so the operator sees
                            # the real reason (agent worker down / SIP failure).
                            logger.warning(
                                "Call %s: room empty %ds, no participant ever joined — "
                                "agent worker down or SIP not connecting.",
                                call_uuid, elapsed,
                            )
                            return await _finalize(
                                "Call Not Connected",
                                "No participant joined within 60s — agent worker not running or SIP did not connect",
                            )
                    else:
                        empty_room_since = None
            except Exception as e:
                # Transient LiveKit/DB error — keep polling; the global timeout is
                # the backstop. Never let a poll error end the call early.
                logger.warning(
                    "wait_for_call_completion poll iteration failed for %s: %s",
                    call_uuid, e,
                )

    # Global timeout — classify by whether the agent was ever present.
    if max_participants >= 1:
        return await _finalize("Not Answered", "Call timed out after %ds" % timeout)
    return await _finalize(
        "Call Not Connected",
        "Call timed out with no participant ever joining — agent worker / SIP issue",
    )


async def process_batch_run(batch_uuid_str: str = None):
    """Batch-based processing — only processes calls belonging to a batch in 'running' state.
    If batch_uuid_str is provided, process that specific batch.
    If None, find the oldest 'running' batch and process it.

    As of M4-lite, per-call placement is delegated to services.dispatcher.Dispatcher
    which runs N calls concurrently (env DISPATCHER_CONCURRENCY, default 5).
    The previous sequential `for call in pending` loop with 10s sleeps capped
    daily throughput around 100 calls; concurrent dispatch handles 500+/day.
    """
    call_batch_id = None
    batch_row = None
    batch_id = None

    if not await acquire_batch_lock():
        logger.warning("Batch already running")
        return
    if not is_within_calling_hours():
        logger.info("Outside calling hours")
        await release_batch_lock()
        return
    # Emergency stop leaves calls at 'Pending' (the dispatcher skips each one),
    # so a batch would look "running but nothing dials". Detect it up front and
    # log the reason once, instead of emitting a per-call skip for every number.
    if await is_emergency_stop_active():
        logger.warning(
            "Batch dispatch skipped — EMERGENCY STOP is active. Calls stay Pending "
            "until an operator clicks Resume (POST /resume-calling)."
        )
        await release_batch_lock()
        return

    try:
        # Find the batch to process. SELECT * picks up `preferred_phone_id`
        # (v14 column) automatically — we read it below before constructing
        # the Dispatcher.
        if batch_uuid_str:
            batch_row = await _state.db_pool.fetchrow(
                "SELECT * FROM agent_batches WHERE id = $1 AND status = 'running'",
                uuid.UUID(batch_uuid_str),
            )
        else:
            batch_row = await _state.db_pool.fetchrow(
                "SELECT * FROM agent_batches WHERE status = 'running' ORDER BY created_at ASC LIMIT 1"
            )

        if not batch_row:
            await release_batch_lock()
            return  # No running batches — nothing to do (silent, no log spam)

        batch = _row_to_dict(batch_row)
        batch_id = batch["id"]
        call_batch_id = batch.get("batch_id") or batch_id
        logger.info(f"Processing batch {batch_id} ({batch.get('filename', '?')})")

        # Per-bank calling window: a bank may narrow the global legal cap via its
        # bank_settings row. Load it once for this batch and hand the dispatcher a
        # bank-scoped hours check; falls back to the global cap when unset.
        bank_hours_fn = is_within_calling_hours
        try:
            batch_bank_id = batch.get("bank_id")
            if batch_bank_id:
                _bw = await _state.db_pool.fetchrow(
                    "SELECT calling_window_start, calling_window_end "
                    "FROM bank_settings WHERE bank_id = $1",
                    batch_bank_id if isinstance(batch_bank_id, uuid.UUID)
                    else uuid.UUID(str(batch_bank_id)),
                )
                if _bw and (_bw["calling_window_start"] or _bw["calling_window_end"]):
                    _bank_window = (_bw["calling_window_start"], _bw["calling_window_end"])
                    bank_hours_fn = lambda w=_bank_window: is_within_calling_hours(w)
                    logger.info(
                        "Batch %s using per-bank calling window %s (capped by global %s-%s)",
                        batch_id, _bank_window, CALL_START_HOUR, CALL_END_HOUR,
                    )
        except Exception as _e:
            logger.warning("Could not load per-bank calling window for batch %s: %s", batch_id, _e)

        # Prepaid guard: if this bank's wallet auto-paused (credit_ledger AFTER
        # trigger sets banks.calling_paused when the balance hits <= 0), do NOT dial.
        # No-op for banks not on billing (calling_paused defaults false, only the
        # trigger ever flips it). Top up credit to resume.
        try:
            _bbid = batch.get("bank_id")
            if _bbid:
                _paused = await _state.db_pool.fetchval(
                    "SELECT calling_paused FROM banks WHERE id = $1",
                    _bbid if isinstance(_bbid, uuid.UUID) else uuid.UUID(str(_bbid)),
                )
                if _paused:
                    logger.warning(
                        "Batch %s skipped — bank %s calling is PAUSED (prepaid balance depleted). "
                        "Top up credit to resume.", batch_id, _bbid,
                    )
                    await release_batch_lock()
                    return
        except Exception as _e:
            logger.warning("Could not check calling_paused for batch %s: %s", batch_id, _e)

        # ── M4-lite: delegate per-call placement to the concurrent dispatcher ──
        from services.dispatcher import Dispatcher, manager as dispatcher_mgr

        # If the operator picked a specific phone for this batch via the
        # /ops/batch dropdown, the column was set at upload / trigger time.
        # Pass it through so every dispatched call uses that one phone.
        preferred_phone_id = batch.get("preferred_phone_id")
        if preferred_phone_id:
            preferred_phone_id = str(preferred_phone_id)
            logger.info(
                "Batch %s using operator-selected phone_id=%s",
                batch_id, preferred_phone_id,
            )

        dispatcher = Dispatcher(
            batch_id_uuid=batch_id,
            call_batch_id=call_batch_id,
            db_pool=_state.db_pool,
            livekit_url=LIVEKIT_URL,
            livekit_api_key=LIVEKIT_API_KEY,
            livekit_api_secret=LIVEKIT_API_SECRET,
            sip_trunk_id_fallback=SIP_TRUNK_ID,
            agent_name_pusad=AGENT_NAME,
            agent_name_union=UNION_BANK_AGENT_NAME,
            demo_mode=DEMO_MODE,
            wait_for_call_completion=wait_for_call_completion,
            is_within_calling_hours_fn=bank_hours_fn,
            is_emergency_stop_active_fn=is_emergency_stop_active,
            now_ist_fn=now_ist,
            max_retries=MAX_RETRIES,
            preferred_phone_id=preferred_phone_id,
        )
        dispatcher_mgr.register(batch_id, dispatcher)
        try:
            counts = await dispatcher.run()
        finally:
            dispatcher_mgr.unregister(batch_id)

        completed = counts.get("completed", 0)
        successful = counts.get("successful", 0)
        failed = counts.get("failed", 0)

    finally:
        chain_next = False
        # Check if batch has any remaining pending calls
        if batch_row:
            remaining = await _state.db_pool.fetchval(
                """SELECT COUNT(*) FROM agent_calls
                   WHERE batch_id = $1
                     AND status IN ('Pending', 'Scheduled', 'Called - Callback Requested')""",
                call_batch_id,
            )
            if remaining == 0:
                # Only auto-complete a batch that is still 'running'. If the
                # operator stopped it mid-run (status='stopped'), leave that
                # terminal state intact instead of overwriting it with
                # 'completed'.
                await _state.db_pool.execute(
                    "UPDATE agent_batches SET status = 'completed' WHERE id = $1 AND status = 'running'",
                    uuid.UUID(batch_id),
                )
                logger.info(f"Batch {batch_id} fully completed")
            else:
                logger.info(f"Batch {batch_id} has {remaining} call(s) remaining — continuing immediately")

            # Auto-chain: kick off the next run right away instead of waiting up
            # to 5 min for the cron. This is what makes a freshly-uploaded batch
            # start promptly once the current one finishes — strict FIFO is kept
            # because process_batch_run() always picks the OLDEST 'running' batch,
            # so batch #2 only begins after batch #1 is fully completed (and thus
            # no longer 'running'). Chain only when there is DUE work across the
            # running batches — Pending, or Scheduled/callback calls whose time
            # has arrived (mirrors the dispatcher's own pending filter). Gating on
            # due work (not merely 'remaining') means a batch with only
            # future-scheduled calls does NOT spin the loop; the cron resumes it
            # when those calls come due. Also gated on calling hours + emergency
            # stop so it can never hot-loop outside those windows.
            if is_within_calling_hours() and not await is_emergency_stop_active():
                due_left = await _state.db_pool.fetchval(
                    """SELECT COUNT(*)
                         FROM agent_calls c
                         JOIN agent_batches b ON b.batch_id = c.batch_id
                        WHERE b.status = 'running'
                          AND (c.status = 'Pending'
                               OR (c.status IN ('Scheduled', 'Called - Callback Requested')
                                   AND (c.scheduled_callback_at IS NULL
                                        OR c.scheduled_callback_at <= NOW())))"""
                )
                chain_next = bool(due_left and due_left > 0)

        await release_batch_lock()
        try:
            logger.info(f"BATCH RUN DONE | Total: {completed} | OK: {successful} | Fail: {failed}")
        except UnboundLocalError:
            # No batch was processed (no batch_row); counts not defined
            pass

        # Fire the next run AFTER the lock is released so it can acquire cleanly.
        if chain_next:
            asyncio.create_task(process_batch_run())

# ============================================================================
# BATCH MANAGEMENT ENDPOINTS
# ============================================================================

def _normalize_phone(raw) -> tuple:
    """Return (canonical_dialing_phone, digit_count).

    canonical is the +91… form used both for dialing AND as the dedup key, so
    the same number written as 9876543210 / 919876543210 / 09876543210 collapses
    to one. digit_count is the raw number of digits (used for the ≥10 validity
    check). Lenient: a 10-digit national number (after stripping a leading 0 or
    91) canonicalises to +91<national>; anything else with ≥10 digits is kept
    as-is; <10 digits is left raw for display in the skipped report.
    """
    raw = str(raw or "").strip()
    if raw.endswith(".0"):  # Excel turns phone cells into floats: 9876543210.0
        raw = raw[:-2]
    digits = "".join(filter(str.isdigit, raw))
    national = digits
    if len(national) == 11 and national.startswith("0"):
        national = national[1:]
    elif len(national) == 12 and national.startswith("91"):
        national = national[2:]
    if len(national) == 10:
        canonical = f"+91{national}"
    elif len(digits) >= 10:
        canonical = f"+{digits}"
    else:
        canonical = raw
    return canonical, len(digits)


def _preprocess_records(records: list) -> tuple:
    """Clean a parsed CSV/Excel row list before any call is queued.

    Drops rows in this precedence: missing name → missing number → invalid
    number (fewer than 10 digits) → duplicate number (same canonical dialing
    form already seen). Returns (clean_records, report). Each clean record gets
    `_phone` (canonical) and `_name` (trimmed) attached for the insert loop.
    Row numbers in the report are 1-based including the header (so the first
    data row is 2), matching what the operator sees in Excel.
    """
    clean: list = []
    seen: dict = {}
    dropped = {"missing_name": [], "missing_number": [], "invalid_number": [], "duplicate": []}
    for idx, r in enumerate(records):
        row_no = idx + 2
        name = str(r.get("name", "") or "").strip()
        raw_phone = str(r.get("phone", "") or "").strip()
        if raw_phone.endswith(".0"):
            raw_phone = raw_phone[:-2]
        entry = {"row": row_no, "name": name, "phone": raw_phone}
        if not name:
            dropped["missing_name"].append(entry)
            continue
        if not raw_phone:
            dropped["missing_number"].append(entry)
            continue
        canonical, ndigits = _normalize_phone(raw_phone)
        if ndigits < 10:  # lenient rule: must have at least 10 digits
            dropped["invalid_number"].append(entry)
            continue
        if canonical in seen:
            dropped["duplicate"].append({**entry, "duplicate_of_row": seen[canonical]})
            continue
        seen[canonical] = row_no
        r["_phone"] = canonical
        r["_name"] = name
        clean.append(r)
    skipped = (
        [{**x, "reason": "duplicate"} for x in dropped["duplicate"]]
        + [{**x, "reason": "invalid_number"} for x in dropped["invalid_number"]]
        + [{**x, "reason": "missing_name"} for x in dropped["missing_name"]]
        + [{**x, "reason": "missing_number"} for x in dropped["missing_number"]]
    )
    report = {
        "total_rows": len(records),
        "valid": len(clean),
        "removed": {
            "duplicates": len(dropped["duplicate"]),
            "invalid_numbers": len(dropped["invalid_number"]),
            "missing_name": len(dropped["missing_name"]),
            "missing_number": len(dropped["missing_number"]),
        },
        "removed_total": sum(len(v) for v in dropped.values()),
        "skipped": skipped[:200],  # cap the list sent to the UI
    }
    return clean, report


@router.post("/upload-excel")
async def upload_excel(
    file: UploadFile = File(...),
    language: str = Query("hindi", description="Agent language"),
    gender: str = Query("male", description="Agent voice gender"),
    agent_type: str = Query("loan_enquiry", description="loan_enquiry | account_opening"),
    commit: bool = Query(
        False,
        description=(
            "When false (default) the file is parsed + preprocessed and a PREVIEW "
            "report is returned WITHOUT queuing any calls. When true, the cleaned "
            "rows are queued and calling starts. The frontend previews first, then "
            "re-sends the same file with commit=true on operator confirmation."
        ),
    ),
    phone_number_id: Optional[str] = Query(
        None,
        description=(
            "UUID of a phone_numbers row — when set, every call in this batch "
            "dials FROM that specific number (e.g. operator picked +17744930587 "
            "from the /ops/batch dropdown). When unset, dispatcher auto-picks "
            "least-loaded across the pool."
        ),
    ),
    bank_id: Optional[str] = Query(
        None,
        description="UUID of the bank to assign this batch to. When set, all calls and applications are visible to that bank's officers.",
    ),
    background_tasks: BackgroundTasks = None,
    user: dict = Depends(get_current_bank_user),
):
    """Upload Excel/CSV with customer data for batch calling."""
    # ── Bank assignment is MANDATORY ──────────────────────────────────────────
    # Every call must belong to a bank so it shows up in that bank's portals.
    # Previously an operator could upload with no bank and the rows landed
    # unattributed (the LEGACY/UNASSIGNED placeholder), invisible to every real
    # bank's dashboards. Rules:
    #   • Bank user (token carries a bank_id) → force THIS bank; a bank user can
    #     only upload for their own tenant, so any query override is ignored.
    #   • Operator (admin token, no bank_id) → MUST pass a bank_id (the /ops
    #     "Assign to bank" dropdown). Reject the upload otherwise.
    token_bank_id = user.get("bank_id")
    if token_bank_id:
        bank_id = str(token_bank_id)
    elif not bank_id:
        raise HTTPException(
            status_code=400,
            detail="Select a bank to assign this batch to before uploading.",
        )
    try:
        _bank_check_uuid = uuid.UUID(bank_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid bank_id.")
    if not await _state.db_pool.fetchval("SELECT 1 FROM banks WHERE id = $1", _bank_check_uuid):
        raise HTTPException(status_code=404, detail="Bank not found.")

    try:
        filename = file.filename.lower()
        if not (filename.endswith(".csv") or filename.endswith(".xlsx") or filename.endswith(".xls")):
            raise HTTPException(status_code=400, detail="Only CSV/Excel files allowed")

        contents = await file.read()
        if filename.endswith(".csv"):
            # Try UTF-8 first (Excel exports include a BOM). Many vendors
            # ship files in Windows-1252 / latin-1, so fall back to that.
            try:
                df = pd.read_csv(io.StringIO(contents.decode("utf-8-sig")), dtype=str)
            except Exception as utf_err:
                logger.warning(
                    "CSV decode failed as UTF-8 (%s); retrying as latin-1",
                    utf_err,
                )
                try:
                    df = pd.read_csv(io.StringIO(contents.decode("latin-1")), dtype=str)
                except Exception as latin_err:
                    # Both encodings failed — bubble up a clean 400 so the
                    # operator sees "fix your file encoding" instead of a
                    # cryptic pandas trace deep in the stack.
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Could not decode CSV — tried UTF-8 ({utf_err}) "
                            f"and latin-1 ({latin_err}). Re-export the file "
                            "as UTF-8 from Excel and try again."
                        ),
                    ) from latin_err
        else:
            df = pd.read_excel(io.BytesIO(contents), dtype=str)

        # Normalize column names
        column_map = {
            "Name": "name", "NAME": "name", "Customer_Name": "name", "customer_name": "name",
            "Mobile_number": "phone", "mobile_number": "phone", "Phone": "phone", "PHONE": "phone",
            "phone_number": "phone", "Mobile": "phone", "mobile": "phone",
            "Customer_type": "customer_type", "customer_type": "customer_type",
            "Email": "email", "EMAIL": "email",
            "Aadhar_number": "aadhar_number", "Pan_number": "pan_number",
            "Loan_type": "loan_type", "loan_type": "loan_type",
            "Loan_amount": "loan_amount", "loan_amount": "loan_amount",
        }
        df.rename(columns={k: v for k, v in column_map.items() if k in df.columns}, inplace=True)

        required = ["name", "phone"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            raise HTTPException(status_code=400, detail=f"Missing columns: {missing}. File has: {list(df.columns)}")

        records = df.fillna("").to_dict(orient="records")
        if not records:
            raise HTTPException(status_code=400, detail="File is empty")

        # ── Preprocess: dedupe, drop invalid (<10 digits) + rows missing
        # name/number. Nothing is written or dialed until the operator confirms.
        clean_records, report = _preprocess_records(records)

        if not commit:
            # Preview only — no batch row, no calls, no auto-start.
            return {
                "status": "preview",
                "preview": True,
                "filename": file.filename,
                **report,
                "message": (
                    f"{report['valid']} of {report['total_rows']} rows are ready to call; "
                    f"{report['removed_total']} will be skipped. Confirm to start."
                ),
            }

        if not clean_records:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No valid rows to call after preprocessing — all rows were "
                    "duplicates, invalid numbers, or missing a name/number."
                ),
            )

        # From here we only queue the cleaned rows.
        records = clean_records

        batch_id = f"batch_{secrets.token_hex(8)}_{int(time.time())}"
        upload_time = now_ist()
        bank_id_uuid = uuid.UUID(bank_id) if bank_id else None
        uploaded_by_uuid = None

        # Insert into agent_batches with batch_id string for linking to agent_calls.
        # `preferred_phone_id` is the operator's /ops/batch dropdown pick (v14 column).
        batch_uuid = uuid.uuid4()
        preferred_phone_uuid = None
        if phone_number_id:
            try:
                preferred_phone_uuid = uuid.UUID(phone_number_id)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail=f"phone_number_id is not a valid UUID: {phone_number_id}",
                )
            # Verify the row exists + is active — fail fast if operator picked
            # a stale id (e.g. the row was deleted between page load and submit).
            exists = await _state.db_pool.fetchval(
                "SELECT 1 FROM phone_numbers WHERE id = $1 AND status = 'active'",
                preferred_phone_uuid,
            )
            if not exists:
                raise HTTPException(
                    status_code=404,
                    detail=f"phone_number_id {phone_number_id} not found or not active",
                )

        await _state.db_pool.execute(
            """INSERT INTO agent_batches (id, batch_id, bank_id, filename, total_records, completed, failed, status, uploaded_by, created_at, agent_type, preferred_phone_id)
               VALUES ($1, $2, $3, $4, $5, 0, 0, 'pending', $6, $7, $8, $9)""",
            batch_uuid, batch_id, bank_id_uuid, file.filename, len(records), uploaded_by_uuid, upload_time, agent_type, preferred_phone_uuid,
        )

        count = 0
        for r in records:
            # Phone was already validated + canonicalised in preprocessing.
            phone = r.get("_phone") or str(r.get("phone", "")).strip()

            call_uuid = uuid.uuid4()
            room_name = f"los_{secrets.token_hex(6)}_{int(time.time())}"

            await _state.db_pool.execute(
                """INSERT INTO agent_calls (
                    id, bank_id, batch_id, customer_name, phone, loan_type, loan_amount,
                    language, status, room_name, interested, form_sent,
                    category, transcript, collected_data, created_at, updated_at,
                    agent_type
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, 'Pending', $9, false, false,
                    'Uncategorized', '[]'::jsonb, $10, $11, $11,
                    $12
                )""",
                call_uuid,
                bank_id_uuid,
                batch_id,
                r.get("_name") or r.get("name", ""),
                phone,
                r.get("loan_type", "") or None,
                float(r["loan_amount"]) if r.get("loan_amount") and str(r["loan_amount"]).strip() else None,
                language.lower().strip(),
                room_name,
                json.dumps({
                    "email": r.get("email", ""),
                    "aadhar_number": r.get("aadhar_number", ""),
                    "pan_number": r.get("pan_number", ""),
                    "customer_type": r.get("customer_type", "new"),
                    "gender": gender.lower().strip(),
                }),
                upload_time,
                agent_type,
            )
            count += 1

        logger.info(f"Uploaded {count} records, batch={batch_id}, bank={bank_id}")

        # Auto-start batch immediately if within calling hours (Samavesh pattern)
        auto_calling = False
        if background_tasks is not None and count > 0 and is_within_calling_hours():
            await _state.db_pool.execute(
                "UPDATE agent_batches SET status = 'running' WHERE id = $1", batch_uuid,
            )
            background_tasks.add_task(process_batch_run, str(batch_uuid))
            auto_calling = True
            logger.info(f"Auto-started batch {batch_id}")

        return {
            "status": "success",
            "batch_id": batch_id,
            "batch_uuid": str(batch_uuid),
            "inserted_count": count,
            "message": (
                f"Queued {count} clean records ({report['removed_total']} skipped). Calling started!" if auto_calling
                else f"Queued {count} clean records ({report['removed_total']} skipped). Calls will start at {CALL_START_HOUR} AM IST."
            ),
            "auto_calling": auto_calling,
            **report,
            "calling_hours": {"active": is_within_calling_hours(), "window": f"{CALL_START_HOUR}AM - {CALL_END_HOUR % 24 or 12}AM IST"},
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch-call")
async def trigger_batch(
    background_tasks: BackgroundTasks,
    batch_id: Optional[str] = None,
    phone_number_id: Optional[str] = Query(
        None,
        description=(
            "UUID of a phone_numbers row — overrides the batch's existing "
            "preferred_phone_id and forces every call to dial FROM that "
            "number. Lets the operator pick a different caller ID at start "
            "time without re-uploading the CSV."
        ),
    ),
    user: dict = Depends(get_current_bank_user),
):
    """Start batch calling. Sets the most recent 'pending' batch to 'running' so the cron picks it up.
    Optionally specify a batch_id to start a specific batch."""
    if not is_within_calling_hours():
        raise HTTPException(
            status_code=403,
            detail=f"Calling not allowed. Active hours: {CALL_START_HOUR}AM-{CALL_END_HOUR % 24 or 12}AM IST. "
                   f"Current: {now_ist().strftime('%I:%M %p IST')}",
        )

    # Clear emergency stop first (operator is explicitly starting)
    await set_emergency_stop(False)

    # Find the batch to start (pending first, then running/paused)
    if batch_id:
        batch_row = await _state.db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE id = $1", uuid.UUID(batch_id))
    else:
        batch_row = await _state.db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE status IN ('pending', 'running', 'paused') ORDER BY created_at DESC LIMIT 1")

    if not batch_row:
        raise HTTPException(status_code=404, detail="No pending batch found. Upload a CSV first.")

    # If the operator picked a phone via the dropdown, overwrite the batch's
    # preferred_phone_id before flipping to 'running' — that's what
    # process_batch_run reads when constructing the Dispatcher.
    if phone_number_id:
        try:
            preferred_phone_uuid = uuid.UUID(phone_number_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="phone_number_id is not a valid UUID")
        exists = await _state.db_pool.fetchval(
            "SELECT 1 FROM phone_numbers WHERE id = $1 AND status = 'active'",
            preferred_phone_uuid,
        )
        if not exists:
            raise HTTPException(
                status_code=404,
                detail=f"phone_number_id {phone_number_id} not found or not active",
            )
        await _state.db_pool.execute(
            "UPDATE agent_batches SET preferred_phone_id = $1 WHERE id = $2",
            preferred_phone_uuid, batch_row["id"],
        )

    # Set batch to "running"
    await _state.db_pool.execute(
        "UPDATE agent_batches SET status = 'running' WHERE id = $1", batch_row["id"])

    # Immediately kick off processing (don't wait for cron)
    background_tasks.add_task(process_batch_run, str(batch_row["id"]))
    return {"status": "started", "message": f"Batch started ({batch_row['total_records']} records)", "batch_id": str(batch_row["id"])}


@router.get("/batch-status")
async def batch_status(
    batch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """Check batch completion progress. Optional date range (date_from/date_to,
    inclusive) scopes the counters to calls in that IST window — same day
    definition as Call Logs (COALESCE(started_at, created_at))."""
    lo, hi = _ist_day_bounds(date_from, date_to)

    async def _count(extra_clause: str):
        # Build the WHERE incrementally so placeholders stay in sync regardless
        # of which optional filters (batch_id, date range) are active.
        parts: list = []
        params: list = []
        if batch_id:
            params.append(batch_id)
            parts.append(f"batch_id = ${len(params)}")
        if lo is not None:
            params.append(lo)
            parts.append(f"COALESCE(started_at, created_at) >= ${len(params)}")
        if hi is not None:
            params.append(hi)
            parts.append(f"COALESCE(started_at, created_at) < ${len(params)}")
        where = " AND ".join(parts) if parts else "TRUE"
        return await _state.db_pool.fetchval(
            f"SELECT COUNT(*) FROM agent_calls WHERE {where}{extra_clause}", *params,
        )

    pending_count = await _count(" AND status IN ('Pending', 'Calling', 'Scheduled', 'Called - Callback Requested')")
    active_count = await _count(" AND status = 'Calling'")
    # 'failed' is the single agreed umbrella for all hard-failure outcomes —
    # Failed + Invalid Phone + Call Not Connected — used consistently across the
    # bank/ops batch dashboards AND the Call Logs 'Failed' filter. 'Not Answered'
    # is a distinct outcome and stays in its own bucket.
    failed_count = await _count(" AND status IN ('Failed', 'Invalid Phone', 'Call Not Connected')")
    not_answered_count = await _count(" AND status = 'Not Answered'")
    completed_count = await _count(" AND status IN ('Called', 'Called - Interested', 'Called - Not Interested')")
    cancelled_count = await _count(" AND status = 'Cancelled'")
    wrong_contact_count = await _count(" AND status = 'Wrong Contact'")
    total_count = await _count("")

    # Why isn't a 'running' batch dialing? Surface the blocking reason so a batch
    # stuck at Pending is self-explaining instead of a silent hang. Both of these
    # cause calls to stay 'Pending' (never dialed): an Emergency Stop that was
    # never resumed, or being outside the calling window. (A trunk/LiveKit
    # problem instead marks calls 'Failed', so it isn't a "blocked" reason.)
    emergency_stop = await is_emergency_stop_active()
    within_hours = is_within_calling_hours()
    blocked_reason = None
    if pending_count > 0:
        if emergency_stop:
            blocked_reason = "emergency_stop"
        elif not within_hours:
            blocked_reason = "outside_calling_hours"

    return {
        "status": "success",
        "is_complete": pending_count == 0,                  # boolean kept under a non-clashing key
        "message": "All calls completed" if pending_count == 0 else f"{pending_count} calls remaining",
        "pending": pending_count,
        "active_calls": active_count,
        "failed": failed_count,                             # grouped (matches Call Logs 'Failed' filter)
        "not_answered": not_answered_count,
        "completed": completed_count,                       # numeric, matches dashboard tile expectation
        "cancelled": cancelled_count,                       # calls skipped because the batch was stopped
        "wrong_contact": wrong_contact_count,               # answered but reached the wrong person
        "total": total_count,
        # Diagnostics for the "running but nothing dials" case:
        "emergency_stop": emergency_stop,
        "within_calling_hours": within_hours,
        "calling_window": f"{CALL_START_HOUR}:00–{CALL_END_HOUR % 24 or 24}:00 IST",
        "blocked_reason": blocked_reason,                   # 'emergency_stop' | 'outside_calling_hours' | null
    }


@router.post("/batch-retry")
async def trigger_batch_retry(
    background_tasks: BackgroundTasks,
    batch_id: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """Retry failed/not-answered calls in a specific batch (or most recent completed batch).
    Resets failed calls to 'Pending' (if retry_count < MAX_RETRIES) and sets batch back to 'running'."""
    if not is_within_calling_hours():
        raise HTTPException(
            status_code=403,
            detail=f"Calling not allowed outside {CALL_START_HOUR}AM-{CALL_END_HOUR % 24 or 12}AM IST.",
        )

    # Find the batch. batch_id may be the UUID (agent_batches.id) OR the string
    # batch_id the frontend uses as its row key — accept both.
    if batch_id:
        batch_row = None
        try:
            batch_row = await _state.db_pool.fetchrow(
                "SELECT * FROM agent_batches WHERE id = $1", uuid.UUID(batch_id)
            )
        except ValueError:
            pass  # not a UUID — fall through to the string batch_id lookup
        if batch_row is None:
            batch_row = await _state.db_pool.fetchrow(
                "SELECT * FROM agent_batches WHERE batch_id = $1", batch_id
            )
        if not batch_row:
            raise HTTPException(status_code=404, detail=f"Batch not found: {batch_id}")
    else:
        batch_row = await _state.db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1")

    if not batch_row:
        raise HTTPException(status_code=404, detail="No completed batch found to retry.")

    batch = _row_to_dict(batch_row)
    bid = batch["id"]

    # Reset failed calls in this batch to Pending (only if under retry limit).
    # retry_count is incremented on every failure including the initial dial,
    # so retry_count == 1 means "initial failed, 0 retries done" → eligible for
    # retry #1. With MAX_RETRIES=2, we allow retry while retry_count <= 2,
    # giving exactly 2 retries after the original attempt.
    # Reset to a CLEAN Pending state — not just the status. The previous
    # attempt's terminal fields (started_at/ended_at/duration/room/error) are
    # cleared so the record is a genuine fresh attempt: it won't keep showing the
    # old "Failed / Not Answered" timestamp + error while (and if) it re-dials,
    # and the dispatcher assigns a brand-new room. retry_count is preserved — it
    # gates how many retries remain and is incremented by the next attempt.
    result = await _state.db_pool.execute(
        f"""UPDATE agent_calls SET
                status = 'Pending',
                started_at = NULL,
                ended_at = NULL,
                call_duration = 0,
                room_name = NULL,
                error_message = NULL,
                updated_at = $2
            WHERE batch_id = $1
            AND status IN ('Not Answered', 'Failed', 'Call Not Connected')
            AND retry_count <= {MAX_RETRIES}""",
        batch.get("batch_id") or bid, now_ist(),
    )
    reset_count = int(result.split()[-1]) if result else 0

    if reset_count == 0:
        return {"status": "nothing", "message": "No retriable calls found (all at max retries or already completed)"}

    # Set batch back to running and dispatch immediately (don't wait for the cron).
    await _state.db_pool.execute("UPDATE agent_batches SET status = 'running' WHERE id = $1", uuid.UUID(bid))
    background_tasks.add_task(process_batch_run, bid)
    return {"status": "started", "message": f"Retrying {reset_count} failed call(s) — re-dialing now", "retrying": reset_count}


@router.post("/emergency-stop")
async def emergency_stop(user: dict = Depends(get_current_bank_user)):
    """Immediately stop all calling and kill every active call.

    Order matters:
      1. Set the DB flag so any call still queued behind the concurrency
         semaphore skips itself on its next per-call re-check.
      2. Signal every running Dispatcher to stop (`_stopped = True`). This is
         the piece that was previously missing: without it, calls parked in
         `_wait_for_cooldown_and_retry()` (`while not self._stopped`) kept
         waiting for a trunk and would still DIAL after the stop, because they
         had already passed the emergency-stop gate before parking.
      3. Kill ALL rooms currently in 'Calling' — not just one. With
         DISPATCHER_CONCURRENCY live calls in flight, a single LIMIT-1 delete
         left the rest ringing.
    """
    await set_emergency_stop(True)
    logger.warning("EMERGENCY STOP activated by operator")

    # 2. Signal in-flight dispatchers to stop picking up / waiting for work.
    signaled = 0
    try:
        from services.dispatcher import manager as dispatcher_mgr
        signaled = dispatcher_mgr.stop_all()
        logger.warning("Emergency stop signaled %d active dispatcher(s)", signaled)
    except Exception as e:
        logger.error(f"Failed to signal dispatchers during emergency stop: {e}")

    # 3. Kill EVERY active call (operator scope — no bank filter).
    active_rows = await _state.db_pool.fetch(
        "SELECT id, room_name FROM agent_calls WHERE status = 'Calling'")
    rooms_deleted = 0
    lk = None
    try:
        for active in active_rows:
            if not active["room_name"]:
                continue
            try:
                if lk is None:
                    lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY,
                                        api_secret=LIVEKIT_API_SECRET)
                await lk.room.delete_room(api.DeleteRoomRequest(room=active["room_name"]))
                rooms_deleted += 1
                await _state.db_pool.execute(
                    """UPDATE agent_calls
                       SET status = 'Failed', error_message = 'Emergency Stop',
                           ended_at = $1, updated_at = $1
                       WHERE id = $2""",
                    now_ist(), active["id"],
                )
            except Exception as e:
                logger.error(f"Failed to delete room during emergency stop: {e}")
    finally:
        if lk is not None:
            try:
                await lk.aclose()
            except Exception:
                pass

    # Pause all running batches
    await _state.db_pool.execute("UPDATE agent_batches SET status = 'paused' WHERE status = 'running'")
    await release_batch_lock()
    return {
        "status": "success",
        "message": "Emergency stop activated — all batches paused",
        "active_calls_killed": rooms_deleted,
        "dispatchers_signaled": signaled,
    }


@router.post("/resume-calling")
async def resume_calling(user: dict = Depends(get_current_bank_user)):
    """Disable emergency stop and resume paused batches."""
    await set_emergency_stop(False)
    result = await _state.db_pool.execute("UPDATE agent_batches SET status = 'running' WHERE status = 'paused'")
    resumed = int(result.split()[-1]) if result else 0
    logger.info(f"Emergency stop deactivated, {resumed} batches resumed")
    return {"status": "success", "message": f"Calling resumed. {resumed} batch(es) reactivated."}


@router.post("/stop-batch")
async def stop_batch(batch_id: str, user: dict = Depends(get_current_bank_user)):
    """Stop ONE specific batch (targeted, unlike the global emergency-stop).

    Unblocks the queue for a freshly-uploaded batch: the stopped batch leaves the
    'running' set, so process_batch_run's auto-chain immediately picks up the next
    batch — no waiting for the old one to drain. Steps:
      1. status -> 'stopped' so the cron / auto-chain never selects it again.
      2. Signal its dispatcher (if actively dialing) to stop picking up work.
      3. Kill its in-flight 'Calling' rooms.
      4. Cancel its not-yet-dialed calls so they are never placed.
    Accepts either the batch UUID (id) or the string batch_id.
    """
    # Resolve by UUID id first, then fall back to the string batch_id.
    row = None
    try:
        row = await _state.db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE id = $1", uuid.UUID(batch_id))
    except ValueError:
        row = None
    if row is None:
        row = await _state.db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE batch_id = $1", batch_id)
    if not row:
        raise HTTPException(status_code=404, detail="Batch not found")

    b = _row_to_dict(row)
    batch_uuid = row["id"]
    call_batch_id = b.get("batch_id") or str(batch_uuid)

    if b.get("status") not in ("running", "paused", "pending"):
        return {"status": "noop",
                "message": f"Batch is '{b.get('status')}' — nothing to stop."}

    # 1. Take it out of the 'running' set so cron/auto-chain skip it.
    await _state.db_pool.execute(
        "UPDATE agent_batches SET status = 'stopped' WHERE id = $1", batch_uuid)

    # 2. Signal the dispatcher for this batch (only if it's actively dialing).
    dispatcher_signaled = False
    try:
        from services.dispatcher import manager as dispatcher_mgr
        dispatcher_signaled = dispatcher_mgr.stop_one(str(batch_uuid))
    except Exception as e:
        logger.error(f"stop_batch: failed to signal dispatcher: {e}")

    # 3. Kill every in-flight 'Calling' room belonging to this batch.
    active_rows = await _state.db_pool.fetch(
        "SELECT id, room_name FROM agent_calls WHERE batch_id = $1 AND status = 'Calling'",
        call_batch_id,
    )
    in_flight_killed = 0
    lk = None
    try:
        for a in active_rows:
            if not a["room_name"]:
                continue
            try:
                if lk is None:
                    lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY,
                                        api_secret=LIVEKIT_API_SECRET)
                await lk.room.delete_room(api.DeleteRoomRequest(room=a["room_name"]))
                in_flight_killed += 1
                await _state.db_pool.execute(
                    """UPDATE agent_calls
                          SET status = 'Failed', error_message = 'Batch stopped',
                              ended_at = $1, updated_at = $1
                        WHERE id = $2""",
                    now_ist(), a["id"],
                )
            except Exception as e:
                logger.error(f"stop_batch: room delete failed: {e}")
    finally:
        if lk is not None:
            try:
                await lk.aclose()
            except Exception:
                pass

    # 4. Cancel the calls that were never dialed so they can't be placed later.
    result = await _state.db_pool.execute(
        """UPDATE agent_calls
              SET status = 'Cancelled', error_message = 'Batch stopped', updated_at = $1
            WHERE batch_id = $2
              AND status IN ('Pending', 'Scheduled', 'Called - Callback Requested')""",
        now_ist(), call_batch_id,
    )
    cancelled = int(result.split()[-1]) if result else 0

    logger.warning(
        "Batch %s STOPPED by operator — in_flight_killed=%d, cancelled=%d, dispatcher_signaled=%s",
        batch_uuid, in_flight_killed, cancelled, dispatcher_signaled,
    )
    return {
        "status": "success",
        "message": "Batch stopped",
        "batch_id": str(batch_uuid),
        "in_flight_killed": in_flight_killed,
        "cancelled": cancelled,
        "dispatcher_signaled": dispatcher_signaled,
    }

# ============================================================================
# UPLOADS / BATCHES LIST (was missing — needed by dashboard UI)
# ============================================================================

@router.get("/uploads")
async def list_uploads(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user: dict = Depends(get_current_bank_user),
):
    """List batch uploads, optionally scoped to an inclusive IST date range
    (date_from/date_to) on the batch's created_at. Aliases created_at/
    total_records as uploaded_at/record_count so the static dashboard (which
    uses Samavesh field names) renders correctly."""
    lo, hi = _ist_day_bounds(date_from, date_to)
    conds: list = []
    params: list = []
    bank_uuid = _bank_uuid(user)  # operator -> None (all banks); bank_user -> their bank
    if bank_uuid:
        params.append(bank_uuid)
        conds.append(f"bank_id = ${len(params)}")
    if lo is not None:
        params.append(lo)
        conds.append(f"created_at >= ${len(params)}")
    if hi is not None:
        params.append(hi)
        conds.append(f"created_at < ${len(params)}")
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    rows = await _state.db_pool.fetch(
        f"SELECT * FROM agent_batches{where} ORDER BY created_at DESC LIMIT 50", *params)
    uploads = []
    for r in _rows_to_list(rows):
        r["uploaded_at"] = r.get("created_at")
        r["record_count"] = r.get("total_records") or 0
        uploads.append(r)
    return {"uploads": uploads}

@router.get("/upload/{batch_id}")
async def get_upload_detail(batch_id: str, user: dict = Depends(get_current_bank_user)):
    """Get calls for a specific batch.

    The frontend passes agent_batches.id (a UUID). agent_calls.batch_id stores
    the string like 'batch_abc123_...'. Resolve via agent_batches when a UUID is given.
    """
    call_batch_id = batch_id
    try:
        batch_uuid = uuid.UUID(batch_id)
        row = await _state.db_pool.fetchrow(
            "SELECT batch_id FROM agent_batches WHERE id = $1", batch_uuid
        )
        if row and row["batch_id"]:
            call_batch_id = row["batch_id"]
    except ValueError:
        pass  # already a string batch_id

    bank_uuid = _bank_uuid(user)
    rows = await _state.db_pool.fetch(
        "SELECT id, customer_name, phone, status, call_duration, interested, form_sent, form_status, created_at"
        " FROM agent_calls WHERE batch_id = $1 AND ($2::uuid IS NULL OR bank_id = $2) ORDER BY created_at DESC LIMIT 200",
        call_batch_id, bank_uuid,
    )
    return {"calls": _rows_to_list(rows), "batch_id": call_batch_id, "total": len(rows)}

@router.get("/upload/{batch_id}/download")
async def download_batch_csv(batch_id: str, user: dict = Depends(get_current_bank_user)):
    """Stream a CSV of all calls in the batch for download."""
    # Resolve UUID → string batch_id used in agent_calls
    call_batch_id = batch_id
    batch_filename = batch_id[:8]
    try:
        batch_uuid = uuid.UUID(batch_id)
        row = await _state.db_pool.fetchrow(
            "SELECT batch_id, filename FROM agent_batches WHERE id = $1", batch_uuid
        )
        if row:
            if row["batch_id"]:
                call_batch_id = row["batch_id"]
            if row["filename"]:
                batch_filename = row["filename"].rsplit(".", 1)[0]
    except ValueError:
        pass

    bank_uuid = _bank_uuid(user)
    rows = await _state.db_pool.fetch(
        """SELECT customer_name, phone, status, call_duration, interested,
                  form_sent, form_status, form_link, started_at, ended_at, loan_type, loan_amount
           FROM agent_calls WHERE batch_id = $1 AND ($2::uuid IS NULL OR bank_id = $2) ORDER BY created_at ASC""",
        call_batch_id, bank_uuid,
    )

    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "Customer Name", "Phone", "Loan Type", "Loan Amount",
            "Status", "Duration (s)", "Interested", "Form Sent", "Form Status", "Form Link",
            "Call Started", "Call Ended",
        ])
        yield buf.getvalue()
        for r in rows:
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow([
                r["customer_name"] or "",
                r["phone"] or "",
                r["loan_type"] or "",
                r["loan_amount"] or "",
                r["status"] or "",
                r["call_duration"] or 0,
                "Yes" if r["interested"] else "No",
                "Yes" if r["form_sent"] else "No",
                r["form_status"] or "not_sent",
                r["form_link"] or "",
                r["started_at"].isoformat() if r["started_at"] else "",
                r["ended_at"].isoformat() if r["ended_at"] else "",
            ])
            yield buf.getvalue()

    safe_name = "".join(c if c.isalnum() or c in "-_." else "_" for c in batch_filename)
    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}_results.csv"'},
    )


@router.get("/recent_calls")
async def recent_calls(limit: int = Query(10, ge=1, le=50), user: dict = Depends(get_current_bank_user)):
    """Get recent calls (shortcut for dashboard).
    Returns both `calls` (current API) and `recent_calls` (Samavesh-shaped) so
    the static agent-dashboard.html, which reads `data.recent_calls`, renders."""
    bank_uuid = _bank_uuid(user)
    rows = await _state.db_pool.fetch(
        "SELECT * FROM agent_calls WHERE ($2::uuid IS NULL OR bank_id = $2) "
        "ORDER BY created_at DESC LIMIT $1",
        limit, bank_uuid,
    )
    payload = [_serialize_call(_row_to_dict(r)) for r in rows]
    return {"calls": payload, "recent_calls": payload}
