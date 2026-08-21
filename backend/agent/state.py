# backend/agent/state.py
# Shared foundation for all backend/agent modules.
# Contains: config constants, db pool, in-process state, time helpers,
# row serialization, auth helpers, and Pydantic models.

import os
import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import pytz
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import jwt as pyjwt

# ── Config ────────────────────────────────────────────────────────────────────

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

# Union Bank agent
UNION_BANK_AGENT_NAME = os.getenv("UNION_BANK_AGENT_NAME", "union-bank-account-opening")
UNION_BANK_NAME = "Union Bank of India"

# Recording server base URL (GPU box serving recordings)
RECORDING_BASE_URL = os.getenv("RECORDING_BASE_URL", "")

# AiSensy WhatsApp
AISENSY_API_KEY = os.getenv("AISENSY_API_KEY", "")
AISENSY_CAMPAIGN_NAME = os.getenv("AISENSY_FORM_CAMPAIGN", os.getenv("AISENSY_CAMPAIGN_NAME", "form_link"))
AISENSY_USERNAME = os.getenv("AISENSY_USERNAME", "Virtual Galaxy WABA")
AISENSY_IMAGE_URL = os.getenv(
    "AISENSY_IMAGE_URL",
    "https://d3jt6ku4g6z5l8.cloudfront.net/IMAGE/6353da2e153a147b991dd812/4958901_highanglekidcheatingschooltestmin.jpg",
)

# Form URL (the LOS frontend)
FORM_BASE_URL = os.getenv("FORM_BASE_URL", "https://virtualvaani.vgipl.com:3001")

# JWT -- reuse the same secret as main.py
# JWT — same value main.py validates. This module keeps its own copy because it
# must not import main (circular), but the dev fallback used to be silent here:
# main.py refuses to boot in prod/staging with the placeholder secret while this
# copy would happily verify tokens signed with the public, guessable literal.
# Mirror the guard so the two can never disagree about what is acceptable.
_INSECURE_JWT_DEFAULT = "your-jwt-secret-key"
JWT_SECRET = os.getenv("JWT_SECRET", _INSECURE_JWT_DEFAULT)
if os.getenv("LOS_ENV", "dev").lower() in {"prod", "production", "staging"} and (
    JWT_SECRET == _INSECURE_JWT_DEFAULT or len(JWT_SECRET) < 32
):
    raise RuntimeError(
        "JWT_SECRET must be set to a strong (>=32 char) value when LOS_ENV is prod/staging"
    )

# Call time window (IST) — this is the LEGAL CAP (RBI/TRAI). Outbound calling for
# loans must stay inside daytime hours; midnight calling is non-compliant. Both
# ends are env-overridable, but the defaults are the compliant window. A bank may
# NARROW this via bank_settings.calling_window_start/end but never widen past it.
CALL_START_HOUR = int(os.getenv("CALL_START_HOUR", "10"))  # 10 AM
CALL_END_HOUR = int(os.getenv("CALL_END_HOUR", "19"))      # 7 PM (RBI/TRAI-compliant)
MAX_RETRIES = int(os.getenv("MAX_CALL_RETRIES", "2"))       # max retry attempts AFTER initial dial

IST = pytz.timezone("Asia/Kolkata")

logger = logging.getLogger("agent-routes")

# ── Status & Category constants ───────────────────────────────────────────────

STATUS_OPTIONS = [
    "Pending", "Calling", "Called", "Called - Interested", "Called - Not Interested",
    "Called - Callback Requested",          # customer asked to be re-dialled at a specific time
    "Not Answered", "Call Not Connected", "Failed", "Scheduled", "Invalid Phone",
    "Cancelled",                            # not-yet-dialled call whose batch was stopped by the operator
    "Wrong Contact",                        # answered, but the callee is NOT the intended customer
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

# ── DB pool ───────────────────────────────────────────────────────────────────

db_pool = None


def set_db_pool(pool):
    global db_pool
    db_pool = pool


# ── In-process state ──────────────────────────────────────────────────────────
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


def is_batch_lock_held() -> bool:
    """Non-mutating peek at the batch lock — lets /batch-call return an
    explicit 409 instead of silently no-oping in the background task."""
    return _batch_locked


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
        result = await db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Failed', error_message = 'Stuck call cleaned up on startup',
                   ended_at = $1, updated_at = $1
               WHERE status = 'Calling' AND started_at < $2""",
            now_ist(), ten_min_ago,
        )
        # result is like "UPDATE N"
        count = int(result.split()[-1]) if result else 0
        if count > 0:
            logger.warning(f"Cleaned up {count} stuck 'Calling' records (>10 min)")
    except Exception as e:
        logger.error(f"cleanup_stuck_calls error: {e}")


# ── Time helpers ──────────────────────────────────────────────────────────────

def format_ist_time(dt) -> str:
    """Convert a datetime to IST display string."""
    if not dt:
        return ""
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%d %b %Y, %I:%M %p")


def now_ist() -> datetime:
    return datetime.now(IST)


def now_ist_str() -> str:
    return now_ist().strftime("%b %d, %Y %I:%M %p")


def _hhmm_to_hour(v):
    """'19:00' -> 19, '19:30' -> 19 (hour granularity, matching the hour-based
    window check). Returns None for empty/invalid so the global cap applies."""
    if v is None:
        return None
    if isinstance(v, int):
        return v
    try:
        return int(str(v).split(":")[0])
    except (ValueError, IndexError):
        return None


def is_within_calling_hours(bank_window=None) -> bool:
    """True if NOW (IST) is inside the calling window.

    CALL_START_HOUR..CALL_END_HOUR is the legal cap (RBI/TRAI). An optional
    per-bank window (bank_window=(start, end) as 'HH:MM' strings or hour ints)
    may only NARROW that cap — a bank can call less, never later. None parts fall
    back to the global cap. Backward-compatible: called with no args it enforces
    the global cap exactly as before.
    """
    hour = now_ist().hour
    start, end = CALL_START_HOUR, CALL_END_HOUR
    if bank_window:
        bs = _hhmm_to_hour(bank_window[0])
        be = _hhmm_to_hour(bank_window[1])
        if bs is not None:
            start = max(start, bs)
        if be is not None:
            end = min(end, be)
    return start <= hour < end


# ── Row serialization ─────────────────────────────────────────────────────────

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
        try:
            cd = json.loads(cd)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("collected_data JSON parse failed for call %s: %s",
                           c.get("id", "?"), e)
            cd = {}
    for k in ["monthly_income", "employment_type", "employer_name", "loan_purpose",
              "aadhar_number", "pan_number", "designation", "age", "business_type",
              "existing_emi", "collected_address", "monthly_turnover", "business_age",
              "is_salaried", "individual_purpose"]:
        if k not in c or not c[k]:
            c[k] = cd.get(k, "")

    # Flatten call_analysis fields to top level
    ca = c.get("call_analysis") or {}
    if isinstance(ca, str):
        try:
            ca = json.loads(ca)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("call_analysis JSON parse failed for call %s: %s",
                           c.get("id", "?"), e)
            ca = {}
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

    # Samavesh-shaped aliases the static agent-dashboard.html reads.
    # Set AFTER datetime formatting so these are already IST display strings.
    c["call_start_time"] = c.get("started_at", "")
    c["call_end_time"] = c.get("ended_at", "")
    c["uploaded_at"] = c.get("created_at", "")

    # Format scheduled_callback_at into IST display string for the UI
    sc = c.get("scheduled_callback_at")
    if sc and isinstance(sc, str):
        try:
            c["scheduled_callback_at"] = format_ist_time(datetime.fromisoformat(sc))
        except Exception:
            pass
    return c


# ── Auth ──────────────────────────────────────────────────────────────────────

security = HTTPBearer(auto_error=False)  # auto_error=False allows unauthenticated access


async def get_current_bank_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Authenticated access with tenant scoping.

    Security (#16): a MISSING token is rejected. Previously no-token silently
    returned operator access with bank_id=None — and _bank_filter() then applied
    no filter, so any unauthenticated caller could read every bank's data.

    - No token          -> 401.
    - refresh token     -> 401 (it is not an API credential; see below).
    - admin JWT         -> operator scope (bank_id=None, sees all banks). VGIPL
                           platform operators authenticate via the admin login and
                           reach the ops views this way.
    - bank_user JWT     -> scoped to their own bank_id (officer/supervisor only).

    Scope, role and active-status are read from the DB row on every request, the
    same way main.py's equivalent dependency does — never from the JWT claims.
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Authentication required")

    try:
        payload = pyjwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    # A refresh token carries exactly the same claims as an access token and
    # differs only by "type". Nothing checked it, so a refresh token worked as a
    # bearer credential for its full 9-hour life AND survived logout: logout
    # deletes the refresh_tokens row, but the JWT itself still verifies here.
    # Deny explicitly rather than requiring type == "access", so legacy tokens
    # minted without a "type" claim keep working.
    if payload.get("type") == "refresh":
        raise HTTPException(status_code=401, detail="Refresh token cannot be used for API access")

    user_type = payload.get("user_type")

    # Identity, scope and role now come from the DB row, not from the claims.
    # Reading them out of the token meant a deactivated user kept full access
    # until their token expired (main.py's equivalent dependency has always
    # re-read the row, so deactivation applied on /api/bank/* but silently did
    # not apply to the ~34 routes guarded here), and a stale bank_id/role claim
    # was trusted verbatim.
    if db_pool is None:
        raise HTTPException(status_code=503, detail="Service starting, retry shortly")

    try:
        user_uuid = uuid.UUID(str(payload.get("user_id")))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=401, detail="Invalid token")

    # Platform operators (admin token) get cross-bank operator scope.
    if user_type == "admin":
        row = await db_pool.fetchrow(
            "SELECT id FROM admin_users WHERE id = $1 AND is_active = true", user_uuid
        )
        if not row:
            raise HTTPException(status_code=401, detail="Admin user not found or inactive")
        return {
            "user_id": str(user_uuid),
            "role": "operator",
            "bank_id": None,
            "user_type": "operator",
        }

    if user_type == "bank_user":
        row = await db_pool.fetchrow(
            "SELECT id, bank_id, branch_id, role FROM bank_users "
            "WHERE id = $1 AND is_active = true",
            user_uuid,
        )
        if not row:
            raise HTTPException(status_code=401, detail="Bank user not found or inactive")
        # bank_admin is the senior bank role and must have at least the same
        # bank-scoped READ access as officers/supervisors — the scorecard editor
        # (/api/lrs/config), call logs, etc. Excluding it here 403'd bank_admins
        # out of those pages ("Failed to load config"). Approval/maker-checker
        # actions stay officer/supervisor-only via get_bank_officer, which keeps
        # its own stricter check, so this does not let admins self-approve.
        if row["role"] not in ("bank_officer", "bank_supervisor", "bank_admin"):
            raise HTTPException(status_code=403, detail="Bank user access required")
        return {
            "user_id": str(row["id"]),
            "role": row["role"],
            "bank_id": str(row["bank_id"]) if row["bank_id"] else None,
            "branch_id": str(row["branch_id"]) if row["branch_id"] else None,
            "user_type": "bank_user",
        }

    raise HTTPException(status_code=403, detail="Bank user or operator access required")


def _bank_uuid(user: dict):
    """Get bank_id as UUID, or None for operators (no bank scoping)."""
    bid = user.get("bank_id")
    return uuid.UUID(bid) if bid else None


def _bank_filter(bank_uuid, param_idx: int = 1, table_alias: str = "") -> tuple:
    """Build conditional bank_id SQL filter. Returns (condition_str, params_list, next_idx).
    When bank_uuid is None (operator), returns TRUE (no filter)."""
    prefix = f"{table_alias}." if table_alias else ""
    if bank_uuid is None:
        return "TRUE", [], param_idx
    return f"{prefix}bank_id = ${param_idx}", [bank_uuid], param_idx + 1


# ── Pydantic models ───────────────────────────────────────────────────────────

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
    qualification: Optional[str] = None
    sector: Optional[str] = None
    working_experience: Optional[str] = None
    existing_emi: Optional[str] = None
    business_age: Optional[str] = None
    monthly_turnover: Optional[str] = None
    collected_address: Optional[str] = None
    # Eligibility flags (loan-enquiry agent) — "yes"/"no" confirmed up-front
    is_salaried: Optional[str] = None
    individual_purpose: Optional[str] = None
    # Why the call ended (interested/not_interested/wrong_number/user_busy/
    # silence_timeout/safety_timeout/...) — set by the agent's end_call tool
    # and watchdogs; stored in call_analysis for retry/disposition logic.
    call_outcome: Optional[str] = None
    # Account opening fields (Union Bank agent)
    account_type: str = ""
    initial_deposit: str = ""


class CallCategorizeRequest(BaseModel):
    category: str
    reminder_date: Optional[str] = None
    after_call_remark: Optional[str] = None
