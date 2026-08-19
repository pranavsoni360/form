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

# activity_log.actor_type CHECK allows only these; coerce anything else.
_ACTIVITY_ACTOR_TYPES = frozenset(
    {"platform_admin", "bank_user", "vendor_user", "customer", "system", "agent"})


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
            "actor_role": None, "bank_id": None}
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
        actor_type = actor["actor_type"]
        if actor_type not in _ACTIVITY_ACTOR_TYPES:
            actor_type = "customer" if actor_type == "anonymous" else "system"
        await pool.execute(
            """INSERT INTO activity_log
                   (actor_type, actor_id, actor_username, actor_role, bank_id,
                    action, module, http_method, endpoint, http_status, result,
                    request_id, ip_address, user_agent, location, duration_ms)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)""",
            actor_type, actor["actor_id"], actor["actor_username"],
            actor["actor_role"], actor["bank_id"],
            f"{request.method} {request.url.path}", _module_of(request.url.path),
            request.method, request.url.path, http_status, result,
            request_id, ip, request.headers.get("user-agent"),
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
