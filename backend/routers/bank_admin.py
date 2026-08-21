"""Bank admin portal — self-serve, bank-scoped (design_handoff_finix Job 1).

Every endpoint here is scoped to the CALLER's bank_id taken from the JWT
(never a path param), behind get_bank_admin. This is the boundary the platform
console's admin_*_bank_user endpoints deliberately do NOT cross: those are VGIPL
staff acting on any bank by id; these are a bank admin acting only on their own.

Step 4a covers users + invites + activity. Step 4b adds usage & call statistics
(quota, summary, outcomes, by-branch, call log, export). Step 4c adds settings
(four editable sections + the read-only VG-managed section + change requests).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

import asyncpg
import bcrypt
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from services import permissions as perms

logger = logging.getLogger("bank-admin")
security = HTTPBearer()

STANDARD_ROLES = ("bank_officer", "bank_supervisor")
ASSIGNABLE_ROLES = ("bank_admin", "bank_officer", "bank_supervisor", "custom")
NAME_RE = re.compile(r"^[A-Za-z ]+$")
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,50}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
INVITE_TTL_DAYS = 7


# ── pool/secret access ──────────────────────────────────────────────────────
# Resolve the main module WITHOUT assuming how the process was launched. Under
# `uvicorn main:app` the module is `main`; under `python main.py` it is
# `__main__`. Those are two DIFFERENT module objects, and the startup event
# (which sets db_pool) only ran on whichever one owns `app`. Prefer __main__
# when it carries the pool, so both launch styles work — vendors.py's plain
# `import main` breaks under `python main.py`, which is what bit us locally.
import sys as _sys


def _main_mod():
    for name in ("__main__", "main"):
        m = _sys.modules.get(name)
        if m is not None and getattr(m, "db_pool", None) is not None:
            return m
    # Fall back to the importable module even if its pool is None, so callers
    # get a consistent 503 rather than an AttributeError.
    import main as _m
    return _m


def _db() -> asyncpg.Pool:
    pool = getattr(_main_mod(), "db_pool", None)
    if pool is None:
        raise HTTPException(503, "database pool not ready")
    return pool


def _jwt_secret() -> str:
    m = _main_mod()
    return getattr(m, "JWT_SECRET", None) or __import__("main").JWT_SECRET


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _row(r: asyncpg.Record | None) -> Optional[dict]:
    if r is None:
        return None
    out: dict = {}
    for k, v in dict(r).items():
        if isinstance(v, uuid.UUID):
            out[k] = str(v)
        elif isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return out


def _rows(rs) -> list[dict]:
    return [_row(r) for r in rs]


# ── auth: bank admin only ────────────────────────────────────────────────────
async def get_bank_admin(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Decode a bank_user JWT and require role='bank_admin'. Returns the row + bank_id."""
    try:
        payload = jwt.decode(credentials.credentials, _jwt_secret(), algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except Exception:
        raise HTTPException(401, "Invalid token")
    if payload.get("user_type") != "bank_user":
        raise HTTPException(403, "Bank user access required")
    row = await _db().fetchrow(
        "SELECT bu.*, b.name AS bank_name, b.code AS bank_code, "
        "b.seat_cap, b.minute_quota, b.credit_balance "
        "FROM bank_users bu JOIN banks b ON b.id = bu.bank_id "
        "WHERE bu.id = $1 AND bu.is_active = true",
        uuid.UUID(payload["user_id"]),
    )
    if not row:
        raise HTTPException(401, "Bank user not found or inactive")
    if row["role"] != "bank_admin":
        raise HTTPException(403, "Bank admin role required")
    u = _row(row)
    u["bank_id"] = str(row["bank_id"])
    return u


async def _resolve_custom_role(bank_id: str, role: str, custom_role_id):
    """
    Validate a profile id for role='custom' and return (uuid, name).

    Bank-scoped by the WHERE clause, never trusted from the caller: without this
    an admin could assign another bank's profile and inherit its rights. Returns
    (None, None) for the built-in roles so callers can pass through unchanged.
    """
    if role != "custom":
        return None, None
    if not custom_role_id:
        raise HTTPException(400, "Pick which custom role to assign.")
    row = await _db().fetchrow(
        "SELECT id, name FROM bank_custom_roles WHERE id = $1 AND bank_id = $2 AND is_active",
        uuid.UUID(custom_role_id), uuid.UUID(bank_id),
    )
    if not row:
        raise HTTPException(400, "That custom role does not exist in this bank.")
    return row["id"], row["name"]


async def _validate_permission_codes(codes: list[str]) -> list[str]:
    """
    Keep only real permission codes, rejecting unknown ones loudly.

    Silently dropping a typo would tell an admin they granted a right they did
    not, which on this screen is the dangerous direction.
    """
    wanted = sorted(set(codes or []))
    if not wanted:
        return []
    valid = {
        r["permission_code"]
        for r in await _db().fetch("SELECT permission_code FROM permissions")
    }
    unknown = [c for c in wanted if c not in valid]
    if unknown:
        raise HTTPException(400, f"Unknown permission code(s): {', '.join(unknown)}")
    return wanted


# ── activity log helper ──────────────────────────────────────────────────────
async def log_activity(
    conn, bank_id: str, actor: dict, action: str,
    detail: Optional[dict] = None, target_user_id: Optional[str] = None,
) -> None:
    import json
    await conn.execute(
        "INSERT INTO bank_activity_log (bank_id, actor_user_id, actor_name, action, detail, target_user_id) "
        "VALUES ($1, $2, $3, $4, $5, $6)",
        uuid.UUID(bank_id), uuid.UUID(actor["id"]), actor.get("full_name") or actor.get("name"),
        action, json.dumps(detail or {}), uuid.UUID(target_user_id) if target_user_id else None,
    )


# ── seat accounting ──────────────────────────────────────────────────────────
async def _seat_usage(bank_id: str) -> dict:
    """Active + invited consume a seat; suspended do not. Pending invites count too."""
    active = await _db().fetchval(
        "SELECT COUNT(*) FROM bank_users WHERE bank_id = $1 AND status = 'active'", uuid.UUID(bank_id)
    )
    invited_users = await _db().fetchval(
        "SELECT COUNT(*) FROM bank_users WHERE bank_id = $1 AND status = 'invited'", uuid.UUID(bank_id)
    )
    pending_invites = await _db().fetchval(
        "SELECT COUNT(*) FROM bank_invites WHERE bank_id = $1 AND status = 'pending' AND seat_held = true",
        uuid.UUID(bank_id),
    )
    cap = await _db().fetchval("SELECT seat_cap FROM banks WHERE id = $1", uuid.UUID(bank_id))
    used = (active or 0) + (invited_users or 0) + (pending_invites or 0)
    return {
        "cap": cap or 0,
        "used": used,
        "free": max(0, (cap or 0) - used),
        "active": active or 0,
        "invited": (invited_users or 0) + (pending_invites or 0),
    }


# ════════════════════════════════════════════════════════════════════════════
router = APIRouter(prefix="/api/bank/admin", tags=["bank-admin"])


# ── models ───────────────────────────────────────────────────────────────────
class CreateUser(BaseModel):
    full_name: str
    username: str
    email: Optional[str] = None
    role: str  # bank_officer | bank_supervisor
    branch: Optional[str] = None
    employee_id: Optional[str] = None
    # When role='custom', which bank_custom_roles profile to assign (v41).
    custom_role_id: Optional[str] = None
    # Full desired permission set from the console grid. None => take the role
    # default untouched. An explicit [] means "no rights at all", which is a
    # legitimate choice for a not-yet-active account, so None and [] must stay
    # distinguishable.
    permissions: Optional[list[str]] = None


class UpdateUser(BaseModel):
    email: Optional[str] = None
    full_name: Optional[str] = None
    role: Optional[str] = None
    custom_role_label: Optional[str] = None
    custom_role_id: Optional[str] = None
    branch: Optional[str] = None


class InviteUser(BaseModel):
    email: str
    full_name: str
    role: str
    custom_role_label: Optional[str] = None
    custom_role_id: Optional[str] = None
    branch: Optional[str] = None
    employee_id: Optional[str] = None
    # Same semantics as CreateUser.permissions. Stored on the invite row and
    # applied when it is accepted, so choices made now survive until then.
    permissions: Optional[list[str]] = None


class CustomRoleBody(BaseModel):
    """A bank-defined role profile: a name, a blurb, and its default rights."""
    name: str
    description: Optional[str] = None
    permissions: list[str] = []


class SetPermissions(BaseModel):
    """Desired permission set for one existing user (from the console grid)."""
    permissions: list[str]
    reason: Optional[str] = None


def _validate_new_user(full_name: str, username: str, email: Optional[str], role: str):
    full_name = (full_name or "").strip()
    username = (username or "").strip()
    if not NAME_RE.match(full_name):
        raise HTTPException(400, "Letters and spaces only, no digits or symbols.")
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Lowercase letters, numbers and underscore only, 3 to 50 characters.")
    if email and not EMAIL_RE.match(email.strip()):
        raise HTTPException(400, "Enter a valid email address, for example name@azsb.co.in.")
    if role not in ASSIGNABLE_ROLES:
        raise HTTPException(400, "Unknown role.")
    return full_name, username, (email.strip() if email else None)


# ── users ────────────────────────────────────────────────────────────────────
@router.get("/users")
async def list_users(
    status: Optional[str] = Query(None),
    admin: dict = Depends(get_bank_admin),
):
    bank_id = admin["bank_id"]
    where = "WHERE bank_id = $1"
    params: list = [uuid.UUID(bank_id)]
    if status in ("active", "invited", "suspended"):
        where += " AND status = $2"
        params.append(status)
    users = await _db().fetch(
        f"SELECT id, username, email, full_name, role, custom_role_label, custom_role_id, branch, "
        f"employee_id, status, is_active, created_at, last_login_at "
        f"FROM bank_users {where} ORDER BY "
        f"CASE status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END, created_at DESC",
        *params,
    )
    # Pending invites appear as 'invited' rows too, so the screen shows them.
    invites = await _db().fetch(
        "SELECT id, email, full_name, role, custom_role_label, branch, employee_id, "
        "expires_at, created_at FROM bank_invites "
        "WHERE bank_id = $1 AND status = 'pending' ORDER BY created_at DESC",
        uuid.UUID(bank_id),
    )
    seats = await _seat_usage(bank_id)
    counts = {
        "all": len(users) + len(invites),
        "active": sum(1 for u in users if u["status"] == "active"),
        "invited": sum(1 for u in users if u["status"] == "invited") + len(invites),
        "suspended": sum(1 for u in users if u["status"] == "suspended"),
    }
    return {
        "users": _rows(users),
        "pending_invites": _rows(invites),
        "seats": seats,
        "counts": counts,
        "self_id": admin["id"],
    }


@router.post("/users")
async def create_user(body: CreateUser, admin: dict = Depends(get_bank_admin)):
    """Create an account directly (no invite email). Returns the temp password once."""
    generate_random_password = _main_mod().generate_random_password
    bank_id = admin["bank_id"]
    # Direct creation now also accepts a custom profile; the invite path always
    # could, and there is no reason the two should differ.
    if body.role not in STANDARD_ROLES and body.role != "custom":
        raise HTTPException(400, "Direct creation supports officer, supervisor or a custom role.")
    custom_id, custom_name = await _resolve_custom_role(bank_id, body.role, body.custom_role_id)
    full_name, username, email = _validate_new_user(body.full_name, body.username, body.email, body.role)

    seats = await _seat_usage(bank_id)
    if seats["free"] <= 0:
        raise HTTPException(409, "No free seats. Suspend or delete a user, or ask Virtual Galaxy to raise the seat cap.")

    if await _db().fetchrow("SELECT 1 FROM bank_users WHERE username = $1", username):
        raise HTTPException(400, f"Username '{username}' already exists.")
    if email and await _db().fetchrow(
        "SELECT 1 FROM bank_users WHERE email = $1 AND bank_id = $2", email, uuid.UUID(bank_id)
    ):
        raise HTTPException(400, "That email already exists in this bank.")

    password = generate_random_password()
    pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    async with _db().acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "INSERT INTO bank_users (bank_id, username, email, password_hash, full_name, role, branch, employee_id, status, custom_role_id, custom_role_label) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10) "
                "RETURNING id, username, email, full_name, role, branch, employee_id, status, created_at, custom_role_id, custom_role_label",
                uuid.UUID(bank_id), username, email, pw_hash, full_name, body.role, body.branch, body.employee_id,
                custom_id, custom_name,
            )
            await log_activity(conn, bank_id, admin, "create_user",
                               {"username": username, "role": body.role}, str(row["id"]))
    # Permission deltas are written after the user row commits: set_user_permissions
    # opens its own transaction, and nesting acquire() on the same pool inside the
    # block above would deadlock. A failure here leaves the user on their plain
    # role default rather than half-configured, which is the safe direction.
    if body.permissions is not None:
        await perms.set_user_permissions(
            _db(), str(row["id"]), body.role, body.permissions,
            actor_id=str(admin["id"]), reason="set at creation",
            custom_role_id=str(custom_id) if custom_id else None,
        )
    out = _row(row)
    out["generated_password"] = password  # shown once
    return {"user": out}


@router.patch("/users/{user_id}")
async def update_user(user_id: str, body: UpdateUser, admin: dict = Depends(get_bank_admin)):
    bank_id = admin["bank_id"]
    existing = await _db().fetchrow(
        "SELECT * FROM bank_users WHERE id = $1 AND bank_id = $2", uuid.UUID(user_id), uuid.UUID(bank_id)
    )
    if not existing:
        raise HTTPException(404, "User not found.")
    updates: dict = {}
    if body.email is not None:
        if body.email and not EMAIL_RE.match(body.email.strip()):
            raise HTTPException(400, "Enter a valid email address.")
        updates["email"] = body.email.strip() or None
    if body.full_name is not None:
        if not NAME_RE.match(body.full_name.strip()):
            raise HTTPException(400, "Letters and spaces only, no digits or symbols.")
        updates["full_name"] = body.full_name.strip()
    if body.role is not None:
        if body.role not in ASSIGNABLE_ROLES:
            raise HTTPException(400, "Unknown role.")
        # Guard: don't let an admin strip the last admin's own admin role.
        if existing["role"] == "bank_admin" and body.role != "bank_admin":
            other_admins = await _db().fetchval(
                "SELECT COUNT(*) FROM bank_users WHERE bank_id = $1 AND role = 'bank_admin' AND id <> $2 AND status = 'active'",
                uuid.UUID(bank_id), uuid.UUID(user_id),
            )
            if not other_admins:
                raise HTTPException(409, "This is the only bank admin. Assign another admin first.")
        updates["role"] = body.role
        updates["custom_role_label"] = body.custom_role_label if body.role == "custom" else None
        # Moving to a built-in role clears the profile link; moving to custom
        # requires a valid one. Leaving a stale id behind would keep granting the
        # old profile's rights after the role changed.
        _cid, _cname = await _resolve_custom_role(bank_id, body.role, body.custom_role_id)
        updates["custom_role_id"] = _cid
        if _cname:
            updates["custom_role_label"] = _cname
    if body.branch is not None:
        updates["branch"] = body.branch
    if not updates:
        raise HTTPException(400, "No fields to update.")

    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates))
    vals = list(updates.values()) + [uuid.UUID(user_id)]
    async with _db().acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"UPDATE bank_users SET {sets} WHERE id = ${len(vals)}", *vals)
            await log_activity(conn, bank_id, admin, "update_user", {k: str(v) for k, v in updates.items()}, user_id)
    row = await _db().fetchrow(
        "SELECT id, username, email, full_name, role, custom_role_label, branch, employee_id, status, created_at, last_login_at "
        "FROM bank_users WHERE id = $1", uuid.UUID(user_id),
    )
    return {"user": _row(row)}


@router.post("/users/{user_id}/suspend")
async def suspend_user(user_id: str, admin: dict = Depends(get_bank_admin)):
    bank_id = admin["bank_id"]
    if user_id == admin["id"]:
        raise HTTPException(409, "You cannot suspend your own account.")
    existing = await _db().fetchrow(
        "SELECT role, status FROM bank_users WHERE id = $1 AND bank_id = $2", uuid.UUID(user_id), uuid.UUID(bank_id)
    )
    if not existing:
        raise HTTPException(404, "User not found.")
    if existing["role"] == "bank_admin":
        other = await _db().fetchval(
            "SELECT COUNT(*) FROM bank_users WHERE bank_id = $1 AND role = 'bank_admin' AND id <> $2 AND status = 'active'",
            uuid.UUID(bank_id), uuid.UUID(user_id),
        )
        if not other:
            raise HTTPException(409, "This is the only active bank admin. Assign another admin first.")
    async with _db().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE bank_users SET status = 'suspended', is_active = false WHERE id = $1", uuid.UUID(user_id)
            )
            await log_activity(conn, bank_id, admin, "suspend_user", None, user_id)
    return {"status": "suspended", "seats": await _seat_usage(bank_id)}


@router.post("/users/{user_id}/restore")
async def restore_user(user_id: str, admin: dict = Depends(get_bank_admin)):
    bank_id = admin["bank_id"]
    existing = await _db().fetchrow(
        "SELECT status FROM bank_users WHERE id = $1 AND bank_id = $2", uuid.UUID(user_id), uuid.UUID(bank_id)
    )
    if not existing:
        raise HTTPException(404, "User not found.")
    seats = await _seat_usage(bank_id)
    if seats["free"] <= 0:
        raise HTTPException(409, "No free seats to restore this user. Free a seat first.")
    async with _db().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE bank_users SET status = 'active', is_active = true WHERE id = $1", uuid.UUID(user_id)
            )
            await log_activity(conn, bank_id, admin, "restore_user", None, user_id)
    return {"status": "active", "seats": await _seat_usage(bank_id)}


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, admin: dict = Depends(get_bank_admin)):
    """Soft-delete: removes access permanently but the audit record survives."""
    bank_id = admin["bank_id"]
    if user_id == admin["id"]:
        raise HTTPException(409, "You cannot delete your own account.")
    existing = await _db().fetchrow(
        "SELECT role FROM bank_users WHERE id = $1 AND bank_id = $2", uuid.UUID(user_id), uuid.UUID(bank_id)
    )
    if not existing:
        raise HTTPException(404, "User not found.")
    if existing["role"] == "bank_admin":
        other = await _db().fetchval(
            "SELECT COUNT(*) FROM bank_users WHERE bank_id = $1 AND role = 'bank_admin' AND id <> $2 AND status = 'active'",
            uuid.UUID(bank_id), uuid.UUID(user_id),
        )
        if not other:
            raise HTTPException(409, "This is the only bank admin. Assign another admin first.")
    async with _db().acquire() as conn:
        async with conn.transaction():
            # Deactivate + mark suspended; we keep the row so history/audit survive.
            await conn.execute(
                "UPDATE bank_users SET is_active = false, status = 'suspended', "
                "username = username || '__deleted__' || left(md5(random()::text), 6) WHERE id = $1",
                uuid.UUID(user_id),
            )
            await log_activity(conn, bank_id, admin, "delete_user", None, user_id)
    return {"status": "deleted", "seats": await _seat_usage(bank_id)}


# ── invites ──────────────────────────────────────────────────────────────────
@router.post("/invites")
async def invite_user(body: InviteUser, admin: dict = Depends(get_bank_admin)):
    """Create an invite (7-day expiry, holds a seat) and send the link by email.

    If SMTP isn't configured the invite is still created and the link is returned
    so the admin can hand it over; email_sent=false signals the fallback.
    """
    from services.mailer import send_invite_email, public_base_url
    bank_id = admin["bank_id"]
    email = (body.email or "").strip()
    full_name = (body.full_name or "").strip()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address.")
    if not NAME_RE.match(full_name):
        raise HTTPException(400, "Letters and spaces only, no digits or symbols.")
    if body.role not in ASSIGNABLE_ROLES:
        raise HTTPException(400, "Unknown role.")
    custom_id, custom_name = await _resolve_custom_role(bank_id, body.role, body.custom_role_id)
    if await _db().fetchrow(
        "SELECT 1 FROM bank_users WHERE email = $1 AND bank_id = $2 AND is_active = true", email, uuid.UUID(bank_id)
    ):
        raise HTTPException(400, "A user with that email already exists in this bank.")
    if await _db().fetchrow(
        "SELECT 1 FROM bank_invites WHERE email = $1 AND bank_id = $2 AND status = 'pending'", email, uuid.UUID(bank_id)
    ):
        raise HTTPException(400, "There is already a pending invite for that email.")

    seats = await _seat_usage(bank_id)
    if seats["free"] <= 0:
        raise HTTPException(409, "No free seats. Free a seat before inviting.")

    token = secrets.token_urlsafe(32)
    expires = _now() + timedelta(days=INVITE_TTL_DAYS)
    async with _db().acquire() as conn:
        async with conn.transaction():
            overrides_json = None
            if body.permissions is not None:
                # Diff against the role default NOW: the admin ticked boxes
                # relative to today's default, and storing the absolute set would
                # silently re-interpret their intent if the default shifts before
                # the invite is accepted.
                defaults = await perms.role_default_permissions(
                    conn, body.role, str(custom_id) if custom_id else None
                )
                desired = set(body.permissions)
                overrides_json = json.dumps(
                    [{"permission_code": c, "effect": "grant"} for c in sorted(desired - defaults)]
                    + [{"permission_code": c, "effect": "revoke"} for c in sorted(defaults - desired)]
                )
            row = await conn.fetchrow(
                "INSERT INTO bank_invites (bank_id, email, full_name, employee_id, role, custom_role_label, "
                "branch, token, invited_by, invited_by_name, expires_at, permission_overrides, custom_role_id) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
                uuid.UUID(bank_id), email, full_name, body.employee_id, body.role,
                # Prefer the profile's own name over a free-typed label, so the two
                # can never disagree about what the role is called.
                custom_name or (body.custom_role_label if body.role == "custom" else None),
                body.branch, token,
                uuid.UUID(admin["id"]), admin.get("full_name") or admin.get("name"), expires,
                overrides_json, custom_id,
            )
            await log_activity(conn, bank_id, admin, "invite_user", {"email": email, "role": body.role})

    invite_url = f"{public_base_url()}/bank/accept-invite?token={token}"
    expires_human = expires.strftime("%d %b %Y")
    # send_invite_email is sync smtplib with a 15s timeout per phase. Called
    # directly it blocked the whole single-process event loop — every
    # tenant's requests, the dispatcher and the job workers — on one
    # unreachable SMTP host. Push it to a worker thread.
    email_sent = await asyncio.to_thread(
        send_invite_email, email, full_name,
        admin.get("bank_name", "your bank"), invite_url, expires_human,
    )
    out = _row(row)
    out.pop("token", None)  # don't leak the raw token in the list payload
    return {"invite": out, "invite_url": invite_url, "email_sent": email_sent}


@router.post("/invites/{invite_id}/resend")
async def resend_invite(invite_id: str, admin: dict = Depends(get_bank_admin)):
    from services.mailer import send_invite_email, public_base_url
    bank_id = admin["bank_id"]
    row = await _db().fetchrow(
        "SELECT * FROM bank_invites WHERE id = $1 AND bank_id = $2 AND status = 'pending'",
        uuid.UUID(invite_id), uuid.UUID(bank_id),
    )
    if not row:
        raise HTTPException(404, "Pending invite not found.")
    invite_url = f"{public_base_url()}/bank/accept-invite?token={row['token']}"
    expires_human = row["expires_at"].strftime("%d %b %Y")
    email_sent = await asyncio.to_thread(
        send_invite_email, row["email"], row["full_name"],
        admin.get("bank_name", "your bank"), invite_url, expires_human,
    )
    await log_activity(_db(), bank_id, admin, "resend_invite", {"invite_id": invite_id, "email": row["email"], "email_sent": email_sent})
    return {"invite_url": invite_url, "email_sent": email_sent}


@router.delete("/invites/{invite_id}")
async def revoke_invite(invite_id: str, admin: dict = Depends(get_bank_admin)):
    bank_id = admin["bank_id"]
    row = await _db().fetchrow(
        "SELECT id FROM bank_invites WHERE id = $1 AND bank_id = $2 AND status = 'pending'",
        uuid.UUID(invite_id), uuid.UUID(bank_id),
    )
    if not row:
        raise HTTPException(404, "Pending invite not found.")
    async with _db().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE bank_invites SET status = 'revoked', seat_held = false WHERE id = $1", uuid.UUID(invite_id)
            )
            await log_activity(conn, bank_id, admin, "revoke_invite", {"invite_id": invite_id})
    return {"status": "revoked", "seats": await _seat_usage(bank_id)}


# ── activity ─────────────────────────────────────────────────────────────────
# ── custom roles ("profiles") ───────────────────────────────────
# An admin defines a named profile once — "Recovery caller" — with its own
# default permission set, then assigns it to people. Until v41 those names were
# hard-coded in the frontend and carried no rights at all.
#
# Users on a profile keep bank_users.role = 'custom' (already allowed by the v28
# CHECK) plus custom_role_id, so every existing role-string comparison in the
# routers keeps working unchanged.

@router.get("/custom-roles")
async def list_custom_roles(admin: dict = Depends(get_bank_admin)):
    """This bank's profiles with their permission sets and how many users hold each."""
    await perms.require_permission(_db(), admin, "user.view")
    bank_id = admin["bank_id"]
    rows = await _db().fetch(
        "SELECT r.*, "
        "  (SELECT COUNT(*) FROM bank_users u WHERE u.custom_role_id = r.id AND u.is_active) AS user_count, "
        "  COALESCE(ARRAY(SELECT permission_code FROM bank_custom_role_permissions "
        "                  WHERE custom_role_id = r.id ORDER BY permission_code), '{}') AS permissions "
        "FROM bank_custom_roles r WHERE r.bank_id = $1 AND r.is_active ORDER BY r.name",
        uuid.UUID(bank_id),
    )
    return {"roles": _rows(rows)}


@router.post("/custom-roles")
async def create_custom_role(body: CustomRoleBody, admin: dict = Depends(get_bank_admin)):
    await perms.require_permission(_db(), admin, "user.manage_permissions")
    bank_id = admin["bank_id"]
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Give the role a name.")
    if len(name) > 60:
        raise HTTPException(400, "Role name is too long (60 characters max).")
    # Reject a name that collides with a built-in role: two different things
    # called "Supervisor" in one picker is a permissions accident waiting to
    # happen. Compared case-insensitively, like the unique index.
    if name.lower() in {"officer", "supervisor", "bank admin", "branch manager", "auditor"}:
        raise HTTPException(400, f"'{name}' clashes with a built-in role. Pick another name.")
    if await _db().fetchrow(
        "SELECT 1 FROM bank_custom_roles WHERE bank_id = $1 AND LOWER(name) = LOWER($2) AND is_active",
        uuid.UUID(bank_id), name,
    ):
        raise HTTPException(400, f"A role called '{name}' already exists.")

    codes = await _validate_permission_codes(body.permissions)
    async with _db().acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "INSERT INTO bank_custom_roles (bank_id, name, description, created_by) "
                "VALUES ($1,$2,$3,$4) RETURNING *",
                uuid.UUID(bank_id), name, (body.description or "").strip() or None,
                uuid.UUID(admin["id"]),
            )
            for c in codes:
                await conn.execute(
                    "INSERT INTO bank_custom_role_permissions (custom_role_id, permission_code) VALUES ($1,$2)",
                    row["id"], c,
                )
            await log_activity(conn, bank_id, admin, "create_custom_role",
                               {"name": name, "permissions": len(codes)})
    out = _row(row)
    out["permissions"] = codes
    out["user_count"] = 0
    return {"role": out}


@router.put("/custom-roles/{role_id}")
async def update_custom_role(role_id: str, body: CustomRoleBody, admin: dict = Depends(get_bank_admin)):
    """
    Rename a profile and/or replace its permission set.

    Editing the set changes what every holder inherits IMMEDIATELY — that is the
    point of a profile. Their individual grant/revoke exceptions survive, because
    those are stored as deltas rather than a copy of the profile.
    """
    await perms.require_permission(_db(), admin, "user.manage_permissions")
    bank_id = admin["bank_id"]
    row = await _db().fetchrow(
        "SELECT * FROM bank_custom_roles WHERE id = $1 AND bank_id = $2 AND is_active",
        uuid.UUID(role_id), uuid.UUID(bank_id),
    )
    if not row:
        raise HTTPException(404, "Role not found in this bank.")
    name = (body.name or "").strip() or row["name"]
    if await _db().fetchrow(
        "SELECT 1 FROM bank_custom_roles WHERE bank_id = $1 AND LOWER(name) = LOWER($2) "
        "AND id <> $3 AND is_active",
        uuid.UUID(bank_id), name, uuid.UUID(role_id),
    ):
        raise HTTPException(400, f"A role called '{name}' already exists.")

    codes = await _validate_permission_codes(body.permissions)
    async with _db().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE bank_custom_roles SET name = $1, description = $2, updated_at = NOW(), "
                "updated_by = $3 WHERE id = $4",
                name, (body.description or "").strip() or None, uuid.UUID(admin["id"]),
                uuid.UUID(role_id),
            )
            await conn.execute(
                "DELETE FROM bank_custom_role_permissions WHERE custom_role_id = $1", uuid.UUID(role_id)
            )
            for c in codes:
                await conn.execute(
                    "INSERT INTO bank_custom_role_permissions (custom_role_id, permission_code) VALUES ($1,$2)",
                    uuid.UUID(role_id), c,
                )
            await log_activity(conn, bank_id, admin, "update_custom_role",
                               {"name": name, "permissions": len(codes)})
    return await list_custom_roles(admin)


@router.delete("/custom-roles/{role_id}")
async def delete_custom_role(role_id: str, admin: dict = Depends(get_bank_admin)):
    """
    Retire a profile. Refuses while anyone still holds it.

    Deleting out from under its holders would strip their inherited rights
    silently (custom has no built-in default to fall back on), so the admin is
    told to move those people first rather than discovering it later.
    """
    await perms.require_permission(_db(), admin, "user.manage_permissions")
    bank_id = admin["bank_id"]
    row = await _db().fetchrow(
        "SELECT * FROM bank_custom_roles WHERE id = $1 AND bank_id = $2 AND is_active",
        uuid.UUID(role_id), uuid.UUID(bank_id),
    )
    if not row:
        raise HTTPException(404, "Role not found in this bank.")
    holders = await _db().fetchval(
        "SELECT COUNT(*) FROM bank_users WHERE custom_role_id = $1 AND is_active", uuid.UUID(role_id)
    )
    if holders:
        raise HTTPException(
            409,
            f"{holders} user{'s' if holders != 1 else ''} still hold this role. "
            "Move them to another role first.",
        )
    async with _db().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE bank_custom_roles SET is_active = false, updated_at = NOW(), updated_by = $1 "
                "WHERE id = $2",
                uuid.UUID(admin["id"]), uuid.UUID(role_id),
            )
            await log_activity(conn, bank_id, admin, "delete_custom_role", {"name": row["name"]})
    return {"deleted": role_id}

# ── permissions ──────────────────────────────────────────────────────────────
# The console renders a permission matrix per user: every catalogue permission,
# its role default, and whether this person has an explicit exception. These
# three endpoints are what make that grid editable rather than decorative.

@router.get("/permissions/catalogue")
async def permission_catalogue(admin: dict = Depends(get_bank_admin)):
    """Every permission plus each role's default set — prefills the grid before a user exists."""
    await perms.require_permission(_db(), admin, "user.view")
    rows = await _db().fetch(
        "SELECT permission_code, category, description, is_dangerous FROM permissions "
        "ORDER BY category, permission_code"
    )
    defaults = await _db().fetch("SELECT role, permission_code FROM bank_role_default_permissions")
    by_role: dict[str, list[str]] = {}
    for d in defaults:
        by_role.setdefault(d["role"], []).append(d["permission_code"])
    return {
        "permissions": [dict(r) for r in rows],
        "role_defaults": {k: sorted(v) for k, v in by_role.items()},
    }


@router.get("/users/{user_id}/permissions")
async def get_user_permissions(user_id: str, admin: dict = Depends(get_bank_admin)):
    """This user's matrix: allowed state + whether it came from the role or an override."""
    await perms.require_permission(_db(), admin, "user.view")
    row = await _db().fetchrow(
        "SELECT id, role, custom_role_id FROM bank_users WHERE id = $1 AND bank_id = $2",
        uuid.UUID(user_id), uuid.UUID(admin["bank_id"]),
    )
    if not row:
        raise HTTPException(404, "User not found in this bank.")
    cid = str(row["custom_role_id"]) if row["custom_role_id"] else None
    detail = await perms.user_permission_detail(_db(), user_id, row["role"], cid)
    return {"user_id": user_id, "role": row["role"], "permissions": detail}


@router.put("/users/{user_id}/permissions")
async def put_user_permissions(user_id: str, body: SetPermissions, admin: dict = Depends(get_bank_admin)):
    """
    Replace this user's permission set. Stored as deltas against the role default.

    Bank-scoped by the WHERE clause below, never by a path param the caller
    controls, so one bank's admin cannot reach another bank's user.
    """
    await perms.require_permission(_db(), admin, "user.manage_permissions")
    bank_id = admin["bank_id"]
    row = await _db().fetchrow(
        "SELECT id, role, username, custom_role_id FROM bank_users WHERE id = $1 AND bank_id = $2",
        uuid.UUID(user_id), uuid.UUID(bank_id),
    )
    if not row:
        raise HTTPException(404, "User not found in this bank.")

    # An admin must not be able to remove their own ability to manage
    # permissions — that would strand the bank with no one able to fix it.
    if str(row["id"]) == str(admin["id"]) and "user.manage_permissions" not in set(body.permissions):
        raise HTTPException(400, "You cannot remove your own permission-management right.")

    cid = str(row["custom_role_id"]) if row["custom_role_id"] else None
    result = await perms.set_user_permissions(
        _db(), user_id, row["role"], body.permissions,
        actor_id=str(admin["id"]), reason=body.reason, custom_role_id=cid,
    )
    async with _db().acquire() as conn:
        await log_activity(conn, bank_id, admin, "set_permissions",
                           {"username": row["username"], **result}, user_id)
    detail = await perms.user_permission_detail(_db(), user_id, row["role"], cid)
    return {"user_id": user_id, "role": row["role"], "permissions": detail, **result}


@router.get("/activity")
async def list_activity(
    limit: int = Query(50, ge=1, le=200),
    target_user_id: Optional[str] = Query(None),
    admin: dict = Depends(get_bank_admin),
):
    bank_id = admin["bank_id"]
    if target_user_id:
        rows = await _db().fetch(
            "SELECT * FROM bank_activity_log WHERE bank_id = $1 AND target_user_id = $2 "
            "ORDER BY created_at DESC LIMIT $3",
            uuid.UUID(bank_id), uuid.UUID(target_user_id), limit,
        )
    else:
        rows = await _db().fetch(
            "SELECT * FROM bank_activity_log WHERE bank_id = $1 ORDER BY created_at DESC LIMIT $2",
            uuid.UUID(bank_id), limit,
        )
    return {"entries": _rows(rows)}


# ════════════════════════════════════════════════════════════════════════════
# USAGE & CALL STATISTICS (Step 4b)
#
# All metrics are DERIVED from agent_calls scoped to the caller's bank. Minutes
# = SUM(call_duration) in seconds → /60. Quota / credit come from the banks row
# (VGIPL-managed). The "quota exceeded" screen state is derived (consumed >=
# quota), not a stored flag, so it flips automatically as usage lands.
#
# Status buckets follow the shared vocabulary (see frontend callStatus.tsx and
# agent/state.STATUS_OPTIONS). "Answered" EXCLUDES Wrong Contact per the spec.
# ════════════════════════════════════════════════════════════════════════════

# Hard-failure umbrella (not billed) — matches agent/calls.py.
_FAILED = ("Failed", "Invalid Phone", "Call Not Connected")
# Statuses that mean the call was answered by a human (wrong contact excluded).
_ANSWERED = ("Called", "Called - Interested", "Called - Not Interested",
             "Called - Callback Requested")


def _ist():
    from agent.state import IST
    return IST


def _ist_midnight(date_str: str) -> datetime:
    return _ist().localize(datetime.strptime(date_str, "%Y-%m-%d"))


def _period_bounds(date_from: Optional[str], date_to: Optional[str]):
    """Resolve a [lo, hi) IST window. Defaults to the current calendar month
    (IST) when nothing is supplied, so the quota projection has a period."""
    IST = _ist()
    now = datetime.now(IST)
    lo = hi = None
    if date_from:
        try:
            lo = _ist_midnight(date_from)
        except ValueError:
            lo = None
    if date_to:
        try:
            hi = _ist_midnight(date_to) + timedelta(days=1)
        except ValueError:
            hi = None
    if lo is None:
        lo = IST.localize(datetime(now.year, now.month, 1))
    if hi is None:
        # start of next month
        nm = (now.month % 12) + 1
        ny = now.year + (1 if now.month == 12 else 0)
        hi = IST.localize(datetime(ny, nm, 1))
    return lo, hi


async def _scoped(bank_id: str, extra: str, params: list) -> str:
    """Build a WHERE clause anchored to this bank + a period, returning SQL."""
    return extra


@router.get("/usage/quota")
async def usage_quota(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    admin: dict = Depends(get_bank_admin),
):
    """Minutes consumed vs quota for the period, days elapsed/remaining, the
    7-day run rate, a plain-language projection, and the credit balance."""
    IST = _ist()
    bank_id = admin["bank_id"]
    lo, hi = _period_bounds(date_from, date_to)
    now = datetime.now(IST)

    bank = await _db().fetchrow(
        "SELECT minute_quota, credit_balance, seat_cap FROM banks WHERE id = $1", uuid.UUID(bank_id)
    )
    quota = int(bank["minute_quota"] or 0)

    consumed_sec = await _db().fetchval(
        "SELECT COALESCE(SUM(call_duration),0) FROM agent_calls "
        "WHERE bank_id = $1 AND COALESCE(started_at, created_at) >= $2 AND COALESCE(started_at, created_at) < $3",
        uuid.UUID(bank_id), lo, hi,
    )
    consumed_min = round((consumed_sec or 0) / 60)

    # 7-day run rate (last 7 days up to now, or up to hi if the period is past).
    window_hi = min(now, hi)
    window_lo = window_hi - timedelta(days=7)
    last7_sec = await _db().fetchval(
        "SELECT COALESCE(SUM(call_duration),0) FROM agent_calls "
        "WHERE bank_id = $1 AND COALESCE(started_at, created_at) >= $2 AND COALESCE(started_at, created_at) < $3",
        uuid.UUID(bank_id), window_lo, window_hi,
    )
    rate_per_day = round((last7_sec or 0) / 60 / 7)

    total_days = max(1, (hi - lo).days)
    elapsed_days = max(0, min(total_days, (window_hi - lo).days))
    days_remaining = max(0, total_days - elapsed_days)

    remaining_min = max(0, quota - consumed_min)
    exceeded = quota > 0 and consumed_min >= quota

    # Projected exhaustion date at the current rate.
    projection = None
    if rate_per_day > 0 and not exceeded and remaining_min > 0:
        days_to_exhaust = remaining_min / rate_per_day
        exhaust_date = window_hi + timedelta(days=days_to_exhaust)
        if exhaust_date < hi:
            projection = {
                "date": exhaust_date.strftime("%d %b"),
                "days_before_end": max(0, (hi - exhaust_date).days),
                "rate_per_day": rate_per_day,
            }

    return {
        "quota": quota,
        "consumed": consumed_min,
        "remaining": remaining_min,
        "fraction": (consumed_min / quota) if quota else 0,
        "pace_fraction": (elapsed_days / total_days) if total_days else 0,
        "days_total": total_days,
        "days_elapsed": elapsed_days,
        "days_remaining": days_remaining,
        "rate_per_day": rate_per_day,
        "projection": projection,
        "exceeded": exceeded,
        "credit_balance": float(bank["credit_balance"] or 0),
        "credit_floor": 25000,
        "period": {"from": lo.strftime("%Y-%m-%d"), "to": (hi - timedelta(days=1)).strftime("%Y-%m-%d")},
    }


@router.get("/usage/summary")
async def usage_summary(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    branch: Optional[str] = None,
    admin: dict = Depends(get_bank_admin),
):
    """Calls placed, connect rate, average duration, promise-to-pay + the call
    outcomes breakdown for the segmented bar and legend."""
    bank_id = admin["bank_id"]
    lo, hi = _period_bounds(date_from, date_to)

    # branch filter: agent_calls has no branch column, so branch scoping joins
    # via customer→application is out of scope; when a branch is passed we note
    # it's unsupported at the call level and return the bank-wide figures.
    base = ("bank_id = $1 AND COALESCE(started_at, created_at) >= $2 AND COALESCE(started_at, created_at) < $3")
    p = [uuid.UUID(bank_id), lo, hi]

    total = await _db().fetchval(f"SELECT COUNT(*) FROM agent_calls WHERE {base}", *p)
    answered = await _db().fetchval(
        f"SELECT COUNT(*) FROM agent_calls WHERE {base} AND status = ANY($4::text[])", *p, list(_ANSWERED)
    )
    avg_sec = await _db().fetchval(
        f"SELECT COALESCE(AVG(call_duration),0) FROM agent_calls WHERE {base} AND call_duration > 0", *p
    )
    # Promise-to-pay proxy: callback requested (the strongest engagement signal
    # we capture). Flagged in the UI note as derived from callbacks.
    promise = await _db().fetchval(
        f"SELECT COUNT(*) FROM agent_calls WHERE {base} AND status = 'Called - Callback Requested'", *p
    )

    # Outcome breakdown, one row per status present.
    rows = await _db().fetch(
        f"SELECT status, COUNT(*) AS n FROM agent_calls WHERE {base} GROUP BY status ORDER BY n DESC", *p
    )
    outcomes = [{"status": r["status"], "count": r["n"]} for r in rows]
    wrong_contact = next((o["count"] for o in outcomes if o["status"] == "Wrong Contact"), 0)

    connect_rate = round((answered / total) * 100, 1) if total else 0.0
    return {
        "calls_placed": total or 0,
        "answered": answered or 0,
        "connect_rate": connect_rate,
        "avg_duration_sec": int(avg_sec or 0),
        "promise_to_pay": promise or 0,
        "wrong_contact": wrong_contact,
        "outcomes": outcomes,
        "branch_note": "Branch filtering is not yet available at the call level." if branch else None,
    }


@router.get("/usage/by-branch")
async def usage_by_branch(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    admin: dict = Depends(get_bank_admin),
):
    """Calls per branch (Decision B — calls aren't attributed to a user, so we
    rank by branch). Branches come from bank_users; calls are matched to a
    branch via the batch uploader's branch when available, else grouped as
    'Unassigned'. Honest about the attribution we have."""
    bank_id = admin["bank_id"]
    lo, hi = _period_bounds(date_from, date_to)

    # Attribute each call to the branch of the user who uploaded its batch.
    rows = await _db().fetch(
        """
        SELECT COALESCE(bu.branch, 'Unassigned') AS branch,
               COUNT(*) AS calls,
               COALESCE(SUM(c.call_duration),0) AS seconds,
               COUNT(*) FILTER (WHERE c.status = ANY($4::text[])) AS answered
        FROM agent_calls c
        LEFT JOIN agent_batches b ON b.batch_id = c.batch_id AND b.bank_id = c.bank_id
        LEFT JOIN bank_users bu ON bu.id = b.uploaded_by
        WHERE c.bank_id = $1
          AND COALESCE(c.started_at, c.created_at) >= $2
          AND COALESCE(c.started_at, c.created_at) < $3
        GROUP BY COALESCE(bu.branch, 'Unassigned')
        ORDER BY calls DESC
        """,
        uuid.UUID(bank_id), lo, hi, list(_ANSWERED),
    )
    branches = [
        {
            "branch": r["branch"],
            "calls": r["calls"],
            "minutes": round((r["seconds"] or 0) / 60),
            "answered": r["answered"],
            "connect_rate": round((r["answered"] / r["calls"]) * 100) if r["calls"] else 0,
        }
        for r in rows
    ]
    return {"branches": branches}


@router.get("/usage/calls")
async def usage_calls(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    admin: dict = Depends(get_bank_admin),
):
    """Bank-scoped, paginated call log for the usage screen."""
    bank_id = admin["bank_id"]
    lo, hi = _period_bounds(date_from, date_to)
    conds = ["bank_id = $1", "COALESCE(started_at, created_at) >= $2", "COALESCE(started_at, created_at) < $3"]
    params: list = [uuid.UUID(bank_id), lo, hi]
    idx = 4
    if status:
        if status == "Failed":
            conds.append(f"status = ANY(${idx}::text[])")
            params.append(list(_FAILED))
        else:
            conds.append(f"status = ${idx}")
            params.append(status)
        idx += 1
    where = " AND ".join(conds)
    total = await _db().fetchval(f"SELECT COUNT(*) FROM agent_calls WHERE {where}", *params)
    offset = (page - 1) * page_size
    rows = await _db().fetch(
        f"SELECT id, customer_name, phone, loan_type, loan_amount, status, category, "
        f"call_duration, form_sent, recording_url, started_at, created_at "
        f"FROM agent_calls WHERE {where} ORDER BY COALESCE(started_at, created_at) DESC "
        f"LIMIT ${idx} OFFSET ${idx+1}",
        *params, page_size, offset,
    )
    return {
        "total": total or 0,
        "page": page,
        "page_size": page_size,
        "total_pages": ((total or 0) + page_size - 1) // page_size,
        "calls": _rows(rows),
    }


@router.get("/usage/export")
async def usage_export(
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    admin: dict = Depends(get_bank_admin),
):
    """CSV export of the bank's calls for the period (stdlib csv, no pandas)."""
    import csv
    import io
    from fastapi.responses import StreamingResponse

    bank_id = admin["bank_id"]
    lo, hi = _period_bounds(date_from, date_to)
    conds = ["bank_id = $1", "COALESCE(started_at, created_at) >= $2", "COALESCE(started_at, created_at) < $3"]
    params: list = [uuid.UUID(bank_id), lo, hi]
    idx = 4
    if status:
        if status == "Failed":
            conds.append(f"status = ANY(${idx}::text[])")
            params.append(list(_FAILED))
        else:
            conds.append(f"status = ${idx}")
            params.append(status)
        idx += 1
    where = " AND ".join(conds)
    rows = await _db().fetch(
        f"SELECT customer_name, phone, loan_type, loan_amount, status, category, "
        f"call_duration, form_sent, COALESCE(started_at, created_at) AS when_ts "
        f"FROM agent_calls WHERE {where} ORDER BY when_ts DESC",
        *params,
    )
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["When", "Customer", "Phone", "Loan type", "Loan amount", "Status", "Category", "Duration (s)", "Form sent"])
    for r in rows:
        w.writerow([
            r["when_ts"].isoformat() if r["when_ts"] else "",
            r["customer_name"] or "", r["phone"] or "", r["loan_type"] or "",
            float(r["loan_amount"]) if r["loan_amount"] is not None else "",
            r["status"] or "", r["category"] or "",
            r["call_duration"] if r["call_duration"] is not None else "",
            "yes" if r["form_sent"] else "no",
        ])
    buf.seek(0)
    fname = f"calls_{lo.strftime('%Y%m%d')}_{(hi - timedelta(days=1)).strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ════════════════════════════════════════════════════════════════════════════
# SETTINGS (Step 4c)
#
# Four editable sections (◆ yours) live in bank_settings, one row per bank,
# lazily created on first GET. One read-only section (◇ Managed by Virtual
# Galaxy) is projected from the banks row and never writable here — the bank
# admin can only file a change request. Every save writes to bank_activity_log.
# ════════════════════════════════════════════════════════════════════════════

# Whitelist of columns the bank admin may write (guards against setting VG-owned
# or audit columns through the JSON body).
_SETTINGS_FIELDS = {
    "calling_window_start", "calling_window_end", "max_retries_per_day", "caller_id_pool",
    "pause_outbound", "second_approver_threshold", "maker_checker_differ", "branch_scoping",
    "auto_approve_score", "weight_change_needs_approval", "notifications",
}
_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


class SettingsUpdate(BaseModel):
    # All optional — only dirty fields are sent.
    calling_window_start: Optional[str] = None
    calling_window_end: Optional[str] = None
    max_retries_per_day: Optional[int] = None
    caller_id_pool: Optional[str] = None
    pause_outbound: Optional[bool] = None
    second_approver_threshold: Optional[float] = None
    maker_checker_differ: Optional[bool] = None
    branch_scoping: Optional[bool] = None
    auto_approve_score: Optional[int] = None
    weight_change_needs_approval: Optional[bool] = None
    notifications: Optional[list] = None


class ChangeRequest(BaseModel):
    item: str
    message: Optional[str] = None


async def _ensure_settings(bank_id: str) -> asyncpg.Record:
    """Return the bank_settings row, creating a default one if absent."""
    row = await _db().fetchrow("SELECT * FROM bank_settings WHERE bank_id = $1", uuid.UUID(bank_id))
    if row is None:
        await _db().execute(
            "INSERT INTO bank_settings (bank_id) VALUES ($1) ON CONFLICT (bank_id) DO NOTHING",
            uuid.UUID(bank_id),
        )
        row = await _db().fetchrow("SELECT * FROM bank_settings WHERE bank_id = $1", uuid.UUID(bank_id))
    return row


@router.get("/settings")
async def get_settings(admin: dict = Depends(get_bank_admin)):
    """The four editable sections + the read-only VG-managed section."""
    import json
    bank_id = admin["bank_id"]
    s = await _ensure_settings(bank_id)
    bank = await _db().fetchrow(
        "SELECT seat_cap, minute_quota, recording_retention_days, pii_redaction, account_manager "
        "FROM banks WHERE id = $1", uuid.UUID(bank_id)
    )
    # Scorecard active version metadata. The scorecard config is a single global
    # row (migration_v20, no per-bank column, no author) — so we can only surface
    # when it was last published, not a version number or author. The settings
    # card notes this and links to /bank/scorecard for the full editor.
    scorecard_version = None
    try:
        cfg = await _db().fetchrow("SELECT updated_at FROM lrs_scorecard_config WHERE id = 1")
        if cfg:
            scorecard_version = {"updated_at": cfg["updated_at"].isoformat() if cfg["updated_at"] else None}
    except Exception:
        scorecard_version = None  # table absent; the card degrades gracefully

    editable = _row(s)
    # notifications is JSONB → asyncpg returns a str; normalise to a list.
    notif = editable.get("notifications")
    if isinstance(notif, str):
        try:
            editable["notifications"] = json.loads(notif)
        except Exception:
            editable["notifications"] = []

    return {
        "editable": editable,
        "managed": {
            "recording_retention_days": bank["recording_retention_days"],
            "pii_redaction": bank["pii_redaction"],
            "seat_cap": bank["seat_cap"],
            "minute_quota": bank["minute_quota"],
            "account_manager": bank["account_manager"] or "Your Virtual Galaxy account manager",
        },
        "scorecard_version": scorecard_version,
        "changed_by": editable.get("updated_by_name"),
        "changed_at": editable.get("updated_at"),
    }


@router.put("/settings")
async def put_settings(body: SettingsUpdate, admin: dict = Depends(get_bank_admin)):
    import json
    bank_id = admin["bank_id"]
    await _ensure_settings(bank_id)

    payload = {k: v for k, v in body.dict(exclude_unset=True).items() if k in _SETTINGS_FIELDS and v is not None}
    if not payload:
        raise HTTPException(400, "No changes to save.")

    # Light validation on the human-entered fields.
    for k in ("calling_window_start", "calling_window_end"):
        if k in payload and not _TIME_RE.match(str(payload[k])):
            raise HTTPException(400, "Calling window times must be 24-hour HH:MM.")
    if "max_retries_per_day" in payload and not (0 <= int(payload["max_retries_per_day"]) <= 10):
        raise HTTPException(400, "Retries per day must be between 0 and 10.")
    if "auto_approve_score" in payload and not (0 <= int(payload["auto_approve_score"]) <= 100):
        raise HTTPException(400, "Auto-approve score must be between 0 and 100.")

    # notifications is JSONB — serialise it; everything else binds directly.
    set_parts = []
    vals: list = []
    i = 1
    for k, v in payload.items():
        set_parts.append(f"{k} = ${i}")
        vals.append(json.dumps(v) if k == "notifications" else v)
        i += 1
    set_parts.append(f"updated_at = NOW()")
    set_parts.append(f"updated_by = ${i}")
    vals.append(uuid.UUID(admin["id"]))
    i += 1
    set_parts.append(f"updated_by_name = ${i}")
    vals.append(admin.get("full_name") or admin.get("name"))
    i += 1
    vals.append(uuid.UUID(bank_id))

    async with _db().acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"UPDATE bank_settings SET {', '.join(set_parts)} WHERE bank_id = ${i}", *vals)
            await log_activity(conn, bank_id, admin, "update_settings",
                               {"fields": list(payload.keys())})
    return await get_settings(admin)


@router.post("/change-requests")
async def create_change_request(body: ChangeRequest, admin: dict = Depends(get_bank_admin)):
    """File a 'Request a change' against a VG-managed setting. Never auto-applies."""
    bank_id = admin["bank_id"]
    item = (body.item or "").strip()
    if not item:
        raise HTTPException(400, "Which item do you want changed?")
    async with _db().acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "INSERT INTO bank_change_requests (bank_id, requested_by, requested_by_name, item, message) "
                "VALUES ($1,$2,$3,$4,$5) RETURNING *",
                uuid.UUID(bank_id), uuid.UUID(admin["id"]), admin.get("full_name") or admin.get("name"),
                item, body.message,
            )
            await log_activity(conn, bank_id, admin, "change_request", {"item": item})
    return {"request": _row(row)}
