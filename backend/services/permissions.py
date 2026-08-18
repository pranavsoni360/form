"""
Effective-permission resolution for bank users.

Authorisation used to be a set of role-string comparisons scattered across the
routers (`if user["role"] != "bank_supervisor"`). That worked while roles were a
fixed list, but it cannot express two things the bank-admin console now offers:

  1. a `custom` role, which by definition has no fixed permission set, and
  2. a per-person exception — "this supervisor may not disburse", or "give this
     one officer the recording-playback right".

So permissions move into data (migration_v40) and every gate resolves through
this module.

MODEL
    effective(user) = role_default(user.role) UNION grants EXCEPT revokes

Role defaults come from `bank_role_default_permissions`; per-user deltas from
`bank_user_permissions`, each row carrying effect='grant' or 'revoke'. A revoke
always beats the role default, and an explicit grant always beats the absence of
one — the two never conflict because (user_id, permission_code) is unique.

FAIL-CLOSED
Every helper here raises rather than returning a permissive default when the
lookup itself fails. A permissions layer that silently allows on error is worse
than none on a system that disburses money.
"""

from __future__ import annotations

from typing import Iterable, Optional

from fastapi import HTTPException


# ── resolution ───────────────────────────────────────────────────────────────

async def effective_permissions(db, user_id: str, role: str) -> set[str]:
    """
    Resolve the full permission set for one user.

    One round trip: role defaults and per-user deltas are combined in SQL so a
    permission check never costs two queries. `role` is passed in rather than
    re-read because every caller already holds the authenticated row.
    """
    rows = await db.fetch(
        """
        SELECT permission_code FROM bank_role_default_permissions
         WHERE role = $2
           AND permission_code NOT IN (
               SELECT permission_code FROM bank_user_permissions
                WHERE user_id = $1 AND effect = 'revoke'
           )
        UNION
        SELECT permission_code FROM bank_user_permissions
         WHERE user_id = $1 AND effect = 'grant'
        """,
        user_id,
        role,
    )
    return {r["permission_code"] for r in rows}


async def user_permission_detail(db, user_id: str, role: str) -> list[dict]:
    """
    Every catalogue permission with its state for this user, for the console grid.

    `source` tells the UI *why* a box is ticked, which is what makes the matrix
    editable rather than merely informative:
        role      — inherited from the role default, untouched
        granted   — explicitly added for this person
        revoked   — explicitly removed for this person
        none      — not held, and no override
    """
    rows = await db.fetch(
        """
        SELECT p.permission_code,
               p.category,
               p.description,
               p.is_dangerous,
               (rd.permission_code IS NOT NULL) AS role_default,
               up.effect,
               up.reason
          FROM permissions p
          LEFT JOIN bank_role_default_permissions rd
                 ON rd.permission_code = p.permission_code AND rd.role = $2
          LEFT JOIN bank_user_permissions up
                 ON up.permission_code = p.permission_code AND up.user_id = $1
         ORDER BY p.category, p.permission_code
        """,
        user_id,
        role,
    )

    out: list[dict] = []
    for r in rows:
        effect = r["effect"]
        role_default = bool(r["role_default"])
        if effect == "grant":
            allowed, source = True, "granted"
        elif effect == "revoke":
            allowed, source = False, "revoked"
        else:
            allowed, source = role_default, ("role" if role_default else "none")
        out.append({
            "permission_code": r["permission_code"],
            "category": r["category"],
            "description": r["description"],
            "is_dangerous": r["is_dangerous"],
            "role_default": role_default,
            "allowed": allowed,
            "source": source,
            "reason": r["reason"],
        })
    return out


async def role_default_permissions(db, role: str) -> set[str]:
    """The unmodified default set for a role — used to prefill the console grid."""
    rows = await db.fetch(
        "SELECT permission_code FROM bank_role_default_permissions WHERE role = $1",
        role,
    )
    return {r["permission_code"] for r in rows}


# ── writes ───────────────────────────────────────────────────────────────────

async def set_user_permissions(
    db,
    user_id: str,
    role: str,
    desired: Iterable[str],
    actor_id: Optional[str] = None,
    reason: Optional[str] = None,
) -> dict:
    """
    Persist a desired permission set as the minimum set of deltas.

    `desired` is what the admin ticked. We diff it against the role default and
    store ONLY the differences:
        in desired, not in default  -> grant
        in default, not in desired  -> revoke
        agreeing with the default   -> no row (inherit)

    Storing deltas rather than the full set is what lets a user pick up a newly
    added role default later instead of being frozen at today's list. It also
    means switching someone's role re-bases their permissions automatically,
    keeping only the exceptions that were deliberate.
    """
    desired_set = set(desired)

    valid = {r["permission_code"] for r in await db.fetch("SELECT permission_code FROM permissions")}
    unknown = desired_set - valid
    if unknown:
        # Reject rather than ignore: silently dropping an unknown code would tell
        # the admin they granted something they did not.
        raise HTTPException(400, f"Unknown permission code(s): {', '.join(sorted(unknown))}")

    defaults = await role_default_permissions(db, role)
    grants = desired_set - defaults
    revokes = defaults - desired_set

    async with db.acquire() as conn:
        async with conn.transaction():
            # Replace wholesale: the desired set is authoritative, so stale
            # deltas from a previous edit must not survive.
            await conn.execute("DELETE FROM bank_user_permissions WHERE user_id = $1", user_id)
            for code in sorted(grants):
                await conn.execute(
                    "INSERT INTO bank_user_permissions (user_id, permission_code, effect, reason, created_by) "
                    "VALUES ($1, $2, 'grant', $3, $4)",
                    user_id, code, reason, actor_id,
                )
            for code in sorted(revokes):
                await conn.execute(
                    "INSERT INTO bank_user_permissions (user_id, permission_code, effect, reason, created_by) "
                    "VALUES ($1, $2, 'revoke', $3, $4)",
                    user_id, code, reason, actor_id,
                )

    return {"granted": sorted(grants), "revoked": sorted(revokes)}


async def apply_invite_permissions(conn, user_id: str, role: str, overrides) -> None:
    """
    Copy an invite's stored permission choices onto the newly created user.

    Called inside the invite-acceptance transaction. `overrides` is the JSONB from
    bank_invites.permission_overrides — already in delta form, so it is inserted
    as-is rather than re-diffed. Unknown codes are skipped here (rather than
    raising) because the invite may predate a permission being renamed, and
    failing acceptance would lock the user out entirely.
    """
    if not overrides:
        return
    valid = {r["permission_code"] for r in await conn.fetch("SELECT permission_code FROM permissions")}
    for item in overrides:
        code = item.get("permission_code")
        effect = item.get("effect")
        if code not in valid or effect not in ("grant", "revoke"):
            continue
        await conn.execute(
            "INSERT INTO bank_user_permissions (user_id, permission_code, effect, reason) "
            "VALUES ($1, $2, $3, 'from invite') "
            "ON CONFLICT (user_id, permission_code) DO UPDATE SET effect = EXCLUDED.effect",
            user_id, code, effect,
        )


# ── gates ────────────────────────────────────────────────────────────────────

async def has_permission(db, user: dict, code: str) -> bool:
    """Non-raising check, for shaping a response rather than blocking it."""
    perms = await effective_permissions(db, str(user["id"]), user["role"])
    return code in perms


async def require_permission(db, user: dict, code: str) -> None:
    """
    Raise 403 unless the user holds `code`.

    Use in endpoints that previously compared role strings. The message names the
    missing permission so an admin can grant exactly that right rather than
    guessing which role to switch someone to.
    """
    if not await has_permission(db, user, code):
        raise HTTPException(403, f"Missing permission: {code}")
