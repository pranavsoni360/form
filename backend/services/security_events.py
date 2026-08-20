"""Security-events layer — detectors + writer on top of the audit stores.

Detectors flag anomalies (new device / new location / off-hours login,
failed-login bursts, privilege changes, blocked internal-path hits, mass
sensitive access) into `security_events`, tier-scoped by bank_id/branch_id.

Everything here is BEST-EFFORT: a detection or write failure must never break
the underlying login/decision/request.

"Alert" = the row (surfaced, unacknowledged, in the tiered dashboards) plus a
logger.warning for high/critical severity, which flows to the existing Sentry /
Telegram error pipeline. Richer notification can hook record_security_event.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from services import audit as _audit

logger = logging.getLogger("security")

_IST = timezone(timedelta(hours=5, minutes=30))
# Off-hours window: access outside [start, end) local (IST) is flagged.
_OFF_START = int(os.getenv("SECURITY_BUSINESS_START_HOUR", "6"))
_OFF_END = int(os.getenv("SECURITY_BUSINESS_END_HOUR", "21"))
# Sensitive-access burst threshold (events per rolling window).
_MASS_ACCESS_N = int(os.getenv("SECURITY_MASS_ACCESS_THRESHOLD", "25"))
_MASS_ACCESS_MIN = int(os.getenv("SECURITY_MASS_ACCESS_WINDOW_MIN", "10"))


async def record_security_event(pool, request=None, *, event_type: str, severity: str,
                                title: str, actor: dict | None = None, bank_id=None,
                                branch_id=None, description: str | None = None,
                                entity_type: str | None = None, entity_id=None,
                                metadata: dict | None = None) -> None:
    """Write one security_events row (best-effort). High/critical also log-warn."""
    import json
    try:
        actor = actor or {}
        c = _audit.audit_context(request)
        await pool.execute(
            """INSERT INTO security_events
                   (event_type, severity, actor_type, actor_id, actor_username, actor_role,
                    bank_id, branch_id, title, description, entity_type, entity_id,
                    ip_address, machine_ip, machine_name, user_agent, location,
                    session_id, request_id, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20::jsonb)""",
            event_type, severity, actor.get("actor_type"), _audit._as_uuid(actor.get("actor_id")),
            actor.get("actor_username"), actor.get("actor_role"),
            _audit._as_uuid(bank_id), _audit._as_uuid(branch_id), title, description,
            entity_type, _audit._as_uuid(entity_id), c["ip"], c["machine_ip"], c["machine_name"],
            c["user_agent"], json.dumps(c["geo"]) if c["geo"] else None,
            c["session_id"], c["request_id"],
            json.dumps(metadata, default=str) if metadata else None,
        )
        if severity in ("high", "critical"):
            logger.warning("SECURITY[%s/%s] %s (actor=%s bank=%s)", severity, event_type,
                           title, actor.get("actor_username"), bank_id)
    except Exception as e:
        logger.warning("security_event write failed (%s): %s", event_type, e)


async def check_login_anomalies(pool, request, *, actor_id, actor_type, actor_username,
                                actor_role, bank_id=None, branch_id=None) -> None:
    """Run AFTER a successful login row is written. Emits new-device / new-location
    / off-hours events by comparing this login to the actor's login history."""
    if not actor_id:
        return
    try:
        actor = {"actor_type": actor_type, "actor_id": actor_id,
                 "actor_username": actor_username, "actor_role": actor_role}
        auid = _audit._as_uuid(actor_id)
        total = await pool.fetchval(
            "SELECT count(*) FROM login_audit WHERE actor_id=$1 AND event='login_success'", auid) or 0
        # First-ever successful login is not an anomaly (nothing to compare to).
        if total > 1:
            fp = _audit.device_fingerprint(request)
            if fp:
                seen = await pool.fetchval(
                    "SELECT count(*) FROM login_audit WHERE actor_id=$1 AND event='login_success' AND device_fingerprint=$2",
                    auid, fp) or 0
                if seen <= 1:
                    await record_security_event(
                        pool, request, event_type="new_device_login", severity="medium",
                        title=f"Login from a new device for {actor_username}",
                        actor=actor, bank_id=bank_id, branch_id=branch_id,
                        description="A device fingerprint not seen before for this user.",
                        metadata={"device_fingerprint": fp})
            geo = _audit.resolve_geo(_audit.get_client_ip(request))
            city = (geo or {}).get("city")
            country = (geo or {}).get("country")
            if city:
                seen_loc = await pool.fetchval(
                    "SELECT count(*) FROM login_audit WHERE actor_id=$1 AND event='login_success' AND location->>'city'=$2",
                    auid, city) or 0
                if seen_loc <= 1:
                    await record_security_event(
                        pool, request, event_type="new_location_login", severity="medium",
                        title=f"Login from a new location ({city}, {country}) for {actor_username}",
                        actor=actor, bank_id=bank_id, branch_id=branch_id,
                        description="A city not seen before for this user.",
                        metadata={"city": city, "country": country})
        # Off-hours (independent of history).
        hour = datetime.now(_IST).hour
        if hour < _OFF_START or hour >= _OFF_END:
            await record_security_event(
                pool, request, event_type="off_hours_login", severity="low",
                title=f"Off-hours login for {actor_username} ({hour:02d}:xx IST)",
                actor=actor, bank_id=bank_id, branch_id=branch_id,
                description=f"Login outside business hours ({_OFF_START:02d}:00–{_OFF_END:02d}:00 IST).",
                metadata={"hour_ist": hour})
    except Exception as e:
        logger.warning("login anomaly check failed for %s: %s", actor_username, e)


async def record_failed_login_burst(pool, request, *, username, actor_id=None,
                                    actor_type="bank_user", bank_id=None, attempts=None) -> None:
    """Emit on lockout / repeated failed logins."""
    await record_security_event(
        pool, request, event_type="failed_login_burst", severity="high",
        title=f"Account locked after repeated failed logins: {username}",
        actor={"actor_type": actor_type, "actor_id": actor_id, "actor_username": username},
        bank_id=bank_id, description="Multiple failed login attempts triggered a lockout.",
        metadata={"attempts": attempts})


async def record_privilege_change(pool, request, *, actor: dict, target_user_id, bank_id,
                                  branch_id=None, change: dict) -> None:
    """Emit when a user's role or permissions change (privilege escalation risk)."""
    await record_security_event(
        pool, request, event_type="privilege_change", severity="high",
        title="User role/permissions changed",
        actor=actor, bank_id=bank_id, branch_id=branch_id,
        entity_type="bank_user", entity_id=target_user_id,
        description="A user's role or permission set was modified.", metadata=change)


async def record_blocked_path(pool, request, *, path, peer) -> None:
    """Emit when the internal-path guard blocks an external hit (probe/attack)."""
    await record_security_event(
        pool, request, event_type="blocked_internal_path", severity="high",
        title=f"Blocked external hit on internal path {path}",
        actor=_audit.decode_actor(request),
        description="A request to a loopback-only internal path arrived from outside.",
        metadata={"path": path, "peer": peer})


async def check_mass_sensitive_access(pool, request, *, actor: dict, bank_id=None) -> None:
    """Emit if this actor has crossed the sensitive-access burst threshold recently."""
    try:
        auid = _audit._as_uuid(actor.get("actor_id"))
        if not auid:
            return
        n = await pool.fetchval(
            "SELECT count(*) FROM audit_logs WHERE user_id=$1 AND timestamp > NOW() - ($2 || ' minutes')::interval",
            auid, str(_MASS_ACCESS_MIN)) or 0
        if n == _MASS_ACCESS_N:  # fire once, exactly at the threshold crossing
            await record_security_event(
                pool, request, event_type="mass_sensitive_access", severity="high",
                title=f"High volume of sensitive access by {actor.get('actor_username')}",
                actor=actor, bank_id=bank_id,
                description=f"{n} sensitive reads/exports in {_MASS_ACCESS_MIN} minutes.",
                metadata={"count": n, "window_min": _MASS_ACCESS_MIN})
    except Exception as e:
        logger.warning("mass-access check failed: %s", e)
