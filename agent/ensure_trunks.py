# -*- coding: utf-8 -*-
"""
SIP trunk watchdog — ensure the expected LiveKit SIP trunks exist, then sync
the phone_numbers table to the live trunk IDs.

Why this exists
---------------
Outbound calling depends on a 1:1 mapping between each DID (phone number) and a
LiveKit outbound SIP trunk. If a trunk goes missing (LiveKit/Redis wipe, a
restart before persistence existed, a stray manual delete, etc.) the dispatcher
silently fails to dial. This script makes the trunk set SELF-HEALING:

  1. List the trunks LiveKit currently has.
  2. For every trunk in the config that is MISSING, (re)create its outbound +
     inbound trunk and a dispatch rule.  ADDITIVE ONLY — it never deletes or
     modifies trunks it doesn't own, so it is safe to run alongside any other
     project that shares this LiveKit.
  3. Re-sync phone_numbers.livekit_trunk_id to the live outbound trunk IDs
     (creating the pool/rows if absent).

Idempotent: when everything already matches, it makes zero changes and exits 0.
Designed to be run every few minutes by a systemd timer (los-trunk-watchdog).

Config
------
Trunk definitions + secrets are read from a JSON file (NOT committed to git):
  default path: <this dir>/trunks.config.json   (override with TRUNKS_CONFIG)
See trunks.config.example.json for the shape.

LiveKit + DB creds come from the usual env (backend/.env(.local), agent/.env.local),
falling back to the self-hosted GPU defaults.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv
from livekit import api
from livekit.protocol import sip

_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE.parent / "backend" / ".env")
load_dotenv(_HERE.parent / "backend" / ".env.local", override=True)
load_dotenv(_HERE / ".env.local", override=False)

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://164.52.217.236:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "APIz4wNJoLzxewZ")
LIVEKIT_API_SECRET = os.getenv(
    "LIVEKIT_API_SECRET", "UdHxWuX61VYSolv2yNGCeanCo1ac5LvdwaovqlIL8gR"
)
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://los_admin:los_dev_pass@localhost:5435/los_form"
)
CONFIG_PATH = Path(os.getenv("TRUNKS_CONFIG", _HERE / "trunks.config.json"))
DEFAULT_TRANSPORT = sip.SIPTransport.SIP_TRANSPORT_UDP


def _log(msg: str) -> None:
    print(msg, flush=True)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        _log(f"FATAL: trunk config not found at {CONFIG_PATH}")
        sys.exit(2)
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if not cfg.get("trunks"):
        _log("FATAL: config has no 'trunks'")
        sys.exit(2)
    return cfg


# ── SDK-version-tolerant list helpers ───────────────────────────
async def _list_outbound(lk):
    for n in ("list_outbound_trunk", "list_sip_outbound_trunk"):
        if hasattr(lk.sip, n):
            return await getattr(lk.sip, n)(api.ListSIPOutboundTrunkRequest())
    raise RuntimeError("no list outbound trunk method")


async def _list_inbound(lk):
    for n in ("list_inbound_trunk", "list_sip_inbound_trunk"):
        if hasattr(lk.sip, n):
            return await getattr(lk.sip, n)(api.ListSIPInboundTrunkRequest())
    raise RuntimeError("no list inbound trunk method")


async def _list_dispatch(lk):
    for n in ("list_dispatch_rule", "list_sip_dispatch_rule"):
        if hasattr(lk.sip, n):
            return await getattr(lk.sip, n)(api.ListSIPDispatchRuleRequest())
    raise RuntimeError("no list dispatch rule method")


def _numbers_of(trunk) -> list[str]:
    return list(getattr(trunk, "numbers", None) or getattr(trunk, "phone_numbers", None) or [])


async def ensure_trunks(lk, trunks: list[dict]) -> tuple[int, list[str]]:
    """Create any missing outbound/inbound/dispatch. Returns (created_count, problems)."""
    out_resp = await _list_outbound(lk)
    in_resp = await _list_inbound(lk)
    rules_resp = await _list_dispatch(lk)
    existing_out = list(getattr(out_resp, "items", []) or [])
    existing_in = list(getattr(in_resp, "items", []) or [])
    existing_rules = list(getattr(rules_resp, "items", []) or [])

    created = 0
    problems: list[str] = []

    for t in trunks:
        num = t["number"]
        # --- outbound ---
        if any(num in _numbers_of(x) for x in existing_out):
            continue  # already present → nothing to do for this trunk
        try:
            _log(f"  MISSING outbound for {num} ({t.get('provider','?')}) — creating…")
            oresp = await lk.sip.create_sip_outbound_trunk(
                api.CreateSIPOutboundTrunkRequest(
                    trunk=sip.SIPOutboundTrunkInfo(
                        name=f"{t.get('provider','sip')} Outbound {num}",
                        address=t["address"],
                        transport=DEFAULT_TRANSPORT,
                        numbers=[num],
                        auth_username=t["auth_username"],
                        auth_password=t["auth_password"],
                    )
                )
            )
            created += 1
            _log(f"    outbound created: {oresp.sip_trunk_id}")
        except Exception as ex:  # noqa: BLE001
            problems.append(f"outbound {num}: {ex}")
            continue

        # --- inbound (best-effort; outbound is what dialing needs) ---
        try:
            if not any(num in _numbers_of(x) for x in existing_in):
                iresp = await lk.sip.create_sip_inbound_trunk(
                    api.CreateSIPInboundTrunkRequest(
                        trunk=sip.SIPInboundTrunkInfo(
                            name=f"{t.get('provider','sip')} Inbound {num}",
                            numbers=[num],
                            auth_username=t["auth_username"],
                            auth_password=t["auth_password"],
                            krisp_enabled=False,
                        )
                    )
                )
                inbound_id = iresp.sip_trunk_id
                _log(f"    inbound created: {inbound_id}")
                await lk.sip.create_sip_dispatch_rule(
                    api.CreateSIPDispatchRuleRequest(
                        rule=sip.SIPDispatchRule(
                            dispatch_rule_direct=sip.SIPDispatchRuleDirect(room_name="call-", pin="")
                        ),
                        trunk_ids=[inbound_id],
                        hide_phone_number=False,
                        name=f"{t.get('provider','sip')} Auto Dispatch {num}",
                    )
                )
                _log("    dispatch rule created")
        except Exception as ex:  # noqa: BLE001
            problems.append(f"inbound/dispatch {num}: {ex}")

    return created, problems


async def sync_db(lk, pool_name: str) -> tuple[int, list[str]]:
    """Point phone_numbers.livekit_trunk_id at the live outbound trunk IDs."""
    out_resp = await _list_outbound(lk)
    live = {}
    for t in getattr(out_resp, "items", []) or []:
        for n in _numbers_of(t):
            live[n] = t.sip_trunk_id

    changed = 0
    notes: list[str] = []
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        pool = await conn.fetchrow("SELECT id FROM phone_pools WHERE name=$1", pool_name)
        if pool is None:
            pool = await conn.fetchrow(
                """INSERT INTO phone_pools (id,bank_id,name,capacity,
                       cooldown_seconds_min,cooldown_seconds_max,created_at)
                   VALUES (gen_random_uuid(),NULL,$1,5,180,300,NOW())
                   RETURNING id""",
                pool_name,
            )
            notes.append(f"created pool {pool_name}")
        pool_id = pool["id"]
        for num, tid in live.items():
            row = await conn.fetchrow(
                "SELECT id,livekit_trunk_id,status FROM phone_numbers WHERE phone_number=$1", num
            )
            if row is None:
                await conn.execute(
                    """INSERT INTO phone_numbers
                         (pool_id,phone_number,livekit_trunk_id,status,active_calls,total_calls,created_at,updated_at)
                       VALUES ($1,$2,$3,'active',0,0,NOW(),NOW())""",
                    pool_id, num, tid,
                )
                changed += 1
                notes.append(f"inserted {num} -> {tid}")
            elif row["livekit_trunk_id"] != tid or row["status"] != "active":
                await conn.execute(
                    """UPDATE phone_numbers
                          SET livekit_trunk_id=$1,status='active',pool_id=$2,updated_at=NOW()
                        WHERE id=$3""",
                    tid, pool_id, row["id"],
                )
                changed += 1
                notes.append(f"updated {num} -> {tid}")
    finally:
        await conn.close()
    return changed, notes


async def main() -> int:
    cfg = load_config()
    trunks = cfg["trunks"]
    pool_name = cfg.get("pool", "pusad-default")

    lk = api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
    try:
        created, problems = await ensure_trunks(lk, trunks)
        changed, notes = await sync_db(lk, pool_name)
    finally:
        await lk.aclose()

    if created == 0 and changed == 0 and not problems:
        _log(f"OK: all {len(trunks)} trunks present and DB in sync (no changes).")
    else:
        _log(f"HEALED: trunks_created={created}, db_changes={changed}")
        for n in notes:
            _log(f"  db: {n}")
    if problems:
        for p in problems:
            _log(f"  PROBLEM: {p}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
