# -*- coding: utf-8 -*-
"""
Sync the phone_numbers table with the freshly recreated LiveKit trunk IDs.

When LiveKit trunks are deleted and re-created, every phone_number row in
the LOS DB still points at the OLD (now-dead) trunk ID. The dispatcher
will fail silently when it tries to dial. This script remaps each phone
to its NEW outbound trunk ID, and inserts +912269738961 (the newly
added Viva DID) if it's not already there.

Run once after running:
  - create_viva_trunks_all.py
  - create_vobiz_trunk.py
  - create_twilio_livekit_trunks.py
"""
import asyncio
import os
import sys

import asyncpg
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "backend", ".env"))
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "backend", ".env.local"), override=True)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://los_admin:los_dev_pass@localhost:5435/los_form")
TARGET_POOL = "pusad-default"

# Authoritative mapping (phone_number -> new outbound trunk ID).
# Copied from the create_*.py script outputs we just ran.
PHONE_TO_TRUNK = {
    "+912269738946": "ST_JJudtS5FJ6jm",  # Viva
    "+912269738961": "ST_XUZQE44cwRtc",  # Viva (newly added DID)
    "+912269738962": "ST_seqzwX79939u",  # Viva
    "+912269738963": "ST_4rf9GLwsKPo8",  # Viva
    "+918071583503": "ST_k8eAtzFbx5Ru",  # Vobiz (corrected creds: f06215d3.sip.vobiz.ai / adilS)
    "+17744930587":  "ST_qK5QsAeqDiQ6",  # Twilio
}


async def main():
    print("=" * 70)
    print("Syncing phone_numbers.livekit_trunk_id with newly created trunks")
    print("=" * 70)

    conn = await asyncpg.connect(DATABASE_URL)
    try:
        pool = await conn.fetchrow(
            "SELECT id, name, capacity FROM phone_pools WHERE name = $1",
            TARGET_POOL,
        )
        if pool is None:
            print(f"ERROR: pool '{TARGET_POOL}' not found")
            sys.exit(1)
        pool_id = pool["id"]
        print(f"Pool: {pool['name']} (capacity={pool['capacity']})\n")

        for phone, new_trunk in PHONE_TO_TRUNK.items():
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

        print("\nFinal state of phone_numbers in '{}':".format(TARGET_POOL))
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
