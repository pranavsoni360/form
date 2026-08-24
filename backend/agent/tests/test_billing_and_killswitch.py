"""Money and safety invariants in the call-completion path.

Billing wrote `usage_records` and `credit_ledger` as two separate autocommit
statements. `fn_credit_ledger_before()` takes `SELECT ... FROM banks ... FOR
UPDATE`, so the second insert genuinely can fail on lock wait or a statement
timeout under concurrent billing for the same bank. When it did:
`usage_records` was already committed, the outer handler logged a warning, and
the bank was never debited — and because the idempotency guard reads
`usage_records`, every webhook retry returned early. The debit was lost
permanently and silently, with the wallet balance overstated.

`is_emergency_stop_active()` swallowed its DB error and returned the stale
module global, defeating the staleness the function exists to prevent: an
operator activates the stop, a DB blip coincides with the next runner tick in a
process where the flag is still False, and the dialler keeps calling during a
declared stop. A kill switch must fail closed.
"""
from __future__ import annotations

import asyncio
import uuid
from decimal import Decimal

import pytest
from asyncpg.exceptions import UniqueViolationError

from agent import state as state_mod
from agent import transcript as tx

BANK = str(uuid.uuid4())
CALL = str(uuid.uuid4())


class _Conn:
    def __init__(self, fail_on_nth=None, exc=RuntimeError("lock timeout")):
        self.executed: list[str] = []
        self.fail_on_nth, self.exc = fail_on_nth, exc
        self.tx_entered = self.tx_committed = self.tx_rolled_back = False

    async def execute(self, sql, *args):
        self.executed.append(sql)
        if self.fail_on_nth is not None and len(self.executed) == self.fail_on_nth:
            raise self.exc
        return "INSERT 0 1"

    def transaction(self):
        conn = self

        class _Tx:
            async def __aenter__(self):
                conn.tx_entered = True
                return self

            async def __aexit__(self, et, ev, tb):
                if et is None:
                    conn.tx_committed = True
                else:
                    conn.tx_rolled_back = True
                return False  # never swallow

        return _Tx()


class _Pool:
    """Fake asyncpg pool: `async with pool.acquire() as conn`."""

    def __init__(self, conn, rate=Decimal("2.50"), already_billed=None):
        self.conn, self.rate, self.already_billed = conn, rate, already_billed
        self.fetchvals: list[str] = []

    async def fetchval(self, sql, *args):
        self.fetchvals.append(sql)
        if "usage_records" in sql:
            return self.already_billed
        if "rate_per_minute" in sql:
            return self.rate
        return None

    def acquire(self):
        conn = self.conn

        class _Acq:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *a):
                return False

        return _Acq()


def _call():
    return {"id": CALL, "bank_id": BANK}


@pytest.fixture
def conn():
    return _Conn()


def _bill(pool, seconds=90):
    return asyncio.run(tx._bill_completed_call(_call(), seconds))


# -- both writes, one transaction -------------------------------------------

def test_both_writes_land_in_one_transaction(monkeypatch, conn):
    pool = _Pool(conn)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    _bill(pool)
    assert conn.tx_entered and conn.tx_committed
    assert len(conn.executed) == 2
    assert "usage_records" in conn.executed[0]
    assert "credit_ledger" in conn.executed[1]


def test_ledger_failure_rolls_back_the_usage_row(monkeypatch):
    """The whole point: no usage_records row without its matching debit, so a
    webhook retry is still able to bill."""
    conn = _Conn(fail_on_nth=2)
    pool = _Pool(conn)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    _bill(pool)  # best-effort: must not raise out of the webhook
    assert conn.tx_rolled_back is True
    assert conn.tx_committed is False


def test_a_concurrent_duplicate_is_absorbed_not_logged_as_failure(monkeypatch):
    """uq_usage_records_call holds when two webhooks race for the same call."""
    conn = _Conn(fail_on_nth=1, exc=UniqueViolationError("dup"))
    pool = _Pool(conn)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    _bill(pool)
    assert conn.tx_rolled_back is True


# -- the guards around it ---------------------------------------------------

def test_already_billed_call_is_skipped_before_any_write(monkeypatch, conn):
    pool = _Pool(conn, already_billed=1)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    _bill(pool)
    assert conn.executed == []


def test_bank_with_no_rate_card_is_not_billed(monkeypatch, conn):
    pool = _Pool(conn, rate=None)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    _bill(pool)
    assert conn.executed == []


@pytest.mark.parametrize("call,seconds", [
    ({"id": CALL, "bank_id": None}, 90),
    ({"id": None, "bank_id": BANK}, 90),
    ({"id": CALL, "bank_id": BANK}, 0),
])
def test_nothing_to_bill_short_circuits(monkeypatch, conn, call, seconds):
    pool = _Pool(conn)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    asyncio.run(tx._bill_completed_call(call, seconds))
    assert conn.executed == []


def test_minutes_are_rounded_up_with_a_one_minute_floor(monkeypatch, conn):
    """Per-minute billing: 90s = 2 min, 1s = 1 min."""
    pool = _Pool(conn)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    asyncio.run(tx._bill_completed_call(_call(), 1))
    assert conn.tx_committed


# -- kill switch fails closed ----------------------------------------------

class _BoomPool:
    async def fetchrow(self, *a, **k):
        raise RuntimeError("db unreachable")


class _ValuePool:
    def __init__(self, value):
        self.value = value

    async def fetchrow(self, *a, **k):
        return {"value": self.value}


def test_emergency_stop_assumes_active_when_the_db_read_fails(monkeypatch):
    monkeypatch.setattr(state_mod, "db_pool", _BoomPool())
    monkeypatch.setattr(state_mod, "_emergency_stop", False)  # stale "not stopped"
    assert asyncio.run(state_mod.is_emergency_stop_active()) is True


def test_emergency_stop_reads_true_from_the_db(monkeypatch):
    monkeypatch.setattr(state_mod, "db_pool", _ValuePool("true"))
    monkeypatch.setattr(state_mod, "_emergency_stop", False)
    assert asyncio.run(state_mod.is_emergency_stop_active()) is True


def test_emergency_stop_reads_false_from_the_db(monkeypatch):
    monkeypatch.setattr(state_mod, "db_pool", _ValuePool("false"))
    monkeypatch.setattr(state_mod, "_emergency_stop", True)  # stale "stopped"
    assert asyncio.run(state_mod.is_emergency_stop_active()) is False
