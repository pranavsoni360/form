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
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query, BackgroundTasks
from livekit import api
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from . import state as _state
from .state import (
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

_scheduler: AsyncIOScheduler = None


async def agent_startup():
    """Call from main app's startup event (after set_db_pool)."""
    global _scheduler
    await _init_system_state()
    await release_batch_lock()
    await cleanup_stuck_calls()

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
    # Daily system_errors cleanup — runs at 03:00 IST (low-traffic window).
    # Retention configurable via LOS_ERROR_RETENTION_DAYS env, default 1 day.
    # Bounded DELETE so the table never grows unbounded across deployments.
    _scheduler.add_job(
        _scheduled_error_cleanup,
        CronTrigger(hour=3, minute=0, timezone="Asia/Kolkata"),
        id="error_cleanup",
        replace_existing=True,
    )
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
    """Poll Postgres until call completes or timeout. Two-phase: active polling + post-room-gone grace."""
    call_uuid = uuid.UUID(call_id)
    poll_interval = 3
    elapsed = 0
    room_gone = False

    while elapsed < timeout:
        await asyncio.sleep(poll_interval)
        elapsed += poll_interval

        row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
        if not row:
            return None
        doc = _row_to_dict(row)
        if doc.get("status") != "Calling":
            return doc

        # Check room existence every 10s after 30s
        if elapsed >= 30 and elapsed % 10 == 0:
            try:
                lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
                rooms = await lk.room.list_rooms(api.ListRoomsRequest(names=[room_name]))
                await lk.aclose()
                if not rooms.rooms:
                    if not room_gone:
                        room_gone = True
                        logger.info(f"Room {room_name} gone. Waiting up to 60s for transcript...")
                    # Phase 2: wait for transcript after room deletion
                    for _ in range(12):
                        await asyncio.sleep(5)
                        row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
                        if row and dict(row).get("status") != "Calling":
                            return _row_to_dict(row)
                    # Transcript never arrived
                    await _state.db_pool.execute(
                        """UPDATE agent_calls
                           SET status = 'Not Answered',
                               ended_at = $1, updated_at = $1,
                               error_message = 'Room deleted but no transcript after 60s',
                               retry_count = retry_count + 1
                           WHERE id = $2""",
                        now_ist(), call_uuid,
                    )
                    row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
                    return _row_to_dict(row)
            except Exception as e:
                # Don't drop on the floor — a real LiveKit/DB error here means
                # the poll loop continues and may eventually time out, but at
                # least the operator sees a trail in logs.
                logger.warning(
                    "wait_for_call_completion poll iteration failed for %s: %s",
                    call_uuid, e,
                )

    # Global timeout
    await _state.db_pool.execute(
        """UPDATE agent_calls
           SET status = 'Not Answered',
               ended_at = $1, updated_at = $1,
               retry_count = retry_count + 1
           WHERE id = $2""",
        now_ist(), call_uuid,
    )
    row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    return _row_to_dict(row)


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
            is_within_calling_hours_fn=is_within_calling_hours,
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
        # Check if batch has any remaining pending calls
        if batch_row:
            remaining = await _state.db_pool.fetchval(
                "SELECT COUNT(*) FROM agent_calls WHERE batch_id = $1 AND status IN ('Pending', 'Scheduled')",
                call_batch_id,
            )
            if remaining == 0:
                await _state.db_pool.execute(
                    "UPDATE agent_batches SET status = 'completed' WHERE id = $1",
                    uuid.UUID(batch_id),
                )
                logger.info(f"Batch {batch_id} fully completed")
            else:
                logger.info(f"Batch {batch_id} paused — {remaining} calls remaining (will resume next cron)")

        await release_batch_lock()
        try:
            logger.info(f"BATCH RUN DONE | Total: {completed} | OK: {successful} | Fail: {failed}")
        except UnboundLocalError:
            # No batch was processed (no batch_row); counts not defined
            pass

# ============================================================================
# BATCH MANAGEMENT ENDPOINTS
# ============================================================================

@router.post("/upload-excel")
async def upload_excel(
    file: UploadFile = File(...),
    language: str = Query("hindi", description="Agent language"),
    gender: str = Query("male", description="Agent voice gender"),
    agent_type: str = Query("loan_enquiry", description="loan_enquiry | account_opening"),
    phone_number_id: Optional[str] = Query(
        None,
        description=(
            "UUID of a phone_numbers row — when set, every call in this batch "
            "dials FROM that specific number (e.g. operator picked +17744930587 "
            "from the /ops/batch dropdown). When unset, dispatcher auto-picks "
            "least-loaded across the pool."
        ),
    ),
    background_tasks: BackgroundTasks = None,
    # no auth — operator access
):
    """Upload Excel/CSV with customer data for batch calling."""
    bank_id = None  # operator — no bank scoping

    try:
        filename = file.filename.lower()
        if not (filename.endswith(".csv") or filename.endswith(".xlsx") or filename.endswith(".xls")):
            raise HTTPException(status_code=400, detail="Only CSV/Excel files allowed")

        contents = await file.read()
        if filename.endswith(".csv"):
            # Try UTF-8 first (Excel exports include a BOM). Many vendors
            # ship files in Windows-1252 / latin-1, so fall back to that.
            try:
                df = pd.read_csv(io.StringIO(contents.decode("utf-8-sig")))
            except Exception as utf_err:
                logger.warning(
                    "CSV decode failed as UTF-8 (%s); retrying as latin-1",
                    utf_err,
                )
                try:
                    df = pd.read_csv(io.StringIO(contents.decode("latin-1")))
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
            df = pd.read_excel(io.BytesIO(contents))

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
            raw_phone = str(r.get("phone", "")).strip()
            if raw_phone.endswith(".0"):
                raw_phone = raw_phone[:-2]
            digits = "".join(filter(str.isdigit, raw_phone))
            if len(digits) == 10:
                phone = f"+91{digits}"
            elif len(digits) == 12 and digits.startswith("91"):
                phone = f"+{digits}"
            else:
                phone = raw_phone

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
                r.get("name", ""),
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
                f"Uploaded {count} records. Calling started!" if auto_calling
                else f"Uploaded {count} records. Calls will start at {CALL_START_HOUR} AM IST."
            ),
            "auto_calling": auto_calling,
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
    # no auth — operator access
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
    # no auth — operator access
):
    """Check batch completion progress."""
    bank_uuid = None  # operator — no bank scoping
    bk_cond = "bank_id = $1" if bank_uuid else "TRUE"
    bk_params = [bank_uuid] if bank_uuid else []
    offset = len(bk_params)

    async def _count(extra_clause: str, *extra_params):
        if batch_id:
            return await _state.db_pool.fetchval(
                f"SELECT COUNT(*) FROM agent_calls WHERE {bk_cond} AND batch_id = ${offset+1}{extra_clause}",
                *bk_params, batch_id, *extra_params,
            )
        return await _state.db_pool.fetchval(
            f"SELECT COUNT(*) FROM agent_calls WHERE {bk_cond}{extra_clause}",
            *bk_params, *extra_params,
        )

    pending_count = await _count(" AND status IN ('Pending', 'Calling', 'Scheduled')")
    active_count = await _count(" AND status = 'Calling'")
    failed_count = await _count(" AND status IN ('Failed', 'Invalid Phone', 'Call Not Connected', 'Not Answered')")
    completed_count = await _count(" AND status IN ('Called', 'Called - Interested', 'Called - Not Interested')")
    total_count = await _count("")

    return {
        "status": "success",
        "is_complete": pending_count == 0,                  # boolean kept under a non-clashing key
        "message": "All calls completed" if pending_count == 0 else f"{pending_count} calls remaining",
        "pending": pending_count,
        "active_calls": active_count,
        "failed": failed_count,
        "completed": completed_count,                       # numeric, matches dashboard tile expectation
        "total": total_count,
    }


@router.post("/batch-retry")
async def trigger_batch_retry(
    background_tasks: BackgroundTasks,
    batch_id: Optional[str] = None,
    # no auth — operator access
):
    """Retry failed/not-answered calls in a specific batch (or most recent completed batch).
    Resets failed calls to 'Pending' (if retry_count < MAX_RETRIES) and sets batch back to 'running'."""
    if not is_within_calling_hours():
        raise HTTPException(
            status_code=403,
            detail=f"Calling not allowed outside {CALL_START_HOUR}AM-{CALL_END_HOUR % 24 or 12}AM IST.",
        )

    # Find the batch
    if batch_id:
        batch_row = await _state.db_pool.fetchrow("SELECT * FROM agent_batches WHERE id = $1", uuid.UUID(batch_id))
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
    result = await _state.db_pool.execute(
        f"""UPDATE agent_calls SET status = 'Pending'
            WHERE batch_id = $1
            AND status IN ('Not Answered', 'Failed', 'Call Not Connected')
            AND retry_count <= {MAX_RETRIES}""",
        batch.get("batch_id") or bid,
    )
    reset_count = int(result.split()[-1]) if result else 0

    if reset_count == 0:
        return {"status": "nothing", "message": "No retriable calls found (all at max retries or already completed)"}

    # Set batch back to running
    await _state.db_pool.execute("UPDATE agent_batches SET status = 'running' WHERE id = $1", uuid.UUID(bid))
    background_tasks.add_task(process_batch_run, bid)
    return {"status": "started", "message": f"Retrying {reset_count} failed calls in batch"}


@router.post("/emergency-stop")
async def emergency_stop():
    """Immediately stop all calling and kill active call if any."""
    await set_emergency_stop(True)
    logger.warning("EMERGENCY STOP activated by operator")

    bank_uuid = None  # operator — no bank scoping
    # Kill active call
    if bank_uuid:
        active = await _state.db_pool.fetchrow(
            "SELECT id, room_name FROM agent_calls WHERE status = 'Calling' AND bank_id = $1 LIMIT 1", bank_uuid)
    else:
        active = await _state.db_pool.fetchrow(
            "SELECT id, room_name FROM agent_calls WHERE status = 'Calling' LIMIT 1")
    room_deleted = False
    if active and active["room_name"]:
        try:
            lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
            await lk.room.delete_room(api.DeleteRoomRequest(room=active["room_name"]))
            await lk.aclose()
            room_deleted = True
            await _state.db_pool.execute(
                """UPDATE agent_calls
                   SET status = 'Failed', error_message = 'Emergency Stop',
                       ended_at = $1, updated_at = $1
                   WHERE id = $2""",
                now_ist(), active["id"],
            )
        except Exception as e:
            logger.error(f"Failed to delete room during emergency stop: {e}")

    # Pause all running batches
    await _state.db_pool.execute("UPDATE agent_batches SET status = 'paused' WHERE status = 'running'")
    await release_batch_lock()
    return {"status": "success", "message": "Emergency stop activated — all batches paused", "active_call_killed": room_deleted}


@router.post("/resume-calling")
async def resume_calling():
    """Disable emergency stop and resume paused batches."""
    await set_emergency_stop(False)
    result = await _state.db_pool.execute("UPDATE agent_batches SET status = 'running' WHERE status = 'paused'")
    resumed = int(result.split()[-1]) if result else 0
    logger.info(f"Emergency stop deactivated, {resumed} batches resumed")
    return {"status": "success", "message": f"Calling resumed. {resumed} batch(es) reactivated."}

# ============================================================================
# UPLOADS / BATCHES LIST (was missing — needed by dashboard UI)
# ============================================================================

@router.get("/uploads")
async def list_uploads():
    """List all batch uploads. Aliases created_at/total_records as uploaded_at/record_count
    so the static dashboard (which uses Samavesh field names) renders correctly."""
    rows = await _state.db_pool.fetch("SELECT * FROM agent_batches ORDER BY created_at DESC LIMIT 50")
    uploads = []
    for r in _rows_to_list(rows):
        r["uploaded_at"] = r.get("created_at")
        r["record_count"] = r.get("total_records") or 0
        uploads.append(r)
    return {"uploads": uploads}

@router.get("/upload/{batch_id}")
async def get_upload_detail(batch_id: str):
    """Get calls for a specific batch."""
    rows = await _state.db_pool.fetch(
        "SELECT id, customer_name, phone, status, call_duration, interested, form_sent, created_at FROM agent_calls WHERE batch_id = $1 ORDER BY created_at DESC",
        batch_id,
    )
    return {"calls": _rows_to_list(rows), "batch_id": batch_id, "total": len(rows)}

@router.get("/recent_calls")
async def recent_calls(limit: int = Query(10, ge=1, le=50)):
    """Get recent calls (shortcut for dashboard).
    Returns both `calls` (current API) and `recent_calls` (Samavesh-shaped) so
    the static agent-dashboard.html, which reads `data.recent_calls`, renders."""
    rows = await _state.db_pool.fetch(
        "SELECT * FROM agent_calls ORDER BY created_at DESC LIMIT $1", limit
    )
    payload = [_serialize_call(_row_to_dict(r)) for r in rows]
    return {"calls": payload, "recent_calls": payload}
