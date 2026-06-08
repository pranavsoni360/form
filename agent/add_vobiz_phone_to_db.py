# -*- coding: utf-8 -*-
"""
Add the Vobiz phone number to the phone_numbers table so the dispatcher
and /ops/phones UI pick it up automatically.

Idempotent: if a row with this phone_number already exists, the script
updates its livekit_trunk_id (in case the trunk ID changed) and reactivates
the row instead of creating a duplicate.

Run once after running create_vobiz_trunk.py.

Usage:
    cd agent
    python add_vobiz_phone_to_db.py
"""
import asyncio
import os
import sys

import asyncpg
from dotenv import load_dotenv

# Load backend .env so DATABASE_URL resolves the same way the API does.
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "backend", ".env"))
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "backend", ".env.local"), override=True)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://los_admin:los_dev_pass@localhost:5435/los_form")

# From create_vobiz_trunk.py output:
VOBIZ_PHONE_NUMBER = "+918071583503"
VOBIZ_OUTBOUND_TRUNK_ID = "ST_pTYcg7Az9q8R"

# Pool selection. 'pusad-default' is the seed pool from the M2 migration.
# Change this to any existing pool name if you want the Vobiz number in a
# different pool. The script will fail loudly if the pool doesn't exist.
TARGET_POOL_NAME = "pusad-default"


async def main():
    print("=" * 70)
    print(f"Adding Vobiz phone {VOBIZ_PHONE_NUMBER} to phone_numbers")
    print("=" * 70)
    print(f"DB: {DATABASE_URL.split('@')[-1]}")
    print(f"Trunk: {VOBIZ_OUTBOUND_TRUNK_ID}")
    print(f"Pool : {TARGET_POOL_NAME}")
    print()

    conn = await asyncpg.connect(DATABASE_URL)
    try:
        # 1) Find the target pool — fail fast if it doesn't exist
        pool_row = await conn.fetchrow(
            "SELECT id, name, capacity FROM phone_pools WHERE name = $1 LIMIT 1",
            TARGET_POOL_NAME,
        )
        if pool_row is None:
            print(f"ERROR: pool '{TARGET_POOL_NAME}' not found.")
            print("\nAvailable pools:")
            for r in await conn.fetch("SELECT name FROM phone_pools ORDER BY name"):
                print(f"  - {r['name']}")
            sys.exit(1)

        pool_id = pool_row["id"]
        print(f"Using pool: {pool_row['name']} (capacity={pool_row['capacity']})")

        # 2) Check whether the number is already present
        existing = await conn.fetchrow(
            "SELECT id, livekit_trunk_id, status, pool_id "
            "FROM phone_numbers WHERE phone_number = $1",
            VOBIZ_PHONE_NUMBER,
        )

        if existing:
            # Idempotent path: update trunk ID + reactivate if needed
            print(f"Phone already exists (id={existing['id']}, status={existing['status']})")
            if (existing["livekit_trunk_id"] == VOBIZ_OUTBOUND_TRUNK_ID
                    and existing["status"] == "active"
                    and existing["pool_id"] == pool_id):
                print("  Already correctly configured — nothing to do.")
            else:
                await conn.execute(
                    """UPDATE phone_numbers
                          SET livekit_trunk_id = $1,
                              status = 'active',
                              pool_id = $2,
                              updated_at = NOW()
                        WHERE id = $3""",
                    VOBIZ_OUTBOUND_TRUNK_ID, pool_id, existing["id"],
                )
                print(f"  Updated trunk_id -> {VOBIZ_OUTBOUND_TRUNK_ID}, status -> active")
        else:
            # Fresh insert
            new_id = await conn.fetchval(
                """INSERT INTO phone_numbers
                       (pool_id, phone_number, livekit_trunk_id, status,
                        active_calls, total_calls, created_at, updated_at)
                   VALUES ($1, $2, $3, 'active', 0, 0, NOW(), NOW())
                   RETURNING id""",
                pool_id, VOBIZ_PHONE_NUMBER, VOBIZ_OUTBOUND_TRUNK_ID,
            )
            print(f"Inserted phone_number row: id={new_id}")

        # 3) Print verification snapshot
        print("\nCurrent state of phone_numbers in this pool:")
        rows = await conn.fetch(
            """SELECT pn.phone_number, pn.livekit_trunk_id, pn.status,
                      pn.active_calls, pn.total_calls, pn.cooldown_until
                 FROM phone_numbers pn
                 JOIN phone_pools pp ON pp.id = pn.pool_id
                WHERE pp.name = $1
                ORDER BY pn.phone_number""",
            TARGET_POOL_NAME,
        )
        for r in rows:
            marker = "  >>" if r["phone_number"] == VOBIZ_PHONE_NUMBER else "    "
            print(
                f"{marker} {r['phone_number']:18s} trunk={r['livekit_trunk_id']:18s} "
                f"status={r['status']:12s} active={r['active_calls']} total={r['total_calls']}"
            )

        print()
        print("=" * 70)
        print("Done. The Vobiz number is now visible in /ops/phones and selectable")
        print("by the dispatcher (it will be used automatically by least-loaded")
        print("selection, or explicitly via the operator-selected phone_id).")
        print("=" * 70)

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
