"""Vendor portal — admin CRUD, partnerships, bank assignment, vendor self-serve.

Scope (Phase G Step 2):
    - Admin: vendor CRUD + vendor-user CRUD + bank<->vendor partnerships
    - Bank:  list partnered vendors + assign/withdraw an application
    - Vendor: login + me + assigned-apps list/detail + accept/reject/disburse
              + settlements list

State machine for application_vendor_assignments (enforced in code):
    pending → accepted | vendor_rejected | withdrawn
    accepted → disbursed | withdrawn
    Terminal: disbursed, vendor_rejected, withdrawn.

Settlement is created in the same transaction as the disburse transition so
we never have a 'disbursed' assignment without a matching settlement row.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

import asyncpg
import bcrypt
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field

logger = logging.getLogger(__name__)
security = HTTPBearer()


# ── pool/secret access (matches ops.py pattern) ────────────────────────────
def _db() -> asyncpg.Pool:
    import main as _main
    pool = getattr(_main, "db_pool", None)
    if pool is None:
        raise HTTPException(503, "database pool not ready")
    return pool


def _jwt_secret() -> str:
    import main as _main
    return _main.JWT_SECRET


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _row(r: asyncpg.Record | None) -> dict | None:
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


# ── auth dependencies ──────────────────────────────────────────────────────
async def get_current_vendor(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Decode vendor JWT. Returns vendor_user row + vendor_id."""
    try:
        payload = jwt.decode(credentials.credentials, _jwt_secret(), algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except Exception:
        raise HTTPException(401, "Invalid token")
    if payload.get("user_type") != "vendor":
        raise HTTPException(403, "Vendor access required")

    row = await _db().fetchrow(
        "SELECT vu.*, v.name AS vendor_name, v.status AS vendor_status "
        "FROM vendor_users vu JOIN vendors v ON v.id = vu.vendor_id "
        "WHERE vu.id = $1 AND vu.status = 'active'",
        uuid.UUID(payload["user_id"]),
    )
    if not row:
        raise HTTPException(401, "Vendor user not found or inactive")
    if row["vendor_status"] != "active":
        raise HTTPException(403, "Vendor account is not active")
    u = _row(row)
    u["vendor_id"] = str(row["vendor_id"])
    return u


async def get_current_admin_dep(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Re-uses main.get_current_admin (avoid circular import at module load)."""
    from main import get_current_admin
    return await get_current_admin(credentials)


async def get_current_bank_dep(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    from main import get_current_bank_user
    return await get_current_bank_user(credentials)


# ════════════════════════════════════════════════════════════════════════════
# ADMIN VENDOR CRUD
# ════════════════════════════════════════════════════════════════════════════
admin_router = APIRouter(prefix="/api/admin", tags=["admin-vendors"])


class VendorCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    code: str = Field(min_length=2, max_length=50)
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    pan_number: Optional[str] = None


class VendorUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=200)
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    pan_number: Optional[str] = None
    status: Optional[str] = Field(default=None, pattern="^(active|suspended|inactive)$")


@admin_router.get("/vendors")
async def list_vendors(
    status: Optional[str] = Query(default=None, pattern="^(active|suspended|inactive)$"),
    admin: dict = Depends(get_current_admin_dep),
):
    if status:
        rs = await _db().fetch("SELECT * FROM vendors WHERE status = $1 ORDER BY created_at DESC", status)
    else:
        rs = await _db().fetch("SELECT * FROM vendors ORDER BY created_at DESC")
    return {"vendors": _rows(rs)}


@admin_router.post("/vendors")
async def create_vendor(payload: VendorCreate, admin: dict = Depends(get_current_admin_dep)):
    try:
        row = await _db().fetchrow(
            "INSERT INTO vendors (name, code, contact_email, contact_phone, address, gstin, pan_number) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            payload.name, payload.code, payload.contact_email, payload.contact_phone,
            payload.address, payload.gstin, payload.pan_number,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, f"vendor code '{payload.code}' already exists")
    logger.info("vendor_created", extra={"vendor_id": str(row["id"]), "by_admin": admin["id"]})
    return _row(row)


@admin_router.get("/vendors/{vid}")
async def get_vendor(vid: str, admin: dict = Depends(get_current_admin_dep)):
    try:
        vuuid = uuid.UUID(vid)
    except ValueError:
        raise HTTPException(400, "invalid vendor id")
    v = await _db().fetchrow("SELECT * FROM vendors WHERE id = $1", vuuid)
    if not v:
        raise HTTPException(404, "vendor not found")
    users = await _db().fetch(
        "SELECT id, full_name, username, email, role, status, last_login_at, created_at "
        "FROM vendor_users WHERE vendor_id = $1 ORDER BY created_at",
        vuuid,
    )
    partnerships = await _db().fetch(
        "SELECT bvp.*, b.name AS bank_name, b.code AS bank_code "
        "FROM bank_vendor_partnerships bvp JOIN banks b ON b.id = bvp.bank_id "
        "WHERE bvp.vendor_id = $1 ORDER BY bvp.created_at DESC",
        vuuid,
    )
    return {"vendor": _row(v), "users": _rows(users), "partnerships": _rows(partnerships)}


@admin_router.patch("/vendors/{vid}")
async def update_vendor(vid: str, payload: VendorUpdate, admin: dict = Depends(get_current_admin_dep)):
    try:
        vuuid = uuid.UUID(vid)
    except ValueError:
        raise HTTPException(400, "invalid vendor id")

    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "no fields to update")

    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    args = [vuuid, *updates.values()]
    row = await _db().fetchrow(f"UPDATE vendors SET {sets}, updated_at = NOW() WHERE id = $1 RETURNING *", *args)
    if not row:
        raise HTTPException(404, "vendor not found")
    return _row(row)


@admin_router.delete("/vendors/{vid}")
async def deactivate_vendor(vid: str, admin: dict = Depends(get_current_admin_dep)):
    """Soft delete — set status=inactive. Hard delete would cascade to
    assignment history, which we never want to lose."""
    try:
        vuuid = uuid.UUID(vid)
    except ValueError:
        raise HTTPException(400, "invalid vendor id")
    row = await _db().fetchrow(
        "UPDATE vendors SET status = 'inactive', updated_at = NOW() WHERE id = $1 RETURNING id",
        vuuid,
    )
    if not row:
        raise HTTPException(404, "vendor not found")
    return {"ok": True, "id": vid, "status": "inactive"}


# ── vendor-user mgmt (admin) ───────────────────────────────────────────────
class VendorUserCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=200)
    username: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9_.-]+$")
    email: Optional[EmailStr] = None
    password: str = Field(min_length=8, max_length=128)
    role: str = Field(default="vendor", pattern="^(vendor|vendor_manager)$")


class VendorUserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    role: Optional[str] = Field(default=None, pattern="^(vendor|vendor_manager)$")
    status: Optional[str] = Field(default=None, pattern="^(active|disabled)$")
    password: Optional[str] = Field(default=None, min_length=8, max_length=128)


@admin_router.post("/vendors/{vid}/users")
async def create_vendor_user(vid: str, payload: VendorUserCreate, admin: dict = Depends(get_current_admin_dep)):
    try:
        vuuid = uuid.UUID(vid)
    except ValueError:
        raise HTTPException(400, "invalid vendor id")
    v = await _db().fetchrow("SELECT id FROM vendors WHERE id = $1", vuuid)
    if not v:
        raise HTTPException(404, "vendor not found")
    pw_hash = bcrypt.hashpw(payload.password.encode(), bcrypt.gensalt()).decode()
    try:
        row = await _db().fetchrow(
            "INSERT INTO vendor_users (vendor_id, full_name, username, email, password_hash, role) "
            "VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, vendor_id, full_name, username, email, role, status, created_at",
            vuuid, payload.full_name, payload.username, payload.email, pw_hash, payload.role,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, f"username '{payload.username}' already taken")
    return _row(row)


@admin_router.patch("/vendors/{vid}/users/{uid}")
async def update_vendor_user(vid: str, uid: str, payload: VendorUserUpdate, admin: dict = Depends(get_current_admin_dep)):
    try:
        vuuid, uuuid = uuid.UUID(vid), uuid.UUID(uid)
    except ValueError:
        raise HTTPException(400, "invalid id")

    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "no fields to update")
    if "password" in updates:
        updates["password_hash"] = bcrypt.hashpw(updates.pop("password").encode(), bcrypt.gensalt()).decode()

    sets = ", ".join(f"{k} = ${i+3}" for i, k in enumerate(updates))
    args = [vuuid, uuuid, *updates.values()]
    row = await _db().fetchrow(
        f"UPDATE vendor_users SET {sets}, updated_at = NOW() WHERE vendor_id = $1 AND id = $2 "
        "RETURNING id, vendor_id, full_name, username, email, role, status, last_login_at, updated_at",
        *args,
    )
    if not row:
        raise HTTPException(404, "vendor user not found")
    return _row(row)


# ════════════════════════════════════════════════════════════════════════════
# ADMIN BANK<->VENDOR PARTNERSHIPS (M:N)
# ════════════════════════════════════════════════════════════════════════════
class PartnershipCreate(BaseModel):
    bank_id: str
    vendor_id: str
    commission_pct: Optional[float] = Field(default=None, ge=0, le=100)
    notes: Optional[str] = None


class PartnershipUpdate(BaseModel):
    status: Optional[str] = Field(default=None, pattern="^(active|suspended|terminated)$")
    commission_pct: Optional[float] = Field(default=None, ge=0, le=100)
    notes: Optional[str] = None


@admin_router.get("/partnerships")
async def list_partnerships(
    bank_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    admin: dict = Depends(get_current_admin_dep),
):
    sql = (
        "SELECT bvp.*, b.name AS bank_name, b.code AS bank_code, b.vendor_limit, "
        "v.name AS vendor_name, v.code AS vendor_code "
        "FROM bank_vendor_partnerships bvp "
        "JOIN banks b ON b.id = bvp.bank_id "
        "JOIN vendors v ON v.id = bvp.vendor_id WHERE 1=1"
    )
    args: list = []
    if bank_id:
        args.append(uuid.UUID(bank_id)); sql += f" AND bvp.bank_id = ${len(args)}"
    if vendor_id:
        args.append(uuid.UUID(vendor_id)); sql += f" AND bvp.vendor_id = ${len(args)}"
    sql += " ORDER BY bvp.created_at DESC"
    rs = await _db().fetch(sql, *args)

    # Per-bank active counts so UI can show "5/10 used" without an extra round-trip.
    cap_rows = await _db().fetch(
        "SELECT b.id, b.vendor_limit, "
        "  COALESCE(SUM(CASE WHEN bvp.status='active' THEN 1 ELSE 0 END), 0)::int AS active_count "
        "FROM banks b LEFT JOIN bank_vendor_partnerships bvp ON bvp.bank_id = b.id "
        "GROUP BY b.id, b.vendor_limit"
    )
    bank_caps = {str(r["id"]): {"vendor_limit": r["vendor_limit"], "active_count": r["active_count"]} for r in cap_rows}
    return {"partnerships": _rows(rs), "bank_caps": bank_caps}


@admin_router.post("/partnerships")
async def create_partnership(payload: PartnershipCreate, admin: dict = Depends(get_current_admin_dep)):
    try:
        buid, vuid = uuid.UUID(payload.bank_id), uuid.UUID(payload.vendor_id)
    except ValueError:
        raise HTTPException(400, "invalid bank_id or vendor_id")

    # Enforce banks.vendor_limit — commercial cap per bank. Counted in the
    # same transaction as the insert so two simultaneous POSTs from the UI
    # can't both slip past the check.
    async with _db().acquire() as conn:
        async with conn.transaction():
            bank = await conn.fetchrow(
                "SELECT vendor_limit FROM banks WHERE id = $1 FOR UPDATE", buid,
            )
            if not bank:
                raise HTTPException(404, "bank not found")
            active_count = await conn.fetchval(
                "SELECT COUNT(*) FROM bank_vendor_partnerships "
                "WHERE bank_id = $1 AND status = 'active'",
                buid,
            )
            if active_count >= bank["vendor_limit"]:
                raise HTTPException(
                    409,
                    f"bank vendor_limit reached ({active_count}/{bank['vendor_limit']}). "
                    f"Raise the limit in /admin/banks before adding more partnerships.",
                )
            try:
                row = await conn.fetchrow(
                    "INSERT INTO bank_vendor_partnerships (bank_id, vendor_id, commission_pct, notes) "
                    "VALUES ($1,$2,$3,$4) RETURNING *",
                    buid, vuid, payload.commission_pct, payload.notes,
                )
            except asyncpg.UniqueViolationError:
                raise HTTPException(409, "partnership already exists for this bank+vendor")
            except asyncpg.ForeignKeyViolationError:
                raise HTTPException(404, "vendor not found")
    return _row(row)


@admin_router.patch("/partnerships/{pid}")
async def update_partnership(pid: str, payload: PartnershipUpdate, admin: dict = Depends(get_current_admin_dep)):
    try:
        puid = uuid.UUID(pid)
    except ValueError:
        raise HTTPException(400, "invalid partnership id")
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "no fields to update")
    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    args = [puid, *updates.values()]
    row = await _db().fetchrow(
        f"UPDATE bank_vendor_partnerships SET {sets}, updated_at = NOW() WHERE id = $1 RETURNING *", *args,
    )
    if not row:
        raise HTTPException(404, "partnership not found")
    return _row(row)


@admin_router.delete("/partnerships/{pid}")
async def terminate_partnership(pid: str, admin: dict = Depends(get_current_admin_dep)):
    try:
        puid = uuid.UUID(pid)
    except ValueError:
        raise HTTPException(400, "invalid partnership id")
    row = await _db().fetchrow(
        "UPDATE bank_vendor_partnerships SET status = 'terminated', updated_at = NOW() "
        "WHERE id = $1 RETURNING id",
        puid,
    )
    if not row:
        raise HTTPException(404, "partnership not found")
    return {"ok": True, "id": pid, "status": "terminated"}


# ════════════════════════════════════════════════════════════════════════════
# BANK-SIDE: list partnered vendors, assign/withdraw
# ════════════════════════════════════════════════════════════════════════════
bank_router = APIRouter(prefix="/api/bank", tags=["bank-vendors"])


class AssignVendor(BaseModel):
    vendor_id: str
    notes: Optional[str] = None


@bank_router.get("/vendors")
async def bank_list_partnered_vendors(bank: dict = Depends(get_current_bank_dep)):
    """Vendors this bank can assign applications to (active partnerships only)."""
    rs = await _db().fetch(
        "SELECT v.id, v.name, v.code, v.status, bvp.commission_pct, bvp.id AS partnership_id "
        "FROM bank_vendor_partnerships bvp JOIN vendors v ON v.id = bvp.vendor_id "
        "WHERE bvp.bank_id = $1 AND bvp.status = 'active' AND v.status = 'active' "
        "ORDER BY v.name",
        uuid.UUID(bank["bank_id"]),
    )
    return {"vendors": _rows(rs)}


@bank_router.post("/applications/{aid}/assign-vendor")
async def bank_assign_vendor(aid: str, payload: AssignVendor, bank: dict = Depends(get_current_bank_dep)):
    """Assign an approved application to a vendor for disbursement.

    Guards:
      - app must belong to bank
      - app status must be 'approved' (not draft/rejected)
      - vendor must have active partnership with bank
      - no other active (pending/accepted) assignment for this app
    """
    try:
        auid, vuid = uuid.UUID(aid), uuid.UUID(payload.vendor_id)
    except ValueError:
        raise HTTPException(400, "invalid application or vendor id")

    bank_uuid = uuid.UUID(bank["bank_id"])

    async with _db().acquire() as conn:
        async with conn.transaction():
            app = await conn.fetchrow(
                "SELECT id, status, bank_id FROM loan_applications WHERE id = $1 FOR UPDATE",
                auid,
            )
            if not app:
                raise HTTPException(404, "application not found")
            if app["bank_id"] != bank_uuid:
                raise HTTPException(403, "application does not belong to your bank")
            if app["status"] != "approved":
                raise HTTPException(
                    400, f"only approved applications can be assigned (current: {app['status']})"
                )

            partnership = await conn.fetchrow(
                "SELECT id FROM bank_vendor_partnerships "
                "WHERE bank_id = $1 AND vendor_id = $2 AND status = 'active'",
                bank_uuid, vuid,
            )
            if not partnership:
                raise HTTPException(400, "no active partnership with that vendor")

            try:
                row = await conn.fetchrow(
                    "INSERT INTO application_vendor_assignments "
                    "(application_id, vendor_id, bank_id, assigned_by_type, assigned_by_id, notes) "
                    "VALUES ($1,$2,$3,'bank_user',$4,$5) RETURNING *",
                    auid, vuid, bank_uuid, uuid.UUID(bank["id"]), payload.notes,
                )
            except asyncpg.UniqueViolationError:
                raise HTTPException(409, "application already has an active assignment")

    # Fan out to realtime — vendor dashboards refresh
    try:
        from lib.event_bus import event_bus
        event_bus.publish("calls", {"type": "vendor_assigned", "application_id": aid, "vendor_id": payload.vendor_id})
    except Exception:
        logger.exception("event_bus publish failed for vendor_assigned")

    logger.info("vendor_assigned", extra={"application_id": aid, "vendor_id": payload.vendor_id, "by_bank_user": bank["id"]})
    return _row(row)


@bank_router.post("/applications/{aid}/withdraw-assignment")
async def bank_withdraw_assignment(aid: str, bank: dict = Depends(get_current_bank_dep)):
    """Bank cancels the active assignment (vendor stops working on it). App
    returns to 'approved' and is free to be reassigned."""
    try:
        auid = uuid.UUID(aid)
    except ValueError:
        raise HTTPException(400, "invalid application id")
    bank_uuid = uuid.UUID(bank["bank_id"])

    async with _db().acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT id, status FROM application_vendor_assignments "
                "WHERE application_id = $1 AND bank_id = $2 AND status IN ('pending','accepted') "
                "FOR UPDATE",
                auid, bank_uuid,
            )
            if not row:
                raise HTTPException(404, "no active assignment to withdraw")
            updated = await conn.fetchrow(
                "UPDATE application_vendor_assignments "
                "SET status = 'withdrawn', withdrawn_at = NOW(), withdrawn_by_id = $1, updated_at = NOW() "
                "WHERE id = $2 RETURNING *",
                uuid.UUID(bank["id"]), row["id"],
            )
    return _row(updated)


@bank_router.get("/applications/{aid}/assignments")
async def bank_assignment_history(aid: str, bank: dict = Depends(get_current_bank_dep)):
    """Audit trail — every vendor this app was ever assigned to."""
    try:
        auid = uuid.UUID(aid)
    except ValueError:
        raise HTTPException(400, "invalid application id")
    rs = await _db().fetch(
        "SELECT ava.*, v.name AS vendor_name, v.code AS vendor_code "
        "FROM application_vendor_assignments ava JOIN vendors v ON v.id = ava.vendor_id "
        "WHERE ava.application_id = $1 AND ava.bank_id = $2 "
        "ORDER BY ava.assigned_at DESC",
        auid, uuid.UUID(bank["bank_id"]),
    )
    return {"assignments": _rows(rs)}


# ════════════════════════════════════════════════════════════════════════════
# VENDOR SELF-SERVE
# ════════════════════════════════════════════════════════════════════════════
vendor_router = APIRouter(prefix="/api/vendor", tags=["vendor"])


class VendorLogin(BaseModel):
    username: str
    password: str


@vendor_router.post("/login")
async def vendor_login(payload: VendorLogin):
    row = await _db().fetchrow(
        "SELECT vu.*, v.name AS vendor_name, v.status AS vendor_status "
        "FROM vendor_users vu JOIN vendors v ON v.id = vu.vendor_id "
        "WHERE vu.username = $1",
        payload.username,
    )
    if not row or not bcrypt.checkpw(payload.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Invalid username or password")
    if row["status"] != "active":
        raise HTTPException(403, "Vendor user disabled")
    if row["vendor_status"] != "active":
        raise HTTPException(403, "Vendor account is not active")

    token = jwt.encode(
        {
            "user_id": str(row["id"]),
            "vendor_id": str(row["vendor_id"]),
            "username": row["username"],
            "role": row["role"],
            "user_type": "vendor",
            "exp": _now() + timedelta(days=7),
        },
        _jwt_secret(),
        algorithm="HS256",
    )
    await _db().execute(
        "UPDATE vendor_users SET last_login_at = $1 WHERE id = $2", _now(), row["id"]
    )
    return {
        "token": token,
        "user": {
            "id": str(row["id"]),
            "username": row["username"],
            "name": row["full_name"],
            "role": row["role"],
            "vendor_id": str(row["vendor_id"]),
            "vendor_name": row["vendor_name"],
        },
    }


@vendor_router.get("/me")
async def vendor_me(vendor: dict = Depends(get_current_vendor)):
    return {
        "id": vendor["id"],
        "username": vendor["username"],
        "name": vendor["full_name"],
        "role": vendor["role"],
        "vendor_id": vendor["vendor_id"],
        "vendor_name": vendor["vendor_name"],
    }


@vendor_router.get("/applications")
async def vendor_list_applications(
    status: Optional[str] = Query(default=None, pattern="^(pending|accepted|disbursed|vendor_rejected|withdrawn)$"),
    vendor: dict = Depends(get_current_vendor),
):
    """List assignments for this vendor — newest first."""
    sql = (
        "SELECT ava.*, la.requested_loan_amount, la.status AS app_status, "
        "la.customer_name, la.phone, b.name AS bank_name "
        "FROM application_vendor_assignments ava "
        "JOIN loan_applications la ON la.id = ava.application_id "
        "JOIN banks b ON b.id = ava.bank_id "
        "WHERE ava.vendor_id = $1"
    )
    args: list = [uuid.UUID(vendor["vendor_id"])]
    if status:
        args.append(status); sql += f" AND ava.status = ${len(args)}"
    sql += " ORDER BY ava.assigned_at DESC LIMIT 200"
    rs = await _db().fetch(sql, *args)
    return {"applications": _rows(rs)}


@vendor_router.get("/applications/{aid}")
async def vendor_get_application(aid: str, vendor: dict = Depends(get_current_vendor)):
    try:
        auid = uuid.UUID(aid)
    except ValueError:
        raise HTTPException(400, "invalid application id")
    row = await _db().fetchrow(
        "SELECT ava.*, la.*, b.name AS bank_name "
        "FROM application_vendor_assignments ava "
        "JOIN loan_applications la ON la.id = ava.application_id "
        "JOIN banks b ON b.id = ava.bank_id "
        "WHERE ava.application_id = $1 AND ava.vendor_id = $2 "
        "ORDER BY ava.assigned_at DESC LIMIT 1",
        auid, uuid.UUID(vendor["vendor_id"]),
    )
    if not row:
        raise HTTPException(404, "assignment not found for this vendor")
    # Resolve coded columns (employment_type, etc.) to human labels so the
    # vendor screen shows "Salaried (Private MNC)" not "260493".
    import main as _main
    return _main._attach_code_labels(_row(row))


def _require_active_assignment(conn, ava_uuid: uuid.UUID, vendor_uuid: uuid.UUID):
    """Lookup helper — returns assignment row with FOR UPDATE lock, ensures vendor owns it."""
    return conn.fetchrow(
        "SELECT * FROM application_vendor_assignments "
        "WHERE id = $1 AND vendor_id = $2 FOR UPDATE",
        ava_uuid, vendor_uuid,
    )


@vendor_router.post("/assignments/{ava_id}/accept")
async def vendor_accept(ava_id: str, vendor: dict = Depends(get_current_vendor)):
    try:
        ava_uuid = uuid.UUID(ava_id)
    except ValueError:
        raise HTTPException(400, "invalid assignment id")
    vendor_uuid = uuid.UUID(vendor["vendor_id"])

    async with _db().acquire() as conn:
        async with conn.transaction():
            row = await _require_active_assignment(conn, ava_uuid, vendor_uuid)
            if not row:
                raise HTTPException(404, "assignment not found")
            if row["status"] != "pending":
                raise HTTPException(400, f"cannot accept from status '{row['status']}' — only 'pending' allowed")
            updated = await conn.fetchrow(
                "UPDATE application_vendor_assignments SET status = 'accepted', updated_at = NOW() "
                "WHERE id = $1 RETURNING *",
                ava_uuid,
            )
    return _row(updated)


class VendorReject(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


@vendor_router.post("/assignments/{ava_id}/reject")
async def vendor_reject(ava_id: str, payload: VendorReject, vendor: dict = Depends(get_current_vendor)):
    try:
        ava_uuid = uuid.UUID(ava_id)
    except ValueError:
        raise HTTPException(400, "invalid assignment id")
    vendor_uuid = uuid.UUID(vendor["vendor_id"])

    async with _db().acquire() as conn:
        async with conn.transaction():
            row = await _require_active_assignment(conn, ava_uuid, vendor_uuid)
            if not row:
                raise HTTPException(404, "assignment not found")
            if row["status"] not in ("pending", "accepted"):
                raise HTTPException(400, f"cannot reject from status '{row['status']}'")
            updated = await conn.fetchrow(
                "UPDATE application_vendor_assignments "
                "SET status = 'vendor_rejected', rejected_at = NOW(), rejection_reason = $1, updated_at = NOW() "
                "WHERE id = $2 RETURNING *",
                payload.reason, ava_uuid,
            )
    logger.info("vendor_rejected_app", extra={"assignment_id": ava_id, "vendor_id": vendor["vendor_id"], "reason": payload.reason[:100]})
    return _row(updated)


class VendorDisburse(BaseModel):
    disbursed_amount: float = Field(gt=0)
    disbursement_ref: str = Field(min_length=2, max_length=100)


@vendor_router.post("/assignments/{ava_id}/disburse")
async def vendor_disburse(ava_id: str, payload: VendorDisburse, vendor: dict = Depends(get_current_vendor)):
    """Mark as disbursed + create matching settlement row in one transaction.

    Also updates loan_applications.status='disbursed' + sets disbursed_at.
    Commission is snapshotted from current partnership rate so retroactive
    rate changes don't mutate historical settlements.
    """
    try:
        ava_uuid = uuid.UUID(ava_id)
    except ValueError:
        raise HTTPException(400, "invalid assignment id")
    vendor_uuid = uuid.UUID(vendor["vendor_id"])

    async with _db().acquire() as conn:
        async with conn.transaction():
            row = await _require_active_assignment(conn, ava_uuid, vendor_uuid)
            if not row:
                raise HTTPException(404, "assignment not found")
            if row["status"] != "accepted":
                raise HTTPException(400, f"only 'accepted' assignments can be disbursed (current: {row['status']})")

            # Money must never leave a voided application. Lock the loan row and
            # re-check its status inside this transaction (a concurrent bank-side
            # cancel/withdraw will serialise against this lock).
            loan_status = await conn.fetchval(
                "SELECT status FROM loan_applications WHERE id = $1 FOR UPDATE",
                row["application_id"],
            )
            if loan_status in ("cancelled", "withdrawn"):
                raise HTTPException(409, f"Cannot disburse — the loan application is '{loan_status}'.")

            # Snapshot commission from current partnership
            commission_pct = await conn.fetchval(
                "SELECT commission_pct FROM bank_vendor_partnerships "
                "WHERE bank_id = $1 AND vendor_id = $2 AND status = 'active'",
                row["bank_id"], vendor_uuid,
            )
            amount = Decimal(str(payload.disbursed_amount))
            commission_amount = (amount * Decimal(str(commission_pct)) / Decimal("100")) if commission_pct else None
            bank_payout = (amount - commission_amount) if commission_amount is not None else None

            updated = await conn.fetchrow(
                "UPDATE application_vendor_assignments "
                "SET status = 'disbursed', disbursed_amount = $1, disbursed_at = NOW(), "
                "    disbursement_ref = $2, updated_at = NOW() "
                "WHERE id = $3 RETURNING *",
                amount, payload.disbursement_ref, ava_uuid,
            )

            settlement = await conn.fetchrow(
                "INSERT INTO vendor_settlements "
                "(vendor_id, bank_id, assignment_id, application_id, amount, "
                " commission_pct, commission_amount, bank_payout) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
                vendor_uuid, row["bank_id"], ava_uuid, row["application_id"],
                amount, commission_pct, commission_amount, bank_payout,
            )

            # Stamp loan_applications.disbursed_at as the signal. The
            # check constraint on loan_applications.status does NOT include
            # 'disbursed' (terminal status for the bank-side workflow ends at
            # 'approved'), so the assignment row + disbursed_at IS NOT NULL
            # together signal "money out". Adding a new enum value would
            # require a downstream migration + UI changes we don't need yet.
            await conn.execute(
                "UPDATE loan_applications SET disbursed_at = NOW() WHERE id = $1",
                row["application_id"],
            )

    try:
        from lib.event_bus import event_bus
        event_bus.publish("calls", {
            "type": "vendor_disbursed",
            "application_id": str(row["application_id"]),
            "vendor_id": vendor["vendor_id"],
            "amount": float(amount),
        })
    except Exception:
        logger.exception("event_bus publish failed for vendor_disbursed")

    logger.info(
        "vendor_disbursed_app",
        extra={
            "assignment_id": ava_id,
            "vendor_id": vendor["vendor_id"],
            "amount": float(amount),
            "ref": payload.disbursement_ref,
        },
    )
    return {"assignment": _row(updated), "settlement": _row(settlement)}


@vendor_router.get("/settlements")
async def vendor_list_settlements(
    status: Optional[str] = Query(default=None, pattern="^(pending|paid|failed|disputed)$"),
    vendor: dict = Depends(get_current_vendor),
):
    sql = (
        "SELECT vs.*, b.name AS bank_name, la.customer_name "
        "FROM vendor_settlements vs "
        "JOIN banks b ON b.id = vs.bank_id "
        "JOIN loan_applications la ON la.id = vs.application_id "
        "WHERE vs.vendor_id = $1"
    )
    args: list = [uuid.UUID(vendor["vendor_id"])]
    if status:
        args.append(status); sql += f" AND vs.status = ${len(args)}"
    sql += " ORDER BY vs.created_at DESC LIMIT 200"
    rs = await _db().fetch(sql, *args)
    total = await _db().fetchrow(
        "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total_amount, "
        "COALESCE(SUM(commission_amount),0) AS total_commission "
        "FROM vendor_settlements WHERE vendor_id = $1",
        uuid.UUID(vendor["vendor_id"]),
    )
    return {"settlements": _rows(rs), "summary": _row(total)}
