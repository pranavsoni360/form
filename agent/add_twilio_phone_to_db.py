# -*- coding: utf-8 -*-
"""
Add the Twilio US phone number to the phone_numbers table so the dispatcher
and /ops/batch "From number" dropdown pick it up automatically. The frontend
labels any +1 number as "Twilio US" (see ops/batch/page.tsx), so no frontend
change is needed — this row is the only missing piece.

Idempotent: if the number already exists it updates its livekit_trunk_id and
reactivates it; if the target pool is missing it is created (mirrors
ensure_trunks.py). Run once per environment after create_twilio_trunk.py.

Point it at the RIGHT database via DATABASE_URL — run it wherever the backend
that serves your frontend actually reads from (local docker DB, or the
deployed server's DB).

Usage:
    cd agent
    # local docker DB (default from backend/.env):
    python add_twilio_phone_to_db.py
    # a different / deployed DB:
    DATABASE_URL=postgresql://user:pass@host:5432/los_form python add_twilio_phone_to_db.py
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

# From create_twilio_trunk.py output (2026-07-13 provisioning):
TWILIO_PHONE_NUMBER = "+15076046329"
TWILIO_OUTBOUND_TRUNK_ID = "ST_2h7bcKSkRDHm"

# 'pusad-default' is the seed pool the dispatcher uses by default.
TARGET_POOL_NAME = "pusad-default"


async def main():
    print("=" * 70)
    print(f"Adding Twilio phone {TWILIO_PHONE_NUMBER} to phone_numbers")
    print("=" * 70)
    print(f"DB   : {DATABASE_URL.split('@')[-1]}")
    print(f"Trunk: {TWILIO_OUTBOUND_TRUNK_ID}")
    print(f"Pool : {TARGET_POOL_NAME}")
    print()

    conn = await asyncpg.connect(DATABASE_URL)
    try:
        # 1) Find-or-create the target pool (schema mirrors ensure_trunks.py)
        pool_row = await conn.fetchrow(
            "SELECT id, name, capacity FROM phone_pools WHERE name = $1 LIMIT 1",
            TARGET_POOL_NAME,
        )
        if pool_row is None:
            pool_row = await conn.fetchrow(
                """INSERT INTO phone_pools (id, bank_id, name, capacity,
                       cooldown_seconds_min, cooldown_seconds_max, created_at)
                   VALUES (gen_random_uuid(), NULL, $1, 5, 180, 300, NOW())
                   RETURNING id, name, capacity""",
                TARGET_POOL_NAME,
            )
            print(f"Created pool: {pool_row['name']}")
        pool_id = pool_row["id"]
        print(f"Using pool: {pool_row['name']} (capacity={pool_row['capacity']})")

        # 2) Upsert the number
        existing = await conn.fetchrow(
            "SELECT id, livekit_trunk_id, status, pool_id "
            "FROM phone_numbers WHERE phone_number = $1",
            TWILIO_PHONE_NUMBER,
        )
        if existing is None:
            new_id = await conn.fetchval(
                """INSERT INTO phone_numbers
                       (pool_id, phone_number, livekit_trunk_id, status,
                        active_calls, total_calls, created_at, updated_at)
                   VALUES ($1, $2, $3, 'active', 0, 0, NOW(), NOW())
                   RETURNING id""",
                pool_id, TWILIO_PHONE_NUMBER, TWILIO_OUTBOUND_TRUNK_ID,
            )
            print(f"Inserted phone_number row: id={new_id}")
        elif (existing["livekit_trunk_id"] == TWILIO_OUTBOUND_TRUNK_ID
                and existing["status"] == "active"
                and existing["pool_id"] == pool_id):
            print(f"Already correctly configured (id={existing['id']}) — nothing to do.")
        else:
            await conn.execute(
                """UPDATE phone_numbers
                      SET livekit_trunk_id = $1, status = 'active',
                          pool_id = $2, updated_at = NOW()
                    WHERE id = $3""",
                TWILIO_OUTBOUND_TRUNK_ID, pool_id, existing["id"],
            )
            print(f"Updated trunk_id -> {TWILIO_OUTBOUND_TRUNK_ID}, status -> active")

        # 3) Verification snapshot
        print("\nphone_numbers in this pool:")
        rows = await conn.fetch(
            """SELECT pn.phone_number, pn.livekit_trunk_id, pn.status,
                      pn.active_calls, pn.total_calls
                 FROM phone_numbers pn
                 JOIN phone_pools pp ON pp.id = pn.pool_id
                WHERE pp.name = $1
                ORDER BY pn.phone_number""",
            TARGET_POOL_NAME,
        )
        for r in rows:
            marker = "  >>" if r["phone_number"] == TWILIO_PHONE_NUMBER else "    "
            provider = ("Twilio US" if r["phone_number"].startswith("+1")
                        else "Viva India" if r["phone_number"].startswith("+91") else "?")
            print(f"{marker} {r['phone_number']:16s} [{provider:10s}] "
                  f"trunk={r['livekit_trunk_id']:18s} status={r['status']}")

        print("\nDone. The Twilio number now appears in the /ops/batch 'From number'")
        print("dropdown as 'Twilio US' and, when selected, the dispatcher routes the")
        print("call strictly through its trunk (no fallback to other numbers).")

    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
