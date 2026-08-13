"""Schema-invariant tests for the multi-bank migrations (v32–v38).

These pin the database-level guards so a future migration or manual change can't
silently remove them:

  * chk_maker_ne_checker            (v38) — a loan's officer != supervisor
  * credit_ledger single-row        (v33) — multi-row inserts corrupt the balance
  * one active scorecard per bank   (v32) — NULLS NOT DISTINCT partial unique
  * notification_optouts unique     (v35) — one standing opt-out per bank/phone/channel
  * notification_templates active   (v35) — one ACTIVE template per bank/channel/key/lang

They need a Postgres DB that already has the schema applied. Set

    TEST_DATABASE_DSN=postgresql://user:pass@host:port/dbname

to a THROWAWAY/QA copy to run them; without it the whole module skips. Each test
runs inside a transaction that is rolled back, so nothing persists — and each
expected-failure insert is wrapped in a SAVEPOINT (nested transaction) so the
outer transaction stays usable. Never point this at production.
"""
import os
import uuid

import pytest
import pytest_asyncio

asyncpg = pytest.importorskip("asyncpg")

DSN = os.getenv("TEST_DATABASE_DSN")
pytestmark = [
    pytest.mark.skipif(not DSN, reason="TEST_DATABASE_DSN not set"),
    pytest.mark.asyncio,
]


@pytest_asyncio.fixture
async def conn():
    c = await asyncpg.connect(DSN)
    tx = c.transaction()
    await tx.start()
    try:
        yield c
    finally:
        await tx.rollback()   # nothing persists
        await c.close()


async def _a_bank(conn):
    """Insert a throwaway bank (uppercase code per chk_banks_code_format) and
    return its id. Rolled back with the enclosing test transaction."""
    return await conn.fetchval(
        "INSERT INTO banks (name, code) VALUES ($1, $2) RETURNING id",
        "TEST BANK", f"TB{uuid.uuid4().hex[:8].upper()}",
    )


async def test_maker_ne_checker_rejects_equal(conn):
    app_id = await conn.fetchval("SELECT id FROM loan_applications LIMIT 1")
    if app_id is None:
        pytest.skip("no loan_applications rows to exercise the constraint")
    same = uuid.uuid4()
    with pytest.raises(asyncpg.CheckViolationError):
        async with conn.transaction():
            await conn.execute(
                "UPDATE loan_applications SET officer_id=$1, supervisor_id=$1 WHERE id=$2",
                same, app_id,
            )


async def test_credit_ledger_rejects_multi_row(conn):
    bank_id = await _a_bank(conn)
    # a single-row insert is fine (BEFORE trigger fills balance_after)
    await conn.execute(
        "INSERT INTO credit_ledger (bank_id, entry_type, amount, note) "
        "VALUES ($1,'topup',100,'seed')", bank_id,
    )
    # a two-row insert must be rejected by trg_credit_ledger_single_row
    with pytest.raises(asyncpg.PostgresError):
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO credit_ledger (bank_id, entry_type, amount, note) "
                "VALUES ($1,'topup',10,'a'), ($1,'topup',20,'b')", bank_id,
            )


async def test_one_active_scorecard_per_bank(conn):
    bank_id = await _a_bank(conn)
    product_id = await conn.fetchval(
        "INSERT INTO loan_products (bank_id, product_code, name) VALUES ($1,$2,$3) RETURNING id",
        bank_id, "TESTPROD", "Test Product",
    )
    await conn.execute(
        "INSERT INTO scorecard_versions "
        "(bank_id, product_id, version_number, config, status, is_active) "
        "VALUES ($1,$2,1,'{}'::jsonb,'live',true)", bank_id, product_id,
    )
    # second active version (different version_number to dodge uq_scorecard_version_num)
    # must trip uq_scorecard_one_active
    with pytest.raises(asyncpg.UniqueViolationError):
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO scorecard_versions "
                "(bank_id, product_id, version_number, config, status, is_active) "
                "VALUES ($1,$2,2,'{}'::jsonb,'live',true)", bank_id, product_id,
            )


async def test_notification_optout_unique(conn):
    await conn.execute(
        "INSERT INTO notification_optouts (bank_id, phone, channel) VALUES (NULL,$1,'whatsapp')",
        "9990001111",
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO notification_optouts (bank_id, phone, channel) VALUES (NULL,$1,'whatsapp')",
                "9990001111",
            )


async def test_notification_template_active_unique(conn):
    await conn.execute(
        "INSERT INTO notification_templates (bank_id, channel, key, body) "
        "VALUES (NULL,'whatsapp','form_link','a')",
    )
    # a second ACTIVE default for the same key must be rejected...
    with pytest.raises(asyncpg.UniqueViolationError):
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO notification_templates (bank_id, channel, key, body) "
                "VALUES (NULL,'whatsapp','form_link','b')",
            )
    # ...but a draft duplicate is allowed (partial index only guards active)
    await conn.execute(
        "INSERT INTO notification_templates (bank_id, channel, key, body, status) "
        "VALUES (NULL,'whatsapp','form_link','draft','draft')",
    )
