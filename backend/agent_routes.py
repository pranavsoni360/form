# agent_routes.py - Agent Calling API Router for LOS Form System
# Ported from reference pusad_main2.py, adapted for multi-bank tenant architecture.
#
# Provides batch calling management, call tracking, form integration,
# analytics, and export endpoints. Uses asyncpg (Postgres) for call data
# and integrates with the main app's JWT auth for bank_id scoping.
#
# Include in main.py:
#   from agent_routes import router as agent_router, set_db_pool, agent_startup
#   app.include_router(agent_router)
#   # After creating pool:
#   set_db_pool(db_pool)

import os
import io
import secrets
import time
import asyncio
import logging
import json
import uuid
import pytz
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import pandas as pd
from fastapi import (
    APIRouter, UploadFile, File, Form, HTTPException,
    Query, BackgroundTasks, Depends, Request,
)
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from livekit import api
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from google import genai
from google.genai import types
import jwt as pyjwt

# ============================================================================
# DB POOL (set from main.py after pool creation)
# ============================================================================

db_pool = None


def set_db_pool(pool):
    global db_pool
    db_pool = pool

# ============================================================================
# CONFIGURATION
# ============================================================================

# LiveKit
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://127.0.0.1:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
SIP_TRUNK_ID = os.getenv("SIP_TRUNK_ID", "")

# Gemini (for transcript analysis)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Demo mode -- simulate calls without LiveKit/SIP
DEMO_MODE = os.getenv("AGENT_DEMO_MODE", "false").lower() == "true"

# Agent dispatched by LiveKit
AGENT_NAME = os.getenv("AGENT_NAME", "pusad-bank-loan-enquiry-enhanced")

# Recording server base URL (GPU box serving recordings)
RECORDING_BASE_URL = os.getenv("RECORDING_BASE_URL", "")

# AiSensy WhatsApp
AISENSY_API_KEY = os.getenv("AISENSY_API_KEY", "")
AISENSY_CAMPAIGN_NAME = os.getenv("AISENSY_FORM_CAMPAIGN", os.getenv("AISENSY_CAMPAIGN_NAME", "LRS_TESTING"))
AISENSY_USERNAME = os.getenv("AISENSY_USERNAME", "Virtual Galaxy WABA")
AISENSY_IMAGE_URL = os.getenv(
    "AISENSY_IMAGE_URL",
    "https://d3jt6ku4g6z5l8.cloudfront.net/IMAGE/6353da2e153a147b991dd812/4958901_highanglekidcheatingschooltestmin.jpg",
)

# Form URL (the LOS frontend)
FORM_BASE_URL = os.getenv("FORM_BASE_URL", "https://virtualvaani.vgipl.com:3001")

# JWT -- reuse the same secret as main.py
JWT_SECRET = os.getenv("JWT_SECRET", "your-jwt-secret-key")

# Call time window (IST)
CALL_START_HOUR = int(os.getenv("CALL_START_HOUR", "10"))  # 10 AM
CALL_END_HOUR = int(os.getenv("CALL_END_HOUR", "24"))      # midnight
MAX_RETRIES = int(os.getenv("MAX_CALL_RETRIES", "1"))       # default 1 retry after initial attempt

IST = pytz.timezone("Asia/Kolkata")

logger = logging.getLogger("agent-routes")

# ============================================================================
# STATUS & CATEGORY CONSTANTS
# ============================================================================

STATUS_OPTIONS = [
    "Pending", "Calling", "Called", "Called - Interested", "Called - Not Interested",
    "Not Answered", "Call Not Connected", "Failed", "Scheduled", "Invalid Phone",
]

CATEGORY_OPTIONS = [
    "Very Interested - Form Sent",
    "Interested - Callback Requested",
    "Interested - Needs Time to Decide",
    "Not Interested - Already Has Loan",
    "Not Interested - No Need Currently",
    "Ineligible - Income Too Low",
    "Ineligible - Business Too New",
    "Wrong Number / Not Reachable",
    "Call Not Connected",
    "Language Barrier",
    "Uncategorized",
]

# ============================================================================
# SERIALIZATION HELPERS
# ============================================================================


def _row_to_dict(row):
    """Convert an asyncpg Record to a JSON-safe dict. Adds _id alias for frontend compat."""
    if row is None:
        return None
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            d[k] = str(v)
        elif isinstance(v, datetime):
            d[k] = v.isoformat()
    if "id" in d:
        d["_id"] = d["id"]
    return d


def _rows_to_list(rows):
    return [_row_to_dict(r) for r in rows]


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def format_ist_time(dt) -> str:
    """Convert a datetime to IST display string."""
    if not dt:
        return ""
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%d %b, %I:%M %p")


def now_ist() -> datetime:
    return datetime.now(IST)


def now_ist_str() -> str:
    return now_ist().strftime("%b %d, %Y %I:%M %p")


def is_within_calling_hours() -> bool:
    hour = now_ist().hour
    return CALL_START_HOUR <= hour < CALL_END_HOUR


# ============================================================================
# POSTGRES SYSTEM STATE HELPERS
# ============================================================================
# These replace the MongoDB system_config / batch_lock / analytics_lock
# collections. We use a simple key-value approach in-memory + a lightweight
# advisory lock via Postgres pg_advisory_lock for batch exclusivity.
# For simplicity and since this runs as a single process, we use module-level
# state variables with Postgres-backed persistence for emergency_stop.

_emergency_stop = False
_batch_locked = False
_analytics_locked = False


async def _init_system_state():
    """Initialize system state from Postgres (or set defaults)."""
    global _emergency_stop
    try:
        row = await db_pool.fetchrow(
            "SELECT value FROM agent_system_config WHERE key = 'emergency_stop'"
        )
        if row:
            _emergency_stop = row["value"] == "true"
    except Exception:
        # Table may not exist yet -- will be created by migration
        _emergency_stop = False


async def set_emergency_stop(active: bool):
    global _emergency_stop
    _emergency_stop = active
    try:
        await db_pool.execute(
            """INSERT INTO agent_system_config (key, value, updated_at)
               VALUES ('emergency_stop', $1, $2)
               ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2""",
            "true" if active else "false", now_ist(),
        )
    except Exception as e:
        logger.error(f"Failed to persist emergency_stop: {e}")


async def is_emergency_stop_active() -> bool:
    """Check emergency stop — read from DB to avoid stale in-memory flag."""
    global _emergency_stop
    try:
        row = await db_pool.fetchrow("SELECT value FROM agent_system_config WHERE key = 'emergency_stop'")
        if row:
            _emergency_stop = row["value"] == "true"
    except Exception:
        pass
    return _emergency_stop


async def acquire_batch_lock() -> bool:
    """In-process batch lock. Returns True on success."""
    global _batch_locked
    if _batch_locked:
        return False
    _batch_locked = True
    return True


async def release_batch_lock():
    global _batch_locked
    _batch_locked = False


async def acquire_analytics_lock() -> bool:
    global _analytics_locked
    if _analytics_locked:
        return False
    _analytics_locked = True
    return True


async def release_analytics_lock():
    global _analytics_locked
    _analytics_locked = False


async def cleanup_stuck_calls():
    """Reset calls stuck at 'Calling' for more than 10 minutes."""
    ten_min_ago = now_ist() - timedelta(minutes=10)
    try:
        # Fetch-then-update so we can log which specific rows got swept; this
        # is exactly the evidence you want when diagnosing "why is this call
        # still Calling?" -- each swept row points at a missed webhook.
        stuck = await db_pool.fetch(
            """SELECT id, room_name, customer_name, phone, started_at
                 FROM agent_calls
                WHERE status = 'Calling' AND started_at < $1""",
            ten_min_ago,
        )
        if not stuck:
            return
        for row in stuck:
            logger.warning(
                "[REAPER] sweeping stuck call call_id=%s room=%s customer=%s phone=%s started_at=%s",
                row["id"], row["room_name"], row["customer_name"], row["phone"], row["started_at"],
            )
        result = await db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Failed', error_message = 'Stuck call cleaned up by reaper (>10 min at Calling, no /transcript webhook received)',
                   ended_at = $1, updated_at = $1, retry_count = retry_count + 1
               WHERE status = 'Calling' AND started_at < $2""",
            now_ist(), ten_min_ago,
        )
        count = int(result.split()[-1]) if result else 0
        logger.warning("[REAPER] swept %d stuck 'Calling' records (>10 min)", count)
    except Exception as e:
        logger.error("[REAPER] error: %s", e, exc_info=True)


def _serialize_call(c: dict) -> dict:
    """Prepare a call dict (from _row_to_dict) for JSON display.
    Formats datetime-ISO strings into IST display strings.
    Adds _id alias for MongoDB-style frontend compatibility."""
    if c is None:
        return None
    # Add _id alias for frontend compatibility
    if "id" in c:
        c["_id"] = c["id"]
    # Ensure JSONB fields are parsed (not strings)
    for jfield in ["transcript", "collected_data", "call_analysis"]:
        val = c.get(jfield)
        if isinstance(val, str):
            try:
                c[jfield] = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                pass

    # Flatten aliases for frontend compatibility (MongoDB field names → Postgres)
    c["name"] = c.get("customer_name", "")
    c["whatsapp_form_sent"] = c.get("form_sent", False)
    c["customer_interested"] = c.get("interested", False)
    c["call_status"] = c.get("status", "")
    c["call_duration_seconds"] = c.get("call_duration", 0)
    c["loan_type_interested"] = c.get("loan_type", "")
    c["loan_amount_requested"] = c.get("loan_amount", "")
    c["form_url"] = c.get("form_link", "")

    # Flatten collected_data fields to top level
    cd = c.get("collected_data") or {}
    if isinstance(cd, str):
        try: cd = json.loads(cd)
        except: cd = {}
    for k in ["monthly_income", "employment_type", "employer_name", "loan_purpose",
              "aadhar_number", "pan_number", "designation", "age", "business_type",
              "existing_emi", "collected_address", "monthly_turnover", "business_age"]:
        if k not in c or not c[k]:
            c[k] = cd.get(k, "")

    # Flatten call_analysis fields to top level
    ca = c.get("call_analysis") or {}
    if isinstance(ca, str):
        try: ca = json.loads(ca)
        except: ca = {}
    c["lead_quality"] = ca.get("lead_quality", "")
    c["follow_up_needed"] = ca.get("follow_up_needed", "No")
    c["notification_message"] = ca.get("notification_message", "")
    c["form_submitted"] = ca.get("form_submitted", False)
    c["success"] = c.get("status", "") in ("Called - Interested", "Completed", "Called")

    for field in [
        "started_at", "ended_at", "updated_at", "created_at",
    ]:
        val = c.get(field)
        if val and isinstance(val, str):
            try:
                dt = datetime.fromisoformat(val)
                c[field] = format_ist_time(dt)
            except Exception:
                pass
    return c

# ============================================================================
# LLM TRANSCRIPT ANALYSIS (Gemini)
# ============================================================================

def analyze_transcript_with_llm(transcript: list) -> dict:
    """Analyze transcript using Gemini to categorize the call."""
    if not GEMINI_API_KEY or not transcript:
        return {"category": "Uncategorized", "reminder_date": None, "follow_up_needed": "No"}

    try:
        conversation_text = "\n".join(
            f"{msg.get('role', 'unknown')}: {msg.get('text', '')}" for msg in transcript
        )

        client = genai.Client(api_key=GEMINI_API_KEY)
        prompt = f"""Analyze this call transcript and categorize it.

Categories (choose one):
{chr(10).join(f'- {cat}' for cat in CATEGORY_OPTIONS)}

Also determine follow-up needs and lead quality:
- "Very Interested - Form Sent" -> follow_up_needed: "Yes", lead_quality: "hot"
- "Interested - Callback Requested" -> follow_up_needed: "Yes", lead_quality: "warm"
- "Interested - Needs Time to Decide" -> follow_up_needed: "Yes", lead_quality: "warm"
- "Not Interested" categories -> follow_up_needed: "No", lead_quality: "cold"
- "Ineligible" categories -> follow_up_needed: "No", lead_quality: "cold"
- Other -> follow_up_needed: "No", lead_quality: "cold"

Return JSON ONLY: {{"category": "chosen category", "reminder_date": "YYYY-MM-DD or null", "follow_up_needed": "Yes or No", "how_to_follow_up": "brief instructions", "when_to_follow_up": "timeframe", "lead_quality": "hot/warm/cold", "loan_type": "education/business/personal or null"}}

Transcript:
{conversation_text}"""

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.3),
        )

        result = response.text.strip()
        if result.startswith("```"):
            result = result.split("```")[1].replace("json", "").strip()
        parsed = json.loads(result)
        if "follow_up_needed" not in parsed:
            parsed["follow_up_needed"] = "No"
        return parsed
    except Exception as e:
        logger.error(f"LLM analysis failed: {e}")
        return {"category": "Uncategorized", "reminder_date": None, "follow_up_needed": "No"}

# ============================================================================
# AUTH DEPENDENCY -- reuses main app's JWT tokens
# ============================================================================

security = HTTPBearer(auto_error=False)  # auto_error=False allows unauthenticated access


async def get_current_bank_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Decode JWT and return a scoped user dict. v3 roles: admin / bank_user / vendor_user.
    Admins see everything (bank_id=None). Bank users get bank-wide scope. Vendor users see
    only their vendor's rows (bank+vendor filter applied downstream)."""
    if not credentials:
        # Backwards compatibility: unauthenticated access is still operator-level so the
        # LiveKit voice agent (server-to-server) can post transcript updates.
        return {"user_id": "operator", "role": "operator", "bank_id": None, "vendor_id": None}

    try:
        payload = pyjwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    role = payload.get("role")
    if role not in ("admin", "bank_user", "vendor_user"):
        raise HTTPException(status_code=403, detail="Forbidden")

    return {
        "user_id": payload["user_id"],
        "role": role,
        "bank_id": payload.get("bank_id") if role != "admin" else None,
        "vendor_id": payload.get("vendor_id") if role == "vendor_user" else None,
    }


async def require_admin_local(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Admin-only dependency for legacy /api/agent/* endpoints.

    Duplicates main.py's require_admin locally to avoid a circular import
    (main.py imports agent_routes at module top-level). Auth is enforced
    strictly — no operator fallback like get_current_bank_user has.
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Admin authentication required")
    try:
        payload = pyjwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return {
        "user_id": payload["user_id"],
        "role": "admin",
        "bank_id": None,
        "vendor_id": None,
    }


def _bank_uuid(user: dict):
    """Bank scope UUID: admin/operator see all; bank/vendor users are bank-scoped."""
    bid = user.get("bank_id")
    return uuid.UUID(bid) if bid else None


def _vendor_uuid(user: dict):
    vid = user.get("vendor_id")
    return uuid.UUID(vid) if vid else None


def _bank_filter(bank_uuid, param_idx: int = 1, table_alias: str = "") -> tuple:
    """Build conditional bank_id SQL filter. Returns (condition_str, params_list, next_idx).
    When bank_uuid is None (admin/operator), returns TRUE (no filter)."""
    prefix = f"{table_alias}." if table_alias else ""
    if bank_uuid is None:
        return "TRUE", [], param_idx
    return f"{prefix}bank_id = ${param_idx}", [bank_uuid], param_idx + 1


def _scope_filter(user: dict, param_idx: int = 1, table_alias: str = "") -> tuple:
    """Return (condition, params, next_idx) enforcing bank AND vendor scope as required."""
    prefix = f"{table_alias}." if table_alias else ""
    conds: list[str] = []
    params: list = []
    idx = param_idx
    bid = _bank_uuid(user)
    vid = _vendor_uuid(user)
    if bid is not None:
        conds.append(f"{prefix}bank_id = ${idx}"); params.append(bid); idx += 1
    if vid is not None:
        conds.append(f"{prefix}vendor_id = ${idx}"); params.append(vid); idx += 1
    return (" AND ".join(conds) if conds else "TRUE"), params, idx

# ============================================================================
# PYDANTIC MODELS
# ============================================================================

class TranscriptItem(BaseModel):
    role: str
    text: str
    ts: Optional[float] = None
    timestamp: Optional[str] = None


class TranscriptPayload(BaseModel):
    room: str
    call_id: Optional[str] = None
    transcript: List[TranscriptItem] = []
    message_count: Optional[int] = None
    recording_path: Optional[str] = None
    # Qualification fields from voice agent
    customer_interested: bool = False
    customer_type: Optional[str] = None
    lead_quality: Optional[str] = "cold"
    loan_type: Optional[str] = None
    loan_amount: Optional[str] = None
    employment_type: Optional[str] = None
    business_type: Optional[str] = None
    monthly_income: Optional[str] = None
    interest_reason: Optional[str] = None
    whatsapp_form_sent: bool = False
    age: Optional[str] = None
    loan_purpose: Optional[str] = None
    employer_name: Optional[str] = None
    designation: Optional[str] = None
    existing_emi: Optional[str] = None
    business_age: Optional[str] = None
    monthly_turnover: Optional[str] = None
    collected_address: Optional[str] = None


class CallCategorizeRequest(BaseModel):
    category: str
    reminder_date: Optional[str] = None
    after_call_remark: Optional[str] = None

# ============================================================================
# ROUTER
# ============================================================================

router = APIRouter(prefix="/api/agent", tags=["agent"])

# ============================================================================
# LIFECYCLE (wired in main.py via app startup)
# ============================================================================

_scheduler: AsyncIOScheduler = None


async def agent_startup():
    """Call from main app's startup event (after set_db_pool)."""
    global _scheduler
    await _init_system_state()
    await release_batch_lock()
    await cleanup_stuck_calls()

    _scheduler = AsyncIOScheduler(timezone="Asia/Kolkata")

    # Batch runner every 5 minutes — only processes batches in "running" state
    _scheduler.add_job(
        _scheduled_batch_run,
        CronTrigger(hour="10-23", minute="*/5", timezone="Asia/Kolkata"),
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
    # Stuck-call reaper every 2 minutes. Covers the case where the LiveKit
    # agent worker never picked up the call (process down, SIP error, etc.) --
    # without this the row sits at status='Calling' forever because the only
    # thing that transitions it is the /api/agent/transcript webhook from the
    # agent itself. 10min threshold matches cleanup_stuck_calls().
    _scheduler.add_job(
        cleanup_stuck_calls,
        CronTrigger(minute="*/2", timezone="Asia/Kolkata"),
        id="stuck_call_reaper",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("Agent scheduler started (calls 10AM-midnight, analytics every 2m, stuck-call reaper every 2m)")


async def agent_shutdown():
    """Call from main app's shutdown event."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
    await release_batch_lock()
    logger.info("Agent scheduler stopped")


async def _scheduled_batch_run():
    await process_batch_run()


async def _scheduled_analytics():
    await process_analytics_batch()

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

        row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
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
                        row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
                        if row and dict(row).get("status") != "Calling":
                            return _row_to_dict(row)
                    # Transcript never arrived
                    await db_pool.execute(
                        """UPDATE agent_calls
                           SET status = 'Not Answered',
                               ended_at = $1, updated_at = $1,
                               error_message = 'Room deleted but no transcript after 60s',
                               retry_count = retry_count + 1
                           WHERE id = $2""",
                        now_ist(), call_uuid,
                    )
                    row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
                    return _row_to_dict(row)
            except Exception:
                pass

    # Global timeout
    await db_pool.execute(
        """UPDATE agent_calls
           SET status = 'Not Answered',
               ended_at = $1, updated_at = $1,
               retry_count = retry_count + 1
           WHERE id = $2""",
        now_ist(), call_uuid,
    )
    row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    return _row_to_dict(row)


async def _publish_batch_update(call: dict) -> None:
    """If the call belongs to a batch, publish a status update to SSE subscribers.
    Uses the shared `batch_pubsub` singleton (NOT `from main import ...`) so the
    subscriber dict is the same one the SSE endpoint writes to even when main.py
    runs as __main__. Swallows any errors — batch SSE is best-effort."""
    batch_id = call.get("batch_id")
    if not batch_id:
        return
    try:
        import batch_pubsub
        await batch_pubsub.publish(str(batch_id), {
            "call_id": str(call.get("id", "")),
            "status": call.get("status"),
            "customer_name": call.get("customer_name"),
            "phone": call.get("phone"),
        })
    except Exception as e:
        logger.debug(f"publish_to_batch skipped: {e}")


async def dispatch_call(call_id: str, wait_for_completion: bool = True) -> dict:
    """LiveKit room + SIP participant + agent dispatch for a single agent_calls row.

    Shared by the batch runner (wait_for_completion=True so we know when to dial
    the next one) and the admin/portal single-call endpoints (wait_for_completion
    =False — agent reports status back via /api/agent/transcript).

    Returns a summary dict with keys: status, room_name?, error?, outcome?"""
    call_uuid = uuid.UUID(call_id)
    row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    if not row:
        return {"status": "not_found"}
    call = _row_to_dict(row)
    name = call.get("customer_name") or "Customer"
    phone = (call.get("phone") or "").strip()

    # Phone validation
    if not phone or len(phone) < 10:
        await db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Invalid Phone', retry_count = retry_count + 1, updated_at = $1
               WHERE id = $2""",
            now_ist(), call_uuid,
        )
        call["status"] = "Invalid Phone"
        await _publish_batch_update(call)
        return {"status": "invalid_phone"}

    call_start = now_ist()
    try:
        await db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Calling', started_at = $1, updated_at = $1
               WHERE id = $2""",
            call_start, call_uuid,
        )
        call["status"] = "Calling"
        await _publish_batch_update(call)

        if DEMO_MODE:
            room_name = f"demo_{secrets.token_hex(6)}_{int(time.time())}"
            await db_pool.execute(
                "UPDATE agent_calls SET room_name = $1 WHERE id = $2",
                room_name, call_uuid,
            )
            await asyncio.sleep(3)

            import random as rng
            interested = rng.choice([True, True, False])
            loan_type = rng.choice(["personal", "business", "education"])
            status = "Called - Interested" if interested else "Called - Not Interested"
            lead_quality = "hot" if interested else "cold"
            demo_transcript = [
                {"role": "agent", "text": f"Hello, am I speaking with {name}?", "timestamp": now_ist_str()},
                {"role": "user", "text": "Yes, speaking.", "timestamp": now_ist_str()},
            ]
            call_end = now_ist()
            duration_seconds = int((call_end - call_start).total_seconds())
            category = "Very Interested - Form Sent" if interested else "Not Interested - No Need Currently"

            await db_pool.execute(
                """UPDATE agent_calls SET
                    transcript = $1, status = $2, call_duration = $3,
                    ended_at = $4, updated_at = $4,
                    interested = $5, loan_type = $6,
                    category = $7,
                    call_analysis = $8,
                    collected_data = $9
                   WHERE id = $10""",
                json.dumps(demo_transcript),
                status,
                duration_seconds,
                call_end,
                interested,
                loan_type if interested else None,
                category,
                json.dumps({"lead_quality": lead_quality, "follow_up_needed": "Yes" if interested else "No"}),
                json.dumps({"loan_type": loan_type}) if interested else None,
                call_uuid,
            )
            call["status"] = status
            await _publish_batch_update(call)
            return {"status": "completed", "outcome": status, "room_name": room_name}

        # --- Real LiveKit + SIP call ---
        room_name = f"los_{secrets.token_hex(6)}_{int(time.time())}"
        lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)

        bank_id_val = call.get("bank_id")
        await lk.room.create_room(api.CreateRoomRequest(
            name=room_name, empty_timeout=300, max_participants=3,
            metadata=json.dumps({
                "customer_name": name,
                "phone": phone,
                "call_id": str(call_uuid),
                "bank_id": str(bank_id_val) if bank_id_val else "",
                "language": call.get("language", "hindi"),
            }),
        ))
        await db_pool.execute(
            "UPDATE agent_calls SET room_name = $1 WHERE id = $2",
            room_name, call_uuid,
        )

        sip_phone = phone if phone.startswith("+") else f"+91{phone[-10:]}"
        participant_identity = f"customer_{name.replace(' ', '_').replace('/', '_')}"
        logger.info(
            "[SIP_DIAL] IN call_id=%s trunk=%s to=%s room=%s identity=%s",
            call_uuid, SIP_TRUNK_ID, sip_phone, room_name, participant_identity,
        )
        try:
            sip_resp = await lk.sip.create_sip_participant(api.CreateSIPParticipantRequest(
                room_name=room_name,
                sip_trunk_id=SIP_TRUNK_ID,
                sip_call_to=sip_phone,
                participant_identity=participant_identity,
                participant_name=name,
                play_ringtone=True,
            ))
            logger.info(
                "[SIP_DIAL] OK call_id=%s sip_call_id=%s participant_id=%s identity=%s",
                call_uuid, sip_resp.sip_call_id, sip_resp.participant_id, sip_resp.participant_identity,
            )
        except Exception as sip_err:
            # Surface every detail Twirp / LiveKit gives us. Viva returns 403
            # when its auth-failed -- we want the sip_status_code visible here
            # without grepping for tracebacks.
            err_str = str(sip_err)
            sip_status = getattr(sip_err, "metadata", {}) or {}
            sip_status_code = sip_status.get("sip_status_code") if isinstance(sip_status, dict) else None
            sip_status_text = sip_status.get("sip_status") if isinstance(sip_status, dict) else None
            logger.error(
                "[SIP_DIAL] FAIL call_id=%s trunk=%s to=%s "
                "exc=%s sip_status_code=%s sip_status=%s err=%s",
                call_uuid, SIP_TRUNK_ID, sip_phone,
                type(sip_err).__name__, sip_status_code, sip_status_text, err_str[:500],
            )
            raise
        # Brief async poll: catch the first state transition Viva reports
        # (ringing -> hangup / busy / no answer) so the next time a call dies
        # silently we have evidence in our own logs, not just the dashboard.
        async def _log_sip_state():
            try:
                from livekit.protocol.room import ListParticipantsRequest
                for delay in (1.5, 4.0, 9.0):
                    await asyncio.sleep(delay)
                    try:
                        parts = await lk.room.list_participants(
                            ListParticipantsRequest(room=room_name))
                        for p in parts.participants:
                            if p.kind == 3:  # SIP participant
                                attrs = dict(p.attributes)
                                logger.info(
                                    "[SIP_STATE] call_id=%s t+%.1fs status=%s code=%s text=%s host=%s",
                                    call_uuid, delay,
                                    attrs.get("sip.callStatus"),
                                    attrs.get("sip.callStatusCode"),
                                    attrs.get("sip.callStatusText"),
                                    attrs.get("sip.hostname"),
                                )
                                # Stop polling once the call reaches a terminal state.
                                if attrs.get("sip.callStatus") in ("hangup", "answered", "active"):
                                    return
                    except Exception as poll_err:
                        logger.debug("[SIP_STATE] poll err: %s", poll_err)
            except Exception:
                pass
        asyncio.create_task(_log_sip_state())

        await asyncio.sleep(1.0)
        await lk.agent_dispatch.create_dispatch(api.CreateAgentDispatchRequest(
            room=room_name, agent_name=AGENT_NAME,
        ))
        logger.info(
            "[DISPATCH] OK call_id=%s room=%s agent_name=%s",
            call_uuid, room_name, AGENT_NAME,
        )
        await lk.aclose()

        if wait_for_completion:
            result = await wait_for_call_completion(str(call_uuid), room_name)
            if result:
                fs = result.get("status", "Unknown")
                call["status"] = fs
                await _publish_batch_update(call)
                if fs in ("Called", "Completed", "Called - Interested", "Called - Not Interested"):
                    return {"status": "completed", "outcome": fs, "room_name": room_name}
                return {"status": "failed", "outcome": fs, "room_name": room_name}
            return {"status": "failed", "room_name": room_name}
        else:
            # Fire-and-forget path for single-call endpoints; completion is
            # reported via /api/agent/transcript from the agent runtime.
            return {"status": "dispatched", "room_name": room_name}

    except Exception as e:
        logger.exception(
            "[DISPATCH] FAIL call_id=%s name=%s phone=%s err=%s",
            call_uuid, name, phone, e,
        )
        await db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Failed', error_message = $1,
                   ended_at = $2, updated_at = $2,
                   retry_count = retry_count + 1
               WHERE id = $3""",
            str(e), now_ist(), call_uuid,
        )
        call["status"] = "Failed"
        await _publish_batch_update(call)
        return {"status": "failed", "error": str(e)}


# Global concurrency clamp for batch dispatch. For now fixed at 1 (sequential);
# set MAX_BATCH_CONCURRENCY=N to allow more — requires also revisiting the
# inter-call sleep below.
MAX_BATCH_CONCURRENCY = int(os.getenv("MAX_BATCH_CONCURRENCY", "1"))


async def process_batch_run(batch_uuid_str: str = None):
    """Batch-based processing — only processes calls belonging to a batch in 'running' state.
    If batch_uuid_str is provided, process that specific batch.
    If None, find the oldest 'running' batch and process it."""
    completed = successful = failed = 0
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
        # Find the batch to process
        if batch_uuid_str:
            batch_row = await db_pool.fetchrow(
                "SELECT * FROM agent_batches WHERE id = $1 AND status = 'running'",
                uuid.UUID(batch_uuid_str),
            )
        else:
            batch_row = await db_pool.fetchrow(
                "SELECT * FROM agent_batches WHERE status = 'running' ORDER BY created_at ASC LIMIT 1"
            )

        if not batch_row:
            await release_batch_lock()
            return  # No running batches — nothing to do (silent, no log spam)

        batch = _row_to_dict(batch_row)
        batch_id = batch["id"]
        # Clamp per-batch concurrency against the global env ceiling.
        batch_max_conc = max(1, min(int(batch.get("max_concurrent") or 1), MAX_BATCH_CONCURRENCY))
        logger.info(f"Processing batch {batch_id} ({batch.get('filename', '?')}) | concurrency={batch_max_conc}")

        # Get pending calls for THIS batch only (using the string batch_id that links calls to batches)
        call_batch_id = batch.get("batch_id") or batch_id
        pending_rows = await db_pool.fetch(
            """SELECT * FROM agent_calls
                WHERE batch_id = $1 AND status IN ('Pending', 'Scheduled')
                ORDER BY created_at ASC LIMIT 50""",
            call_batch_id,
        )

        if not pending_rows:
            # No more pending calls in this batch — mark batch as completed
            await db_pool.execute(
                "UPDATE agent_batches SET status = 'completed', completed = (SELECT COUNT(*) FROM agent_calls WHERE batch_id = $1) WHERE id = $2",
                call_batch_id, uuid.UUID(batch_id),
            )
            logger.info(f"Batch {batch_id} completed — no more pending calls")
            await release_batch_lock()
            return

        pending = [_row_to_dict(r) for r in pending_rows]
        total = len(pending)
        logger.info(f"Batch {batch_id} | {total} pending calls")

        for idx, call in enumerate(pending, 1):
            # Cancellation check — set by POST /api/calls/batch/{id}/cancel
            cancelled_at = await db_pool.fetchval(
                "SELECT cancelled_at FROM agent_batches WHERE id = $1",
                uuid.UUID(batch_id),
            )
            if cancelled_at:
                logger.info(f"Batch {batch_id} cancelled at {cancelled_at} — halting")
                break

            if await is_emergency_stop_active():
                logger.warning("EMERGENCY STOP active -- halting batch")
                break
            if not is_within_calling_hours():
                logger.info("Calling hours ended -- stopping batch")
                break

            result = await dispatch_call(str(call["id"]), wait_for_completion=True)
            rs = result.get("status")
            if rs == "completed":
                successful += 1
            else:
                failed += 1
            completed += 1

            await asyncio.sleep(10)  # pause between calls

    finally:
        # Check if batch has any remaining pending calls
        if batch_row:
            remaining = await db_pool.fetchval(
                "SELECT COUNT(*) FROM agent_calls WHERE batch_id = $1 AND status IN ('Pending', 'Scheduled')",
                call_batch_id,
            )
            if remaining == 0:
                await db_pool.execute(
                    "UPDATE agent_batches SET status = 'completed' WHERE id = $1",
                    uuid.UUID(batch_id),
                )
                logger.info(f"Batch {batch_id} fully completed")
            else:
                logger.info(f"Batch {batch_id} paused — {remaining} calls remaining (will resume next cron)")

        await release_batch_lock()
        logger.info(f"BATCH RUN DONE | Total: {completed} | OK: {successful} | Fail: {failed}")


async def process_analytics_batch():
    """Background LLM analysis of completed call transcripts."""
    if not await acquire_analytics_lock():
        return

    try:
        rows = await db_pool.fetch(
            """SELECT * FROM agent_calls
               WHERE call_analysis IS NULL
                 AND transcript IS NOT NULL AND transcript != '[]'::jsonb
                 AND status IN ('Called', 'Completed', 'Called - Interested', 'Called - Not Interested')
               ORDER BY created_at ASC
               LIMIT 20"""
        )

        if not rows:
            return

        for row in rows:
            call = _row_to_dict(row)
            try:
                transcript = call.get("transcript", [])
                if isinstance(transcript, str):
                    transcript = json.loads(transcript)
                analysis = analyze_transcript_with_llm(transcript)
                summary = f"Category: {analysis.get('category')} | Follow-up: {analysis.get('follow_up_needed')}"
                await db_pool.execute(
                    """UPDATE agent_calls
                       SET category = $1,
                           call_analysis = $2,
                           updated_at = $3
                       WHERE id = $4""",
                    analysis.get("category", "Uncategorized"),
                    json.dumps({
                        "follow_up_needed": analysis.get("follow_up_needed", "No"),
                        "reminder_date": analysis.get("reminder_date"),
                        "how_to_follow_up": analysis.get("how_to_follow_up"),
                        "when_to_follow_up": analysis.get("when_to_follow_up"),
                        "lead_quality": analysis.get("lead_quality"),
                        "summary": summary,
                    }),
                    now_ist(),
                    uuid.UUID(call["id"]),
                )
            except Exception as e:
                logger.error(f"Analytics failed for {call['id']}: {e}")
    finally:
        await release_analytics_lock()

# ============================================================================
# BATCH MANAGEMENT ENDPOINTS
# ============================================================================

@router.post("/upload-excel")
async def upload_excel(
    file: UploadFile = File(...),
    language: str = Query("hindi", description="Agent language"),
    gender: str = Query("male", description="Agent voice gender"),
    background_tasks: BackgroundTasks = None,
    _admin: dict = Depends(require_admin_local),
):
    """Upload Excel/CSV with customer data for batch calling."""
    bank_id = None  # operator — no bank scoping

    try:
        filename = file.filename.lower()
        if not (filename.endswith(".csv") or filename.endswith(".xlsx") or filename.endswith(".xls")):
            raise HTTPException(status_code=400, detail="Only CSV/Excel files allowed")

        contents = await file.read()
        if filename.endswith(".csv"):
            try:
                df = pd.read_csv(io.StringIO(contents.decode("utf-8-sig")))
            except Exception:
                df = pd.read_csv(io.StringIO(contents.decode("latin-1")))
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

        # Insert into agent_batches with batch_id string for linking to agent_calls
        batch_uuid = uuid.uuid4()
        await db_pool.execute(
            """INSERT INTO agent_batches (id, batch_id, bank_id, filename, total_records, completed, failed, status, uploaded_by, created_at)
               VALUES ($1, $2, $3, $4, $5, 0, 0, 'pending', $6, $7)""",
            batch_uuid, batch_id, bank_id_uuid, file.filename, len(records), uploaded_by_uuid, upload_time,
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

            await db_pool.execute(
                """INSERT INTO agent_calls (
                    id, bank_id, batch_id, customer_name, phone, loan_type, loan_amount,
                    language, status, room_name, interested, form_sent,
                    category, transcript, collected_data, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7,
                    $8, 'Pending', $9, false, false,
                    'Uncategorized', '[]'::jsonb, $10, $11, $11
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
            )
            count += 1

        logger.info(f"Uploaded {count} records, batch={batch_id}, bank={bank_id}")

        return {
            "status": "success",
            "batch_id": batch_id,
            "batch_uuid": str(batch_uuid),
            "inserted_count": count,
            "message": f"Uploaded {count} records. Click 'Start Batch' to begin calling.",
            "auto_calling": False,
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
    _admin: dict = Depends(require_admin_local),
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
        batch_row = await db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE id = $1", uuid.UUID(batch_id))
    else:
        batch_row = await db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE status IN ('pending', 'running', 'paused') ORDER BY created_at DESC LIMIT 1")

    if not batch_row:
        raise HTTPException(status_code=404, detail="No pending batch found. Upload a CSV first.")

    # Set batch to "running"
    await db_pool.execute(
        "UPDATE agent_batches SET status = 'running' WHERE id = $1", batch_row["id"])

    # Immediately kick off processing (don't wait for cron)
    background_tasks.add_task(process_batch_run, str(batch_row["id"]))
    return {"status": "started", "message": f"Batch started ({batch_row['total_records']} records)", "batch_id": str(batch_row["id"])}


@router.get("/batch-status")
async def batch_status(
    batch_id: Optional[str] = None,
    _admin: dict = Depends(require_admin_local),
):
    """Check batch completion progress."""
    bank_uuid = None  # operator — no bank scoping
    bk_cond = "bank_id = $1" if bank_uuid else "TRUE"
    bk_params = [bank_uuid] if bank_uuid else []
    offset = len(bk_params)

    if batch_id:
        pending_count = await db_pool.fetchval(
            f"SELECT COUNT(*) FROM agent_calls WHERE {bk_cond} AND batch_id = ${offset+1} AND status IN ('Pending', 'Calling', 'Scheduled')",
            *bk_params, batch_id,
        )
        total_count = await db_pool.fetchval(
            f"SELECT COUNT(*) FROM agent_calls WHERE {bk_cond} AND batch_id = ${offset+1}",
            *bk_params, batch_id,
        )
    else:
        pending_count = await db_pool.fetchval(
            f"SELECT COUNT(*) FROM agent_calls WHERE {bk_cond} AND status IN ('Pending', 'Calling', 'Scheduled')",
            *bk_params,
        )
        total_count = await db_pool.fetchval(
            f"SELECT COUNT(*) FROM agent_calls WHERE {bk_cond}",
            *bk_params,
        )

    return {
        "status": "success",
        "completed": pending_count == 0,
        "message": "All calls completed" if pending_count == 0 else f"{pending_count} calls remaining",
        "pending": pending_count,
        "total": total_count,
    }


@router.post("/batch-retry")
async def trigger_batch_retry(
    background_tasks: BackgroundTasks,
    batch_id: Optional[str] = None,
    _admin: dict = Depends(require_admin_local),
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
        batch_row = await db_pool.fetchrow("SELECT * FROM agent_batches WHERE id = $1", uuid.UUID(batch_id))
    else:
        batch_row = await db_pool.fetchrow(
            "SELECT * FROM agent_batches WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1")

    if not batch_row:
        raise HTTPException(status_code=404, detail="No completed batch found to retry.")

    batch = _row_to_dict(batch_row)
    bid = batch["id"]

    # Reset failed calls in this batch to Pending (only if under retry limit)
    result = await db_pool.execute(
        f"""UPDATE agent_calls SET status = 'Pending'
            WHERE batch_id = $1
            AND status IN ('Not Answered', 'Failed', 'Call Not Connected')
            AND retry_count < {MAX_RETRIES}""",
        batch.get("batch_id") or bid,
    )
    reset_count = int(result.split()[-1]) if result else 0

    if reset_count == 0:
        return {"status": "nothing", "message": "No retriable calls found (all at max retries or already completed)"}

    # Set batch back to running
    await db_pool.execute("UPDATE agent_batches SET status = 'running' WHERE id = $1", uuid.UUID(bid))
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
        active = await db_pool.fetchrow(
            "SELECT id, room_name FROM agent_calls WHERE status = 'Calling' AND bank_id = $1 LIMIT 1", bank_uuid)
    else:
        active = await db_pool.fetchrow(
            "SELECT id, room_name FROM agent_calls WHERE status = 'Calling' LIMIT 1")
    room_deleted = False
    if active and active["room_name"]:
        try:
            lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
            await lk.room.delete_room(api.DeleteRoomRequest(room=active["room_name"]))
            await lk.aclose()
            room_deleted = True
            await db_pool.execute(
                """UPDATE agent_calls
                   SET status = 'Failed', error_message = 'Emergency Stop',
                       ended_at = $1, updated_at = $1
                   WHERE id = $2""",
                now_ist(), active["id"],
            )
        except Exception as e:
            logger.error(f"Failed to delete room during emergency stop: {e}")

    # Pause all running batches
    await db_pool.execute("UPDATE agent_batches SET status = 'paused' WHERE status = 'running'")
    await release_batch_lock()
    return {"status": "success", "message": "Emergency stop activated — all batches paused", "active_call_killed": room_deleted}


@router.post("/resume-calling")
async def resume_calling():
    """Disable emergency stop and resume paused batches."""
    await set_emergency_stop(False)
    result = await db_pool.execute("UPDATE agent_batches SET status = 'running' WHERE status = 'paused'")
    resumed = int(result.split()[-1]) if result else 0
    logger.info(f"Emergency stop deactivated, {resumed} batches resumed")
    return {"status": "success", "message": f"Calling resumed. {resumed} batch(es) reactivated."}

# ============================================================================
# UPLOADS / BATCHES LIST (was missing — needed by dashboard UI)
# ============================================================================

@router.get("/uploads")
async def list_uploads():
    """List all batch uploads."""
    rows = await db_pool.fetch("SELECT * FROM agent_batches ORDER BY created_at DESC LIMIT 50")
    return {"uploads": _rows_to_list(rows)}

@router.get("/upload/{batch_id}")
async def get_upload_detail(batch_id: str):
    """Get calls for a specific batch."""
    rows = await db_pool.fetch(
        "SELECT id, customer_name, phone, status, call_duration, interested, form_sent, created_at FROM agent_calls WHERE batch_id = $1 ORDER BY created_at DESC",
        batch_id,
    )
    return {"calls": _rows_to_list(rows), "batch_id": batch_id, "total": len(rows)}

@router.get("/recent_calls")
async def recent_calls(limit: int = Query(10, ge=1, le=50)):
    """Get recent calls (shortcut for dashboard)."""
    rows = await db_pool.fetch(
        "SELECT * FROM agent_calls ORDER BY created_at DESC LIMIT $1", limit
    )
    return {"calls": [_serialize_call(_row_to_dict(r)) for r in rows]}

# ============================================================================
# CALL MANAGEMENT ENDPOINTS
# ============================================================================

@router.get("/call/{call_id}")
async def get_call_alias(call_id: str):
    """Alias for /calls/{call_id} (reference UI compatibility)."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")
    row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    return _serialize_call(_row_to_dict(row))

@router.get("/call/{call_id}/transcript")
async def get_call_transcript_alias(call_id: str):
    """Alias for /calls/{call_id}/transcript (reference UI compatibility)."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")
    row = await db_pool.fetchrow("SELECT id, customer_name, phone, transcript FROM agent_calls WHERE id = $1", call_uuid)
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    call = _row_to_dict(row)
    transcript = call.get("transcript") or []
    if isinstance(transcript, str):
        transcript = json.loads(transcript)
    return {"call_id": call_id, "name": call.get("customer_name"), "transcript": transcript}

@router.get("/calls")
async def list_calls(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    status: Optional[str] = None,
    category: Optional[str] = None,
    batch_id: Optional[str] = None,
    date: Optional[str] = None,
    lead_quality: Optional[str] = None,
    form_sent: Optional[str] = None,
    # no auth — operator access
):
    """List calls with pagination and filters. Bank-scoped if authenticated, all calls for operators."""
    bank_uuid = None  # operator — no bank scoping
    conditions = []
    params: list = []
    idx = 1
    if bank_uuid:
        conditions.append(f"bank_id = ${idx}")
        params.append(bank_uuid)
        idx += 1

    if status:
        conditions.append(f"status = ${idx}")
        params.append(status)
        idx += 1
    if category:
        conditions.append(f"category = ${idx}")
        params.append(category)
        idx += 1
    if batch_id:
        conditions.append(f"batch_id = ${idx}")
        params.append(batch_id)
        idx += 1
    if lead_quality:
        conditions.append(f"call_analysis->>'lead_quality' = ${idx}")
        params.append(lead_quality)
        idx += 1
    if form_sent in ("yes", "true"):
        conditions.append("form_sent = true")
    elif form_sent in ("no", "false"):
        conditions.append("form_sent = false")
    if date:
        try:
            dt = datetime.strptime(date, "%Y-%m-%d")
            conditions.append(f"created_at >= ${idx} AND created_at < ${idx + 1}")
            params.append(dt)
            params.append(dt + timedelta(days=1))
            idx += 2
        except ValueError:
            pass

    where = " AND ".join(conditions) if conditions else "TRUE"
    total = await db_pool.fetchval(f"SELECT COUNT(*) FROM agent_calls WHERE {where}", *params)
    offset = (page - 1) * page_size

    rows = await db_pool.fetch(
        f"""SELECT * FROM agent_calls WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}""",
        *params, page_size, offset,
    )
    calls = [_serialize_call(_row_to_dict(r)) for r in rows]

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size,
        "calls": calls,
    }


@router.get("/calls/{call_id}")
async def get_call(call_id: str, user: dict = Depends(get_current_bank_user)):
    """Get single call detail."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = None  # operator — no bank scoping
    row = await db_pool.fetchrow(
        "SELECT * FROM agent_calls WHERE id = $1",
        call_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    return _serialize_call(_row_to_dict(row))


@router.get("/calls/{call_id}/transcript")
async def get_call_transcript(call_id: str, user: dict = Depends(get_current_bank_user)):
    """Get transcript for a specific call."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = None  # operator — no bank scoping
    row = await db_pool.fetchrow(
        "SELECT id, customer_name, phone, transcript FROM agent_calls WHERE id = $1",
        call_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    call = _row_to_dict(row)
    return {
        "call_id": call_id,
        "name": call.get("customer_name"),
        "phone": call.get("phone"),
        "transcript": call.get("transcript", []),
    }


@router.get("/calls/{call_id}/recording")
async def get_call_recording(call_id: str, user: dict = Depends(get_current_bank_user)):
    """Get recording URL for a call."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = None  # operator — no bank scoping
    row = await db_pool.fetchrow(
        "SELECT id, customer_name, recording_url FROM agent_calls WHERE id = $1",
        call_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    call = _row_to_dict(row)
    return {
        "call_id": call_id,
        "name": call.get("customer_name"),
        "recording_url": call.get("recording_url"),
    }


@router.put("/calls/{call_id}/categorize")
async def categorize_call(
    call_id: str,
    data: CallCategorizeRequest,
    # no auth — operator access
):
    """Manually categorize / remark a call."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID format")

    bank_uuid = None  # operator — no bank scoping

    # Build the update -- merge remark into call_analysis JSONB
    existing = await db_pool.fetchrow(
        "SELECT call_analysis FROM agent_calls WHERE id = $1",
        call_uuid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Call not found")

    analysis = existing["call_analysis"] or {}
    if isinstance(analysis, str):
        analysis = json.loads(analysis)
    if data.reminder_date:
        analysis["reminder_date"] = data.reminder_date
    if data.after_call_remark:
        analysis["after_call_remark"] = data.after_call_remark

    await db_pool.execute(
        """UPDATE agent_calls
           SET category = $1, call_analysis = $2, updated_at = $3
           WHERE id = $4 AND bank_id = $5""",
        data.category, json.dumps(analysis), now_ist(), call_uuid, bank_uuid,
    )
    return {"status": "updated", "call_id": call_id}

# ============================================================================
# FORM INTEGRATION ENDPOINTS
# ============================================================================

@router.get("/form-data/{call_id}")
async def get_form_data(call_id: str):
    """Return collected lead data for pre-filling a loan form. Public (no auth) so
    the customer can access the form link sent via WhatsApp."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID")

    row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    if not row:
        raise HTTPException(status_code=404, detail="Lead not found")
    call = _row_to_dict(row)
    collected = call.get("collected_data") or {}
    if isinstance(collected, str):
        collected = json.loads(collected)

    return {
        "status": "success",
        "data": {
            "customer_name": call.get("customer_name", ""),
            "phone": call.get("phone", ""),
            "email": collected.get("email", ""),
            "aadhar_number": collected.get("aadhar_number", ""),
            "pan_number": collected.get("pan_number", ""),
            "customer_type": collected.get("customer_type", "new"),
            "loan_type": call.get("loan_type", ""),
            "loan_amount": call.get("loan_amount", ""),
            "employment_type": collected.get("employment_type", ""),
            "employer_name": collected.get("employer_name", ""),
            "monthly_income": collected.get("monthly_income", ""),
            "business_type": collected.get("business_type", ""),
            "age": collected.get("age", ""),
            "address": collected.get("collected_address", ""),
            "designation": collected.get("designation", ""),
            "loan_purpose": collected.get("loan_purpose", ""),
            "lead_quality": (call.get("call_analysis") or {}).get("lead_quality", ""),
            "call_status": call.get("status", ""),
            "bank_id": call.get("bank_id", ""),
        },
    }


@router.post("/submit-form/{call_id}")
async def submit_form(call_id: str, request: Request):
    """Receive submitted form data and update the lead record. Public endpoint."""
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid call ID")

    data = await request.json()
    row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    if not row:
        raise HTTPException(status_code=404, detail="Lead not found")
    call = _row_to_dict(row)

    # Merge form data into collected_data
    existing_collected = call.get("collected_data") or {}
    if isinstance(existing_collected, str):
        existing_collected = json.loads(existing_collected)
    existing_collected.update({
        "email": data.get("email") or existing_collected.get("email", ""),
        "age": data.get("age") or existing_collected.get("age", ""),
        "collected_address": data.get("address") or existing_collected.get("collected_address", ""),
        "aadhar_number": data.get("aadhar_number") or existing_collected.get("aadhar_number", ""),
        "pan_number": data.get("pan_number") or existing_collected.get("pan_number", ""),
        "employment_type": data.get("employment_type") or existing_collected.get("employment_type", ""),
        "monthly_income": data.get("monthly_income") or existing_collected.get("monthly_income", ""),
        "employer_name": data.get("employer_name") or existing_collected.get("employer_name", ""),
        "designation": data.get("designation") or existing_collected.get("designation", ""),
        "loan_purpose": data.get("loan_purpose") or existing_collected.get("loan_purpose", ""),
        "form_submitted": True,
        "form_submission_time": now_ist().isoformat(),
        "otp_verified": data.get("otp_verified", False),
        "form_data": data,
    })

    # Update call_analysis to mark as hot lead
    existing_analysis = call.get("call_analysis") or {}
    if isinstance(existing_analysis, str):
        existing_analysis = json.loads(existing_analysis)
    existing_analysis["lead_quality"] = "hot"

    await db_pool.execute(
        """UPDATE agent_calls SET
            loan_type = COALESCE($1, loan_type),
            loan_amount = COALESCE($2, loan_amount),
            collected_data = $3,
            call_analysis = $4,
            form_sent = true,
            updated_at = $5
           WHERE id = $6""",
        data.get("loan_type") or None,
        float(data["loan_amount"]) if data.get("loan_amount") and str(data["loan_amount"]).strip() else None,
        json.dumps(existing_collected),
        json.dumps(existing_analysis),
        now_ist(),
        call_uuid,
    )
    logger.info(f"Form submitted for lead {call_id} - {call.get('customer_name', 'Unknown')}")
    return {"status": "success", "message": "Application submitted successfully"}

# ============================================================================
# TRANSCRIPT WEBHOOK (called by voice agent, no bank auth needed)
# ============================================================================

class TranscriptChunkPayload(BaseModel):
    call_id: Optional[str] = None
    room: Optional[str] = None
    role: str  # 'agent' | 'user'
    text: str
    language: Optional[str] = None
    timestamp: Optional[str] = None
    final: bool = True


@router.post("/transcript-chunk")
async def save_transcript_chunk(data: TranscriptChunkPayload):
    """Incremental transcript update — publish to live SSE subscribers only.
    The voice agent MAY call this per turn to drive true live transcripts.
    DB is not updated here; the final /transcript call persists the full transcript."""
    call_uuid = None
    if data.call_id:
        try:
            call_uuid = uuid.UUID(data.call_id)
        except ValueError:
            pass
    if not call_uuid and data.room:
        row = await db_pool.fetchrow("SELECT id FROM agent_calls WHERE room_name = $1", data.room)
        if row:
            call_uuid = row["id"]
    if not call_uuid:
        logger.warning(
            "[WEBHOOK] /transcript-chunk NOT_IDENTIFIED call_id=%s room=%s role=%s",
            data.call_id, data.room, data.role,
        )
        return {"status": "error", "message": "call not identified"}

    try:
        import call_pubsub
        await call_pubsub.publish(str(call_uuid), {
            "role": data.role,
            "text": data.text,
            "language": data.language,
            "timestamp": data.timestamp,
            "final": data.final,
        })
        # Keep per-chunk logs at DEBUG so they don't drown prod logs.
        logger.debug(
            "[WEBHOOK] /transcript-chunk call_id=%s role=%s chars=%d",
            call_uuid, data.role, len(data.text or ""),
        )
    except Exception as e:
        logger.error(
            "[WEBHOOK] /transcript-chunk ERR call_id=%s role=%s err=%s",
            call_uuid, data.role, e,
        )
        return {"status": "error", "message": str(e)}
    return {"status": "ok"}


@router.post("/transcript")
async def save_transcript(data: TranscriptPayload):
    """Save transcript from the voice agent. This is a webhook -- no JWT auth."""
    transcript = [item.model_dump() for item in data.transcript]
    room = data.room

    logger.info(
        "[WEBHOOK] /transcript IN call_id=%s room=%s msgs=%d interested=%s",
        data.call_id, room, len(transcript), data.customer_interested,
    )

    # Determine query target (prefer call_id)
    call_uuid = None
    if data.call_id:
        try:
            call_uuid = uuid.UUID(data.call_id)
        except ValueError:
            pass

    # Look up the call
    if call_uuid:
        call_row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    else:
        call_row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE room_name = $1", room)

    if not call_row:
        logger.warning(
            "[WEBHOOK] /transcript NOT_FOUND call_id=%s room=%s -- no matching agent_calls row",
            data.call_id, room,
        )
        return {"status": "error", "message": "Call not found"}

    call = _row_to_dict(call_row)
    actual_uuid = uuid.UUID(call["id"])

    # Determine status from transcript content
    if transcript:
        status = "Called - Interested" if data.customer_interested else "Called - Not Interested"
    else:
        status = "Not Answered"

    recording_url = f"{RECORDING_BASE_URL}{data.recording_path}" if data.recording_path and RECORDING_BASE_URL else None

    # Calculate duration
    duration_seconds = 0
    if call.get("started_at"):
        try:
            start = call["started_at"]
            if isinstance(start, str):
                start = datetime.fromisoformat(start)
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc).astimezone(IST)
            duration_seconds = int((now_ist() - start).total_seconds())
        except Exception:
            pass

    # Build collected_data from qualification fields
    existing_collected = call.get("collected_data") or {}
    if isinstance(existing_collected, str):
        existing_collected = json.loads(existing_collected)
    qualification_data = {
        "customer_type": data.customer_type or existing_collected.get("customer_type"),
        "employment_type": data.employment_type or existing_collected.get("employment_type"),
        "business_type": data.business_type or existing_collected.get("business_type"),
        "monthly_income": data.monthly_income or existing_collected.get("monthly_income"),
        "interest_reason": data.interest_reason or existing_collected.get("interest_reason"),
        "age": data.age or existing_collected.get("age"),
        "loan_purpose": data.loan_purpose or existing_collected.get("loan_purpose"),
        "employer_name": data.employer_name or existing_collected.get("employer_name"),
        "designation": data.designation or existing_collected.get("designation"),
        "existing_emi": data.existing_emi or existing_collected.get("existing_emi"),
        "business_age": data.business_age or existing_collected.get("business_age"),
        "monthly_turnover": data.monthly_turnover or existing_collected.get("monthly_turnover"),
        "collected_address": data.collected_address or existing_collected.get("collected_address"),
    }
    existing_collected.update({k: v for k, v in qualification_data.items() if v})

    category = "Uncategorized" if transcript else "Call Not Connected"

    await db_pool.execute(
        """UPDATE agent_calls SET
            transcript = $1,
            status = $2,
            recording_url = $3,
            ended_at = $4,
            call_duration = $5,
            updated_at = $4,
            interested = $6,
            form_sent = $7,
            loan_type = COALESCE($8, loan_type),
            loan_amount = COALESCE($9, loan_amount),
            collected_data = $10,
            category = $11,
            call_analysis = NULL
           WHERE id = $12""",
        json.dumps(transcript),
        status,
        recording_url,
        now_ist(),
        duration_seconds,
        data.customer_interested,
        data.whatsapp_form_sent,
        data.loan_type or None,
        float(data.loan_amount) if data.loan_amount and str(data.loan_amount).strip() else None,
        json.dumps(existing_collected),
        category,
        actual_uuid,
    )
    logger.info(
        "[WEBHOOK] /transcript SAVED call_id=%s room=%s status=%s duration_s=%d msgs=%d",
        actual_uuid, room, status, duration_seconds, len(transcript),
    )

    # Publish each transcript entry so SSE subscribers see the full conversation
    # and mark the call as ended so live streams terminate cleanly.
    try:
        import call_pubsub
        for entry in transcript:
            await call_pubsub.publish(str(actual_uuid), entry)
        call_pubsub.mark_ended(str(actual_uuid))
    except Exception as e:
        logger.warning("[WEBHOOK] /transcript pubsub publish failed call_id=%s err=%s", actual_uuid, e)

    # ── If a loan_application was created from this call, backfill with collected data ──
    try:
        app_row = await db_pool.fetchrow(
            "SELECT id FROM loan_applications WHERE agent_call_id = $1", actual_uuid)
        if app_row:
            from main import save_field_sources

            def _parse_num(val):
                if not val: return None
                cleaned = "".join(c for c in str(val) if c.isdigit() or c == ".")
                try: return float(cleaned) if cleaned else None
                except ValueError: return None

            await db_pool.execute(
                """UPDATE loan_applications SET
                    employer_name = COALESCE($1, employer_name),
                    designation = COALESCE($2, designation),
                    employment_type = COALESCE($3, employment_type),
                    monthly_gross_income = COALESCE($4, monthly_gross_income),
                    monthly_emi_existing = COALESCE($5, monthly_emi_existing),
                    current_address = COALESCE($6, current_address),
                    purpose_of_loan = COALESCE($7, purpose_of_loan),
                    loan_amount_requested = COALESCE($8, loan_amount_requested),
                    industry_type = COALESCE($9, industry_type),
                    customer_type = COALESCE($10, customer_type)
                WHERE id = $11""",
                existing_collected.get("employer_name") or None,
                existing_collected.get("designation") or None,
                existing_collected.get("employment_type") or None,
                _parse_num(existing_collected.get("monthly_income")),
                _parse_num(existing_collected.get("existing_emi")),
                existing_collected.get("collected_address") or None,
                existing_collected.get("loan_purpose") or None,
                _parse_num(data.loan_amount),
                existing_collected.get("business_type") or None,
                existing_collected.get("customer_type") or None,
                app_row["id"],
            )
            # Save field_sources for Voice Call badges
            source_fields = {}
            field_map = {
                "employer_name": existing_collected.get("employer_name"),
                "designation": existing_collected.get("designation"),
                "employment_type": existing_collected.get("employment_type"),
                "monthly_gross_income": existing_collected.get("monthly_income"),
                "monthly_emi_existing": existing_collected.get("existing_emi"),
                "current_address": existing_collected.get("collected_address"),
                "purpose_of_loan": existing_collected.get("loan_purpose"),
                "industry_type": existing_collected.get("business_type"),
                "customer_type": existing_collected.get("customer_type"),
            }
            for field, value in field_map.items():
                if value and str(value).strip():
                    source_fields[field] = value
            if source_fields:
                await save_field_sources(app_row["id"], "agent_call", source_fields)
            logger.info(f"Backfilled loan_application {app_row['id']} with {len(source_fields)} fields from call data")
    except Exception as e:
        logger.warning(f"Could not backfill loan_application: {e}")

    return {"status": "success", "room": room, "updated": True}

# ============================================================================
# WHATSAPP FORM LINK (called by voice agent)
# ============================================================================

@router.post("/send-whatsapp-form")
async def send_whatsapp_form(request: Request):
    """Triggered by the AI voice agent's send_form_link tool.
    Creates a loan_application from call data (so OTP flow works),
    saves field_sources for 'Voice Call' badges, and sends WhatsApp."""
    import aiohttp
    from main import save_field_sources

    data = await request.json()
    phone = data.get("phone")
    customer_name = data.get("customer_name")
    loan_type = data.get("loan_type", "")
    call_id = data.get("call_id")

    # ── 1. Fetch call data ──
    call_row = None
    call_uuid = None
    collected = {}
    if call_id:
        try:
            call_uuid = uuid.UUID(call_id)
            call_row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
            if call_row:
                cd = call_row["collected_data"]
                if isinstance(cd, str):
                    cd = json.loads(cd)
                collected = cd if isinstance(cd, dict) else {}
        except Exception as e:
            logger.warning(f"Could not fetch call data: {e}")

    # ── 2. Normalize phone ──
    if phone and not phone.startswith("+"):
        phone = f"+91{phone[-10:]}"
    phone_clean_digits = "".join(filter(str.isdigit, str(phone or "")))
    if len(phone_clean_digits) == 10:
        phone_norm = f"+91{phone_clean_digits}"
    elif phone_clean_digits.startswith("91") and len(phone_clean_digits) == 12:
        phone_norm = f"+{phone_clean_digits}"
    else:
        phone_norm = phone or ""

    # ── 3. Create loan_application (bridge: agent_calls → loan system) ──
    app_id = None
    # Append phone as query param so the OTP page auto-fills and auto-sends.
    # Take the last 10 digits — handles +91/91 prefixes without the str.lstrip
    # character-class footgun (lstrip("91") strips any leading 9s and 1s).
    _digits = ''.join(c for c in (phone_norm or '') if c.isdigit())
    bare_phone = _digits[-10:] if len(_digits) >= 10 else _digits
    form_url = f"{FORM_BASE_URL}/loan-form?phone={bare_phone}" if bare_phone else f"{FORM_BASE_URL}/loan-form"

    if phone_norm:
        # Check if application already exists for this phone
        existing_app = await db_pool.fetchrow(
            "SELECT id FROM loan_applications WHERE phone = $1 AND status != 'submitted' ORDER BY created_at DESC LIMIT 1",
            phone_norm,
        )

        if existing_app:
            app_id = existing_app["id"]
            logger.info(f"Existing application found for {phone_norm}: {app_id}")
        else:
            # Create new loan_application pre-filled from call data
            loan_id = f"AGENT-{secrets.token_hex(4)}-{int(time.time())}"
            bank_id = None
            if call_row and call_row.get("bank_id"):
                try:
                    bank_id = uuid.UUID(str(call_row["bank_id"])) if call_row["bank_id"] else None
                except Exception:
                    pass

            # Parse numeric fields safely
            def parse_num(val):
                if not val:
                    return None
                cleaned = "".join(c for c in str(val) if c.isdigit() or c == ".")
                try:
                    return float(cleaned) if cleaned else None
                except ValueError:
                    return None

            loan_amount = parse_num(call_row["loan_amount"] if call_row else None) or parse_num(collected.get("loan_amount"))
            monthly_income = parse_num(collected.get("monthly_income"))
            existing_emi = parse_num(collected.get("existing_emi"))

            try:
                row = await db_pool.fetchrow(
                    """INSERT INTO loan_applications (
                        customer_name, phone, loan_id, current_step, status, last_saved_at, bank_id,
                        agent_call_id, full_name, employer_name, designation, employment_type,
                        monthly_gross_income, monthly_emi_existing, current_address,
                        purpose_of_loan, loan_amount_requested, customer_type, industry_type
                    ) VALUES (
                        $1, $2, $3, 1, 'draft', $4, $5,
                        $6, $7, $8, $9, $10,
                        $11, $12, $13,
                        $14, $15, $16, $17
                    ) RETURNING id""",
                    customer_name or "Customer",
                    phone_norm,
                    loan_id,
                    now_ist(),
                    bank_id,
                    call_uuid,
                    customer_name or "",
                    collected.get("employer_name") or None,
                    collected.get("designation") or None,
                    collected.get("employment_type") or None,
                    monthly_income,
                    existing_emi,
                    collected.get("collected_address") or None,
                    collected.get("loan_purpose") or None,
                    loan_amount,
                    collected.get("customer_type") or "new",
                    collected.get("business_type") or None,
                )
                app_id = row["id"]
                logger.info(f"Created loan_application {app_id} for {phone_norm} from call {call_id}")

                # Save field_sources for "Voice Call" badges
                source_fields = {}
                field_map = {
                    "employer_name": collected.get("employer_name"),
                    "designation": collected.get("designation"),
                    "employment_type": collected.get("employment_type"),
                    "monthly_gross_income": str(monthly_income) if monthly_income else None,
                    "monthly_emi_existing": str(existing_emi) if existing_emi else None,
                    "current_address": collected.get("collected_address"),
                    "purpose_of_loan": collected.get("loan_purpose"),
                    "loan_amount_requested": str(loan_amount) if loan_amount else None,
                    "customer_type": collected.get("customer_type"),
                    "industry_type": collected.get("business_type"),
                    "customer_name": customer_name,
                    "full_name": customer_name,
                }
                for field, value in field_map.items():
                    if value and str(value).strip():
                        source_fields[field] = value
                if source_fields:
                    await save_field_sources(app_id, "agent_call", source_fields)

            except Exception as e:
                logger.error(f"Failed to create loan_application: {e}")

        # Link agent_call → application
        if app_id and call_uuid:
            await db_pool.execute(
                "UPDATE agent_calls SET application_id = $1 WHERE id = $2",
                app_id, call_uuid,
            )

    # ── 4. Send WhatsApp via AiSensy ──
    notification_message = (
        f"Dear {customer_name},\n\n"
        f"Thank you for your interest in a {loan_type} loan.\n"
        f"Please click the link below to complete your application:\n"
        f"{form_url}\n"
        f"An OTP will be sent to your WhatsApp automatically."
    )
    print(f"[AiSensy Form] notification for {customer_name} ({phone_norm}) -> {form_url}", flush=True)
    logger.info(f"Form notification for {customer_name} ({phone_norm}): {form_url}")

    aisensy_ok = False
    if AISENSY_API_KEY and phone_norm:
        wa_phone = "".join(filter(str.isdigit, phone_norm))
        if len(wa_phone) == 10:
            wa_phone = f"91{wa_phone}"

        first_name = customer_name.strip().split()[0] if customer_name else "Customer"
        # 3rd param = bare_phone so the AiSensy template can render a URL button
        # like https://virtualvaani.vgipl.com/?phone={{3}} for auto-OTP flow.
        # Harmless until the template is updated; AiSensy silently ignores extras.
        payload = {
            "apiKey": AISENSY_API_KEY,
            "campaignName": AISENSY_CAMPAIGN_NAME,
            "destination": wa_phone,
            "userName": AISENSY_USERNAME,
            "templateParams": [first_name, bare_phone or ""],
            "source": "loan-voice-agent",
            "media": {"url": AISENSY_IMAGE_URL, "filename": "loan_form"},
            "buttons": [], "carouselCards": [], "location": {}, "attributes": {},
            "paramsFallbackValue": {"FirstName": "Customer"},
        }
        # ── Print the outbound payload (minus the API key) so we can debug in journalctl ──
        _debug_payload = {k: ("<redacted>" if k == "apiKey" else v) for k, v in payload.items()}
        print(f"[AiSensy Form] POST campaign={AISENSY_CAMPAIGN_NAME} dest={wa_phone} payload={_debug_payload}", flush=True)
        try:
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    "https://backend.api-wa.co/campaign/virtual-galaxy-infotech/api/v2",
                    json=payload, timeout=aiohttp.ClientTimeout(total=10), ssl=False,
                ) as resp:
                    aisensy_ok = resp.status == 200
                    body = await resp.text()
                    print(f"[AiSensy Form] response status={resp.status} body={body}", flush=True)
                    logger.info(f"AiSensy {wa_phone}: {resp.status} | {body}")
        except Exception as e:
            print(f"[AiSensy Form] EXCEPTION: {type(e).__name__}: {e}", flush=True)
            logger.error(f"AiSensy failed: {e}")
    else:
        print(f"[AiSensy Form] SKIPPED — api_key_set={bool(AISENSY_API_KEY)} phone_set={bool(phone_norm)}", flush=True)

    # ── 5. Update agent_calls ──
    if call_uuid:
        try:
            row = await db_pool.fetchrow("SELECT call_analysis FROM agent_calls WHERE id = $1", call_uuid)
            analysis = {}
            if row and row["call_analysis"]:
                analysis = row["call_analysis"] if isinstance(row["call_analysis"], dict) else json.loads(row["call_analysis"])
            analysis["lead_quality"] = "hot"
            analysis["notification_status"] = "sent_via_aisensy" if aisensy_ok else "aisensy_failed"
            analysis["notification_time"] = now_ist().isoformat()

            await db_pool.execute(
                """UPDATE agent_calls SET form_sent = true, form_link = $1,
                   call_analysis = $2, updated_at = $3 WHERE id = $4""",
                form_url, json.dumps(analysis), now_ist(), call_uuid,
            )
        except Exception as e:
            logger.warning(f"Could not update agent_calls: {e}")

    return {
        "status": "success",
        "message": "Form link sent" if aisensy_ok else "Form created (WhatsApp delivery failed)",
        "form_url": form_url,
        "application_id": str(app_id) if app_id else None,
    }

# ============================================================================
# ANALYTICS ENDPOINTS
# ============================================================================

@router.get("/dashboard-stats")
async def get_dashboard_stats(
    date: Optional[str] = None,
    # no auth — operator access
):
    """Dashboard statistics (all calls, no bank scoping)."""
    date_clause = ""
    params: list = []
    idx = 1

    if date:
        try:
            dt = datetime.strptime(date, "%Y-%m-%d")
            date_clause = f" AND created_at >= ${idx} AND created_at < ${idx + 1}"
            params.append(dt)
            params.append(dt + timedelta(days=1))
            idx += 2
        except ValueError:
            pass

    base = f"SELECT COUNT(*) FROM agent_calls WHERE TRUE{date_clause}"

    total = await db_pool.fetchval(base, *params)
    whatsapp_forms_sent = await db_pool.fetchval(f"{base} AND form_sent = true", *params)
    hot_leads = await db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'hot'", *params)
    warm_leads = await db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'warm'", *params)
    pending_calls = await db_pool.fetchval(f"{base} AND status = 'Pending'", *params)
    not_answered = await db_pool.fetchval(
        f"{base} AND status IN ('Not Answered', 'Failed', 'Invalid Phone', 'Call Not Connected')", *params
    )
    education_loans = await db_pool.fetchval(f"{base} AND loan_type = 'education'", *params)
    business_loans = await db_pool.fetchval(f"{base} AND loan_type = 'business'", *params)
    personal_loans = await db_pool.fetchval(f"{base} AND loan_type = 'personal'", *params)

    stats = {
        "total_calls": total,
        "whatsapp_forms_sent": whatsapp_forms_sent,
        "hot_leads": hot_leads,
        "warm_leads": warm_leads,
        "pending_calls": pending_calls,
        "not_answered": not_answered,
        "loan_interests": {
            "education": education_loans,
            "business": business_loans,
            "personal": personal_loans,
        },
        "calling_hours": {
            "start": f"{CALL_START_HOUR}:00 IST",
            "end": f"{CALL_END_HOUR % 24 or 24}:00 IST",
            "currently_active": is_within_calling_hours(),
        },
    }

    # Breakdowns
    by_status = {}
    for s in STATUS_OPTIONS:
        by_status[s] = await db_pool.fetchval(f"{base} AND status = ${idx}", *params, s)
    stats["by_status"] = by_status

    by_category = {}
    for c in CATEGORY_OPTIONS:
        by_category[c] = await db_pool.fetchval(f"{base} AND category = ${idx}", *params, c)
    stats["by_category"] = by_category

    return {"date": date or now_ist().strftime("%Y-%m-%d"), **stats}


@router.get("/analytics")
async def get_analytics():
    """Analytics summary (all calls)."""
    base = "SELECT COUNT(*) FROM agent_calls WHERE TRUE"

    total = await db_pool.fetchval(base)
    forms_sent = await db_pool.fetchval(f"{base} AND form_sent = true")
    interested = await db_pool.fetchval(f"{base} AND interested = true")
    success_rate = await db_pool.fetchval(
        f"{base} AND status IN ('Called', 'Completed', 'Called - Interested', 'Called - Not Interested')")
    failure_rate = await db_pool.fetchval(
        f"{base} AND status IN ('Failed', 'Not Answered', 'Call Not Connected')")
    hot = await db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'hot'")
    warm = await db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'warm'")
    cold = await db_pool.fetchval(f"{base} AND call_analysis->>'lead_quality' = 'cold'")
    edu = await db_pool.fetchval(f"{base} AND loan_type = 'education'")
    biz = await db_pool.fetchval(f"{base} AND loan_type = 'business'")
    per = await db_pool.fetchval(f"{base} AND loan_type = 'personal'")

    return {
        "total_calls_made": total,
        "forms_sent": forms_sent,
        "interested_customers": interested,
        "success_rate": success_rate,
        "failure_rate": failure_rate,
        "lead_quality": {"hot": hot, "warm": warm, "cold": cold},
        "loan_types": {"education": edu, "business": biz, "personal": per},
    }

# ============================================================================
# EXPORT ENDPOINTS
# ============================================================================

@router.get("/export/daily-report")
async def export_daily_report(
    date: Optional[str] = None,
    # no auth — operator access
):
    """Export daily report as Excel."""
    bank_uuid = None  # operator — no bank scoping
    if not date:
        date = now_ist().strftime("%Y-%m-%d")
    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format (YYYY-MM-DD)")

    rows = await db_pool.fetch(
        """SELECT * FROM agent_calls
           WHERE created_at >= $1 AND created_at < $2
           ORDER BY created_at DESC""",
        dt, dt + timedelta(days=1),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="No data for this date")

    report_rows = []
    for r in rows:
        c = _row_to_dict(r)
        report_rows.append({
            "Name": c.get("customer_name", ""),
            "Phone": c.get("phone", ""),
            "Status": c.get("status", ""),
            "Category": c.get("category", ""),
            "Lead Quality": (c.get("call_analysis") or {}).get("lead_quality", ""),
            "Duration (sec)": c.get("call_duration", ""),
            "Call Time": str(c.get("started_at", ""))[:19] if c.get("started_at") else "",
        })

    df = pd.DataFrame(report_rows)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Daily Report")
    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=agent_report_{date}.xlsx"},
    )


@router.get("/export/all-calls")
async def export_all_calls(
    status: Optional[str] = None,
    category: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    # no auth — operator access
):
    """Comprehensive Excel export with all call data."""
    bank_uuid = None  # operator — no bank scoping
    conditions = ["bank_id = $1"]
    params: list = [bank_uuid]
    idx = 2

    if status:
        conditions.append(f"status = ${idx}")
        params.append(status)
        idx += 1
    if category:
        conditions.append(f"category = ${idx}")
        params.append(category)
        idx += 1
    if date_from:
        try:
            conditions.append(f"created_at >= ${idx}")
            params.append(datetime.strptime(date_from, "%Y-%m-%d"))
            idx += 1
        except ValueError:
            pass
    if date_to:
        try:
            conditions.append(f"created_at < ${idx}")
            params.append(datetime.strptime(date_to, "%Y-%m-%d") + timedelta(days=1))
            idx += 1
        except ValueError:
            pass

    where = " AND ".join(conditions)
    rows = await db_pool.fetch(
        f"SELECT * FROM agent_calls WHERE {where} ORDER BY created_at DESC",
        *params,
    )
    if not rows:
        raise HTTPException(status_code=404, detail="No data found")

    export_rows = []
    for r in rows:
        c = _row_to_dict(r)
        collected = c.get("collected_data") or {}
        if isinstance(collected, str):
            collected = json.loads(collected)
        analysis = c.get("call_analysis") or {}
        if isinstance(analysis, str):
            analysis = json.loads(analysis)

        export_rows.append({
            "Call ID": c.get("id", ""),
            "Name": c.get("customer_name", ""),
            "Phone": c.get("phone", ""),
            "Email": collected.get("email", ""),
            "Age": collected.get("age", ""),
            "Address": collected.get("collected_address", ""),
            "Aadhaar": collected.get("aadhar_number", ""),
            "PAN": collected.get("pan_number", ""),
            "Customer Type": collected.get("customer_type", ""),
            "Status": c.get("status", ""),
            "Category": c.get("category", ""),
            "Lead Quality": analysis.get("lead_quality", ""),
            "Interested": "Yes" if c.get("interested") else "No",
            "Loan Type": c.get("loan_type", ""),
            "Loan Amount": c.get("loan_amount", ""),
            "Loan Purpose": collected.get("loan_purpose", ""),
            "Employment": collected.get("employment_type", ""),
            "Employer": collected.get("employer_name", ""),
            "Designation": collected.get("designation", ""),
            "Monthly Income": collected.get("monthly_income", ""),
            "WhatsApp Form Sent": "Yes" if c.get("form_sent") else "No",
            "Form Submitted": "Yes" if collected.get("form_submitted") else "No",
            "Follow-up Needed": analysis.get("follow_up_needed", ""),
            "Reminder Date": analysis.get("reminder_date", ""),
            "Duration (sec)": c.get("call_duration", ""),
            "Retry Count": c.get("retry_count", 0),
            "Batch ID": c.get("batch_id", ""),
            "Call Start": str(c.get("started_at", ""))[:19] if c.get("started_at") else "",
            "Call End": str(c.get("ended_at", ""))[:19] if c.get("ended_at") else "",
            "Created At": str(c.get("created_at", ""))[:19] if c.get("created_at") else "",
        })

    df = pd.DataFrame(export_rows)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="All Calls")
        ws = writer.sheets["All Calls"]
        for col_idx, col in enumerate(df.columns):
            max_len = max(df[col].astype(str).apply(len).max(), len(col)) + 2
            letter = chr(65 + col_idx) if col_idx < 26 else chr(64 + col_idx // 26) + chr(65 + col_idx % 26)
            ws.column_dimensions[letter].width = min(max_len, 50)
    output.seek(0)

    fname = f"agent_calls_{now_ist().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )

# ============================================================================
# STATUS ENDPOINTS
# ============================================================================

@router.get("/live-status")
async def get_live_status(user: dict = Depends(get_current_bank_user)):
    """Get current calling status -- which customer is being called right now."""
    bank_uuid = None  # operator — no bank scoping
    row = await db_pool.fetchrow(
        """SELECT id, customer_name, phone, started_at FROM agent_calls
           WHERE status = 'Calling' AND bank_id = $1 LIMIT 1""",
        bank_uuid,
    )

    if not row:
        return {
            "status": "idle",
            "message": "No active call",
            "current_call": None,
            "calling_hours_active": is_within_calling_hours(),
        }

    active = _row_to_dict(row)
    duration = None
    if active.get("started_at"):
        try:
            start = datetime.fromisoformat(active["started_at"])
            if start.tzinfo is None:
                start = start.replace(tzinfo=IST)
            duration = int((now_ist() - start).total_seconds())
        except Exception:
            pass

    return {
        "status": "active",
        "message": "Call in progress",
        "current_call": {
            "id": active["id"],
            "name": active.get("customer_name", ""),
            "phone": active.get("phone", ""),
            "duration_seconds": duration,
        },
        "calling_hours_active": is_within_calling_hours(),
    }


@router.post("/stale-cleanup")
async def stale_cleanup(user: dict = Depends(get_current_bank_user)):
    """Clean up calls stuck in 'Calling' status."""
    bank_uuid = None  # operator — no bank scoping

    # 1. Delete broken calls (no room_name)
    del_result = await db_pool.execute(
        """DELETE FROM agent_calls
           WHERE status = 'Calling'
                 AND (room_name IS NULL OR room_name = '')""",
    )
    deleted = int(del_result.split()[-1]) if del_result else 0

    # 2. Fail old stuck calls (>10 min)
    ten_min_ago = now_ist() - timedelta(minutes=10)
    upd_result = await db_pool.execute(
        """UPDATE agent_calls
           SET status = 'Failed', error_message = 'Manual cleanup - stuck call',
               ended_at = $1, updated_at = $1
           WHERE status = 'Calling' AND started_at < $2""",
        now_ist(), ten_min_ago,
    )
    cleaned = int(upd_result.split()[-1]) if upd_result else 0

    await release_batch_lock()

    return {
        "status": "success",
        "message": f"Deleted {deleted} broken, failed {cleaned} stuck calls.",
        "deleted": deleted,
        "failed_updated": cleaned,
    }
