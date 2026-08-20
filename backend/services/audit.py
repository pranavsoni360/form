"""Audit trail + geolocation helpers.

Powers the compliance audit stores (`login_audit`, `activity_log`) that ship with
the multi-bank schema: real-client-IP extraction (XFF/X-Real-IP aware, since the
app runs behind nginx), offline IP->geo resolution, a lightweight device
fingerprint, and best-effort writers.

Geo is OFFLINE: a MaxMind GeoLite2 / DB-IP `.mmdb` file read via `maxminddb`. No
per-request external call, so no client IP ever leaves the box (DPDP-safe). If
`GEOIP_DB_PATH` is unset or the file is missing, geo resolution is a graceful
no-op (location stays NULL) — everything else still records.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from typing import Optional

import jwt

logger = logging.getLogger("audit")

_JWT_SECRET = os.getenv("JWT_SECRET", "")

# Mutating paths NOT written to activity_log: auth (covered by login_audit),
# loopback webhooks, health probes, and the log-prune mutation. Everything else
# that mutates (POST/PUT/PATCH/DELETE) is recorded.
_ACTIVITY_DENY_PREFIXES = (
    "/api/auth",              # covered by login_audit
    "/api/realtime",          # high-frequency SSE token mints — noise
    "/api/agent/transcript",  # loopback webhook
    "/api/guarantor/",        # loopback webhook
    "/api/send-campaign",     # loopback-gated campaign trigger
    "/api/ops/errors/cleanup",
    "/healthz",
    "/readyz",
    "/version",
)
_MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# actor_type CHECK (shared by activity_log / application_status_log); coerce else.
_ACTIVITY_ACTOR_TYPES = frozenset(
    {"platform_admin", "bank_user", "vendor_user", "customer", "system", "agent"})


def _coerce_actor_type(t: Optional[str]) -> str:
    if t in _ACTIVITY_ACTOR_TYPES:
        return t
    return "customer" if t in (None, "anonymous") else "system"


# ── Client IP ───────────────────────────────────────────────────────────────
def get_client_ip(request) -> Optional[str]:
    """Real client IP. Prefers X-Real-IP (nginx sets it to the actual TCP peer,
    not spoofable when only nginx fronts the app), then the last hop of
    X-Forwarded-For (nginx appends the real peer last), then the direct peer."""
    xri = request.headers.get("x-real-ip")
    if xri and xri.strip():
        return xri.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else None


# ── Geolocation (offline mmdb) ──────────────────────────────────────────────
_geo_reader = None
_geo_loaded = False


def _geo():
    global _geo_reader, _geo_loaded
    if _geo_loaded:
        return _geo_reader
    _geo_loaded = True
    path = os.getenv("GEOIP_DB_PATH")
    if not path or not os.path.exists(path):
        logger.info("GeoIP DB not provisioned (GEOIP_DB_PATH); geolocation disabled")
        return None
    try:
        import maxminddb
        _geo_reader = maxminddb.open_database(path)
        logger.info("GeoIP DB loaded from %s", path)
    except Exception as e:
        logger.warning("GeoIP DB load failed (%s): %s", path, e)
        _geo_reader = None
    return _geo_reader


def resolve_geo(ip: Optional[str]) -> Optional[dict]:
    """IP -> {country, country_code, region, city, lat, lon} or None. Handles
    both GeoLite2 and DB-IP mmdb schemas; never raises."""
    if not ip:
        return None
    reader = _geo()
    if not reader:
        return None
    try:
        rec = reader.get(ip)
        if not rec:
            return None

        def _en(node):
            return (node or {}).get("names", {}).get("en")

        subs = rec.get("subdivisions") or []
        geo = {
            "country": _en(rec.get("country")) or _en(rec.get("registered_country")),
            "country_code": (rec.get("country") or {}).get("iso_code"),
            "region": _en(subs[0]) if subs else None,
            "city": _en(rec.get("city")),
            "lat": (rec.get("location") or {}).get("latitude"),
            "lon": (rec.get("location") or {}).get("longitude"),
        }
        return geo if any(v is not None for v in geo.values()) else None
    except Exception as e:
        logger.debug("geo lookup failed for %s: %s", ip, e)
        return None


# ── Device fingerprint (server-side, lightweight) ───────────────────────────
def device_fingerprint(request) -> Optional[str]:
    """Coarse server-side fingerprint = hash(user-agent + accept-language). A
    true fingerprint needs a client-side JS signal; this is a stable-enough
    heuristic for spotting device changes without any client cooperation."""
    ua = request.headers.get("user-agent", "")
    al = request.headers.get("accept-language", "")
    if not ua and not al:
        return None
    return hashlib.sha256(f"{ua}|{al}".encode()).hexdigest()[:32]


# ── Actor from JWT (lightweight, never raises) ──────────────────────────────
def _as_uuid(v) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(v))
    except (ValueError, TypeError):
        return None


def decode_actor(request) -> dict:
    """Best-effort actor identity from the Bearer token. Returns
    {actor_type, actor_id(uuid|None), actor_username, actor_role, bank_id(uuid|None)}.
    Anonymous/unauthenticated requests -> actor_type='anonymous'."""
    anon = {"actor_type": "anonymous", "actor_id": None, "actor_username": None,
            "actor_role": None, "bank_id": None, "branch_id": None}
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer ") or not _JWT_SECRET:
        return anon
    try:
        payload = jwt.decode(auth.split(" ", 1)[1], _JWT_SECRET, algorithms=["HS256"])
    except Exception:
        return anon
    user_type = payload.get("user_type")
    actor_type = "platform_admin" if user_type == "admin" else (
        "bank_user" if user_type == "bank_user" else (user_type or "unknown"))
    return {
        "actor_type": actor_type,
        "actor_id": _as_uuid(payload.get("user_id") or payload.get("sub")),
        "actor_username": payload.get("email") or payload.get("username"),
        "actor_role": payload.get("role"),
        "bank_id": _as_uuid(payload.get("bank_id")),
        "branch_id": _as_uuid(payload.get("branch_id")),
    }


def should_log_activity(method: str, path: str) -> bool:
    if method.upper() not in _MUTATING:
        return False
    p = path.rstrip("/")
    return not any(p.startswith(pref.rstrip("/")) for pref in _ACTIVITY_DENY_PREFIXES)


def _module_of(path: str) -> str:
    """Coarse module label from the path, e.g. /api/bank/applications/... -> 'bank'."""
    parts = [s for s in path.split("/") if s]
    if len(parts) >= 2 and parts[0] == "api":
        return parts[1]
    return parts[0] if parts else "root"


# ── Writers ─────────────────────────────────────────────────────────────────
async def record_activity(pool, request, *, actor: dict, http_status: int,
                          duration_ms: Optional[int] = None,
                          request_id: Optional[str] = None) -> None:
    """Best-effort activity_log write for one mutating request. Never raises."""
    try:
        ip = get_client_ip(request)
        geo = resolve_geo(ip)
        if http_status < 400:
            result = "success"
        elif http_status in (401, 403):
            result = "denied"
        else:
            result = "failure"
        # anonymous public mutations are customer-facing; coerce to a valid enum.
        actor_type = _coerce_actor_type(actor["actor_type"])
        await pool.execute(
            """INSERT INTO activity_log
                   (actor_type, actor_id, actor_username, actor_role, bank_id, branch_id,
                    action, module, http_method, endpoint, http_status, result,
                    request_id, ip_address, machine_ip, machine_name, user_agent,
                    location, duration_ms)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)""",
            actor_type, actor["actor_id"], actor["actor_username"],
            actor["actor_role"], actor["bank_id"], actor.get("branch_id"),
            f"{request.method} {request.url.path}", _module_of(request.url.path),
            request.method, request.url.path, http_status, result,
            request_id, ip, _valid_inet(request.headers.get("x-machine-ip")),
            (request.headers.get("x-machine-name") or None), request.headers.get("user-agent"),
            json.dumps(geo) if geo else None, duration_ms,
        )
    except Exception as e:
        logger.warning("activity_log write failed for %s %s: %s",
                       request.method, request.url.path, e)


async def record_login_event(pool, *, event: str, actor_type: str, actor_id,
                             username: str, role: Optional[str], success: bool,
                             request=None, jti: Optional[str] = None,
                             bank_id: Optional[str] = None,
                             failure_reason: Optional[str] = None) -> None:
    """Best-effort login_audit write with IP + geo + device fingerprint. `event`
    is e.g. 'login_success', 'login_failed', 'logout'. Never raises."""
    try:
        ip = get_client_ip(request) if request else None
        geo = resolve_geo(ip)
        await pool.execute(
            """INSERT INTO login_audit
                   (event, actor_type, actor_id, username_tried, actor_username,
                    actor_role, bank_id, success, jti, failure_reason,
                    ip_address, user_agent, device_fingerprint, location)
               VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)""",
            event, actor_type, _as_uuid(actor_id) if actor_id else None,
            username, role, _as_uuid(bank_id) if bank_id else None,
            success, jti, failure_reason, ip,
            (request.headers.get("user-agent") if request else None),
            (device_fingerprint(request) if request else None),
            json.dumps(geo) if geo else None,
        )
    except Exception as e:
        logger.warning("login_audit write failed for %s: %s", username, e)


# ══════════════════════════════════════════════════════════════════════════
#  Semantic audit writers — one per purpose-built store. Every writer takes the
#  request (for the who/where envelope: IP, machine IP/name, geo, session,
#  request id) and is best-effort: a logging failure never breaks the action.
# ══════════════════════════════════════════════════════════════════════════

def _valid_inet(v: Optional[str]) -> Optional[str]:
    """Return v only if it parses as an IP address (INET columns reject junk)."""
    if not v:
        return None
    import ipaddress
    try:
        ipaddress.ip_address(v.split("/")[0].strip())
        return v.split("/")[0].strip()
    except (ValueError, AttributeError):
        return None


def audit_context(request) -> dict:
    """The shared who/where envelope for every semantic audit write.

    machine_ip / machine_name come from client-supplied headers (X-Machine-IP /
    X-Machine-Name) — a web server cannot see a workstation's LAN IP or hostname,
    so a desktop client, kiosk, or gateway must send them; NULL otherwise.
    """
    if request is None:
        return {"ip": None, "machine_ip": None, "machine_name": None,
                "user_agent": None, "geo": None, "session_id": None, "request_id": None}
    ip = get_client_ip(request)
    return {
        "ip": ip,
        "machine_ip": _valid_inet(request.headers.get("x-machine-ip")),
        "machine_name": (request.headers.get("x-machine-name") or None),
        "user_agent": request.headers.get("user-agent"),
        "geo": resolve_geo(ip),
        "session_id": (request.headers.get("x-session-id") or None),
        "request_id": (request.headers.get("x-request-id") or None),
    }


async def record_platform_audit(pool, request, *, actor: dict, action: str,
                                entity_type: str, entity_id=None, target_bank_id=None,
                                before=None, after=None, remark: Optional[str] = None,
                                status_reason: Optional[str] = None) -> None:
    """Super-admin / platform action → platform_audit_log (with before→after diff)."""
    try:
        c = audit_context(request)
        await pool.execute(
            """INSERT INTO platform_audit_log
                   (actor_id, actor_email, actor_role, action, entity_type, entity_id,
                    target_bank_id, before_data, after_data, remark, status_reason,
                    session_id, request_id, ip_address, machine_ip, machine_name,
                    user_agent, location)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)""",
            _as_uuid(actor.get("actor_id")), actor.get("actor_username"), actor.get("actor_role"),
            action, entity_type, _as_uuid(entity_id), _as_uuid(target_bank_id),
            json.dumps(before, default=str) if before is not None else None,
            json.dumps(after, default=str) if after is not None else None,
            remark, status_reason, c["session_id"], c["request_id"],
            c["ip"], c["machine_ip"], c["machine_name"], c["user_agent"],
            json.dumps(c["geo"]) if c["geo"] else None,
        )
    except Exception as e:
        logger.warning("platform_audit_log write failed (%s): %s", action, e)


async def record_officer_action(pool, request, *, application_id, bank_id, branch_id,
                               officer_id, officer_username, officer_role, action,
                               decision_level=None, from_status=None, to_status=None,
                               reason_code=None, reason_text=None, notes=None,
                               decided_amount=None, decided_tenure_m=None, decided_roi=None,
                               lrs_score=None) -> None:
    """Branch/officer loan decision → officer_action_log (LRS score, decided terms)."""
    try:
        c = audit_context(request)
        await pool.execute(
            """INSERT INTO officer_action_log
                   (application_id, bank_id, branch_id, officer_id, officer_username,
                    officer_role, action, decision_level, from_status, to_status,
                    reason_code, reason_text, notes, decided_amount, decided_tenure_m,
                    decided_roi, lrs_score_at_decision, session_id, request_id,
                    ip_address, machine_ip, machine_name, user_agent, location)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb)""",
            _as_uuid(application_id), _as_uuid(bank_id), _as_uuid(branch_id),
            _as_uuid(officer_id), officer_username, officer_role, action, decision_level,
            from_status, to_status, reason_code, reason_text, notes, decided_amount,
            decided_tenure_m, decided_roi, lrs_score, c["session_id"], c["request_id"],
            c["ip"], c["machine_ip"], c["machine_name"], c["user_agent"],
            json.dumps(c["geo"]) if c["geo"] else None,
        )
    except Exception as e:
        logger.warning("officer_action_log write failed (%s): %s", action, e)


async def record_status_change(pool, request, *, application_id, bank_id, branch_id=None,
                              from_status=None, to_status=None, actor: dict = None,
                              reason_code=None, reason_text=None, notes=None,
                              decided_amount=None, decided_tenure_m=None, decided_roi=None,
                              source="app", metadata=None) -> None:
    """Any loan status transition → application_status_log (the full status timeline).
    `source` must be one of {app, trigger_fallback, migration} (CHECK)."""
    try:
        actor = actor or {}
        c = audit_context(request)
        if source not in ("app", "trigger_fallback", "migration"):
            source = "app"
        await pool.execute(
            """INSERT INTO application_status_log
                   (application_id, bank_id, branch_id, from_status, to_status,
                    actor_type, actor_id, actor_username, actor_role, reason_code,
                    reason_text, notes, decided_amount, decided_tenure_m, decided_roi,
                    source, session_id, request_id, ip_address, machine_ip, machine_name,
                    user_agent, location, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb)""",
            _as_uuid(application_id), _as_uuid(bank_id), _as_uuid(branch_id),
            from_status, to_status, _coerce_actor_type(actor.get("actor_type")), _as_uuid(actor.get("actor_id")),
            actor.get("actor_username"), actor.get("actor_role"), reason_code, reason_text,
            notes, decided_amount, decided_tenure_m, decided_roi, source,
            c["session_id"], c["request_id"], c["ip"], c["machine_ip"], c["machine_name"],
            c["user_agent"], json.dumps(c["geo"]) if c["geo"] else None,
            json.dumps(metadata, default=str) if metadata else None,
        )
    except Exception as e:
        logger.warning("application_status_log write failed: %s", e)


async def record_field_history(pool, request, *, application_id, bank_id, branch_id=None,
                              actor: dict = None, changes: list = None,
                              value_source=None, step_number=None) -> None:
    """Field-level edits on an application → application_field_history. `changes`
    is a list of {field_key, field_label?, old_value, new_value, is_override?}."""
    if not changes:
        return
    try:
        actor = actor or {}
        c = audit_context(request)
        geo = json.dumps(c["geo"]) if c["geo"] else None
        rows = [
            (_as_uuid(application_id), _as_uuid(bank_id), _as_uuid(branch_id),
             ch.get("field_key"), ch.get("field_label"),
             None if ch.get("old_value") is None else str(ch.get("old_value")),
             None if ch.get("new_value") is None else str(ch.get("new_value")),
             value_source, bool(ch.get("is_override", False)), step_number,
             actor.get("actor_type"), _as_uuid(actor.get("actor_id")),
             actor.get("actor_username"), c["session_id"], c["request_id"],
             c["ip"], c["machine_ip"], c["machine_name"], c["user_agent"], geo)
            for ch in changes if ch.get("field_key")
        ]
        if rows:
            await pool.executemany(
                """INSERT INTO application_field_history
                       (application_id, bank_id, branch_id, field_key, field_label,
                        old_value, new_value, value_source, is_override, step_number,
                        actor_type, actor_id, actor_username, session_id, request_id,
                        ip_address, machine_ip, machine_name, user_agent, location)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)""",
                rows)
    except Exception as e:
        logger.warning("application_field_history write failed: %s", e)


async def record_sensitive_access(pool, request, *, actor: dict, action: str,
                                  entity_type: str, entity_id=None, phone=None,
                                  details=None) -> None:
    """Sensitive read/access (Aadhaar/PAN view, doc download, export, recording) or
    a customer-facing event → audit_logs (has phone + geolocation, no machine cols)."""
    try:
        actor = actor or {}
        c = audit_context(request)
        await pool.execute(
            """INSERT INTO audit_logs
                   (user_type, user_id, phone, action, entity_type, entity_id,
                    details, ip_address, user_agent, geolocation)
               VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb)""",
            actor.get("actor_type"), _as_uuid(actor.get("actor_id")), phone, action,
            entity_type, _as_uuid(entity_id),
            json.dumps(details, default=str) if details else None,
            c["ip"], c["user_agent"], json.dumps(c["geo"]) if c["geo"] else None,
        )
    except Exception as e:
        logger.warning("audit_logs write failed (%s): %s", action, e)
