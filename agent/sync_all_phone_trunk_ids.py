# -*- coding: utf-8 -*-
"""
Sync the phone_numbers table with the LIVE LiveKit outbound trunk IDs.

When LiveKit trunks are deleted and re-created (e.g. after a Redis wipe /
server restart), every phone_number row in the LOS DB still points at the
OLD (now-dead) trunk ID, and the dispatcher fails silently when it dials.

This script is DYNAMIC: it queries LiveKit for the current outbound trunks,
builds a {phone_number -> trunk_id} map from whatever actually exists, and
remaps each matching phone_numbers row. No hardcoded trunk IDs — so after a
future wipe you only need to re-run the create_*.py scripts, then this.

Run once after running:
  - create_viva_trunks_all.py
  - create_vobiz_trunk.py
  - create_twilio_livekit_trunks.py

Set TARGET_DB=local|gpu via env, or pass DATABASE_URL directly.
"""
import asyncio
import os
import sys

import asyncpg
from dotenv import load_dotenv
from livekit import api

_HERE = os.path.dirname(__file__)
# Load DB + LiveKit creds. backend/.env(.local) for DATABASE_URL,
# agent/.env.local for LiveKit creds. Later loads override earlier.
load_dotenv(os.path.join(_HERE, "..", "backend", ".env"))
load_dotenv(os.path.join(_HERE, "..", "backend", ".env.local"), override=True)
load_dotenv(os.path.join(_HERE, ".env.local"), override=False)

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://los_admin:los_dev_pass@localhost:5435/los_form"
)
TARGET_POOL = os.getenv("TARGET_POOL", "pusad-default")

# LiveKit (the self-hosted GPU server is the same for local + GPU runs).
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://164.52.217.236:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "APIz4wNJoLzxewZ")
LIVEKIT_API_SECRET = os.getenv(
    "LIVEKIT_API_SECRET", "UdHxWuX61VYSolv2yNGCeanCo1ac5LvdwaovqlIL8gR"
)


async def list_outbound_trunks(lk):
    for name in ("list_outbound_trunk", "list_sip_outbound_trunk"):
        if hasattr(lk.sip, name):
            return await getattr(lk.sip, name)(api.ListSIPOutboundTrunkRequest())
    raise RuntimeError("No list outbound trunk method on lk.sip")


async def build_phone_to_trunk() -> dict[str, str]:
    """Query LiveKit; return {phone_number -> outbound trunk_id}."""
    lk = api.LiveKitAPI(
        url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET
    )
    try:
        resp = await list_outbound_trunks(lk)
        items = resp.items if getattr(resp, "items", None) else []
        mapping: dict[str, str] = {}
        for t in items:
            nums = getattr(t, "numbers", None) or getattr(t, "phone_numbers", None) or []
            for n in nums:
                # If a number somehow has two outbound trunks, last one wins;
                # creation scripts are idempotent so this shouldn't happen.
                mapping[n] = t.sip_trunk_id
        return mapping
    finally:
        await lk.aclose()


async def main():
    print("=" * 70)
    print("Syncing phone_numbers.livekit_trunk_id from LIVE LiveKit trunks")
    print("=" * 70)
    print(f"LiveKit: {LIVEKIT_URL}")
    print(f"DB:      {DATABASE_URL.split('@')[-1]}")

    phone_to_trunk = await build_phone_to_trunk()
    if not phone_to_trunk:
        print("\nERROR: LiveKit reports ZERO outbound trunks. Run the create_*.py")
        print("scripts first, then re-run this sync.")
        sys.exit(1)

    print(f"\nFound {len(phone_to_trunk)} outbound trunk(s) on LiveKit:")
    for phone, trunk in sorted(phone_to_trunk.items()):
        print(f"  {phone:18s} -> {trunk}")

    conn = await asyncpg.connect(DATABASE_URL)
    try:
        pool = await conn.fetchrow(
            "SELECT id, name, capacity FROM phone_pools WHERE name = $1", TARGET_POOL
        )
        if pool is None:
            # Fresh DB (e.g. GPU never seeded): create the pool with the same
            # defaults the local dev pool uses (capacity 5, 180-300s cooldown).
            pool = await conn.fetchrow(
                """INSERT INTO phone_pools
                       (id, bank_id, name, capacity,
                        cooldown_seconds_min, cooldown_seconds_max, created_at)
                   VALUES (gen_random_uuid(), NULL, $1, 5, 180, 300, NOW())
                   RETURNING id, name, capacity""",
                TARGET_POOL,
            )
            print(f"\nPool '{TARGET_POOL}' not found -> CREATED it.")
        pool_id = pool["id"]
        print(f"\nPool: {pool['name']} (capacity={pool['capacity']})\n")

        for phone, new_trunk in phone_to_trunk.items():
            existing = await conn.fetchrow(
                "SELECT id, livekit_trunk_id, status FROM phone_numbers WHERE phone_number = $1",
                phone,
            )
            if existing:
                if existing["livekit_trunk_id"] == new_trunk and existing["status"] == "active":
                    print(f"  {phone:18s} already correct -> {new_trunk}")
                else:
                    await conn.execute(
                        """UPDATE phone_numbers
                              SET livekit_trunk_id = $1,
                                  status = 'active',
                                  pool_id = $2,
                                  updated_at = NOW()
                            WHERE id = $3""",
                        new_trunk, pool_id, existing["id"],
                    )
                    print(f"  {phone:18s} UPDATED  (was {existing['livekit_trunk_id']}) -> {new_trunk}")
            else:
                await conn.execute(
                    """INSERT INTO phone_numbers
                           (pool_id, phone_number, livekit_trunk_id, status,
                            active_calls, total_calls, created_at, updated_at)
                       VALUES ($1, $2, $3, 'active', 0, 0, NOW(), NOW())""",
                    pool_id, phone, new_trunk,
                )
                print(f"  {phone:18s} INSERTED -> {new_trunk}")

        print(f"\nFinal state of phone_numbers in '{TARGET_POOL}':")
        rows = await conn.fetch(
            """SELECT pn.phone_number, pn.livekit_trunk_id, pn.status,
                      pn.active_calls, pn.total_calls
                 FROM phone_numbers pn
                 JOIN phone_pools pp ON pp.id = pn.pool_id
                WHERE pp.name = $1
                ORDER BY pn.phone_number""",
            TARGET_POOL,
        )
        for r in rows:
            print(
                f"  {r['phone_number']:18s} trunk={r['livekit_trunk_id']:20s} "
                f"status={r['status']:10s} active={r['active_calls']} total={r['total_calls']}"
            )

        print("\nDone. /ops/phones page will reflect this immediately on refresh.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
