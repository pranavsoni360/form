"""Tenant-isolation tests for the batch (dialler) control plane and /api/ops/*.

`get_current_bank_user` resolves the caller's bank_id and these handlers used to
ignore it. Concretely, a plain `bank_officer` at Bank A could:

  * POST /api/agent/batch-call   with Bank B's batch id — or with NO id at all,
    which took whatever batch was newest platform-wide — and place real PSTN
    calls to Bank B's customers, billed to Bank B.
  * POST /api/agent/batch-retry  likewise, re-dialling another bank's failed
    calls (unsolicited-call exposure on top of the billing).
  * POST /api/agent/stop-batch   to kill another bank's live rooms.
  * GET  /api/agent/batch-status with no batch_id, for platform-wide counters.
  * Pass Bank B's `phone_number_id` and dial its whole campaign FROM Bank B's
    number, burning that number's reputation and attributing the traffic to
    them at the carrier. Existence was the only check performed.
  * GET  /api/ops/phone-pools    which had no WHERE clause whatsoever.
  * GET  /api/ops/in-flight-calls to watch other banks' customer names and
    phone numbers live.
  * GET  /api/ops/errors         for the platform-wide exception stream.

A platform operator (admin token, bank_id None) stays deliberately cross-bank
throughout — that is what the /ops console needs.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException

from agent import batch as batch_mod
from agent import state as state_mod
from routers import ops as ops_mod

BANK_A = uuid.uuid4()
BANK_B = uuid.uuid4()


class _SpyPool:
    """Fake pool that records statements and returns canned values."""

    def __init__(self, row=None, val=None, rows=None):
        self.row, self.val, self.rows = row, val, rows or []
        self.statements: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.statements.append((sql, args))
        return self.row

    async def fetchval(self, sql, *args):
        self.statements.append((sql, args))
        return self.val

    async def fetch(self, sql, *args):
        self.statements.append((sql, args))
        return self.rows

    @property
    def sql(self) -> str:
        return " ".join(s for s, _ in self.statements)

    @property
    def args(self) -> tuple:
        return self.statements[-1][1] if self.statements else ()


@pytest.fixture
def pool(monkeypatch):
    p = _SpyPool()
    monkeypatch.setattr(state_mod, "db_pool", p)
    return p


# -- _fetch_batch_scoped ----------------------------------------------------

def test_lookup_by_uuid_carries_the_tenant_predicate(pool):
    pool.row = {"id": uuid.uuid4()}
    asyncio.run(batch_mod._fetch_batch_scoped(str(uuid.uuid4()), BANK_A))
    assert "($2::uuid IS NULL OR bank_id = $2)" in pool.sql
    assert pool.args[1] == BANK_A


def test_lookup_falls_back_to_the_string_batch_id_still_scoped(pool):
    pool.row = None  # UUID branch misses
    asyncio.run(batch_mod._fetch_batch_scoped("batch_abc123", BANK_A))
    sql, args = pool.statements[-1]
    assert "WHERE batch_id = $1" in sql
    assert "bank_id = $2" in sql
    assert args == ("batch_abc123", BANK_A)


def test_lookup_with_no_id_picks_only_from_the_callers_own_batches(pool):
    pool.row = None
    asyncio.run(batch_mod._fetch_batch_scoped(
        None, BANK_A, statuses=("pending", "running", "paused")))
    sql, args = pool.statements[-1]
    assert "status = ANY($1::text[])" in sql
    assert "bank_id = $2" in sql
    assert args[1] == BANK_A


def test_operator_lookup_passes_null_and_stays_cross_bank(pool):
    pool.row = None
    asyncio.run(batch_mod._fetch_batch_scoped(None, None, statuses=("completed",)))
    assert pool.args[1] is None


def test_no_id_and_no_statuses_returns_none_without_querying(pool):
    assert asyncio.run(batch_mod._fetch_batch_scoped(None, BANK_A)) is None
    assert pool.statements == []


# -- _assert_phone_in_scope -------------------------------------------------

def test_phone_check_requires_ownership_not_just_existence(pool):
    pool.val = None  # active row exists, but not for this bank
    pid = uuid.uuid4()
    with pytest.raises(HTTPException) as e:
        asyncio.run(batch_mod._assert_phone_in_scope(pid, BANK_A))
    assert e.value.status_code == 404
    assert "bank_id = $2" in pool.sql
    assert "status = 'active'" in pool.sql


def test_phone_check_passes_for_own_number(pool):
    pool.val = 1
    asyncio.run(batch_mod._assert_phone_in_scope(uuid.uuid4(), BANK_A))


def test_shared_platform_numbers_stay_usable(pool):
    """phone_numbers.bank_id is nullable (v27 backfill) — NULL means shared."""
    pool.val = 1
    asyncio.run(batch_mod._assert_phone_in_scope(uuid.uuid4(), BANK_A))
    assert "bank_id IS NULL" in pool.sql


def test_operator_phone_check_passes_null(pool):
    pool.val = 1
    asyncio.run(batch_mod._assert_phone_in_scope(uuid.uuid4(), None))
    assert pool.args[1] is None


# -- /api/ops/* -------------------------------------------------------------

def _bank_user(bank_id):
    return {"user_id": str(uuid.uuid4()), "role": "bank_officer",
            "bank_id": str(bank_id), "user_type": "bank_user"}


OPERATOR = {"user_id": "op", "role": "operator", "bank_id": None, "user_type": "operator"}


@pytest.fixture
def ops_pool(monkeypatch):
    p = _SpyPool(rows=[])
    monkeypatch.setattr(ops_mod, "_module_db_pool", lambda: p)
    return p


def test_phone_pools_is_scoped(ops_pool):
    asyncio.run(ops_mod.phone_pools(user=_bank_user(BANK_A)))
    assert "pp.bank_id = $1" in ops_pool.sql
    assert ops_pool.args[0] == BANK_A


def test_phone_pools_stays_open_to_bank_users(ops_pool):
    """The bank batch screen reads this for its caller-ID dropdown, so it must
    keep working for a bank user — scoped, not forbidden."""
    out = asyncio.run(ops_mod.phone_pools(user=_bank_user(BANK_A)))
    assert "pools" in out


def test_phone_pools_operator_sees_everything(ops_pool):
    asyncio.run(ops_mod.phone_pools(user=OPERATOR))
    assert ops_pool.args[0] is None


def test_in_flight_calls_is_scoped(ops_pool):
    asyncio.run(ops_mod.in_flight_calls(user=_bank_user(BANK_A)))
    assert "($1::uuid IS NULL OR bank_id = $1)" in ops_pool.sql
    assert ops_pool.args[0] == BANK_A


def test_in_flight_calls_keeps_the_status_alternation_grouped(ops_pool):
    """The tenant predicate must wrap the status/ended_at OR, not sit beside it,
    or the OR would defeat the filter entirely."""
    asyncio.run(ops_mod.in_flight_calls(user=_bank_user(BANK_A)))
    sql = ops_pool.sql
    assert "AND (status = 'Calling'" in sql


def test_ops_errors_refuses_bank_users(ops_pool):
    """system_errors has no tenancy column and the rows carry stack traces and
    request context from every tenant, so there is nothing to scope by."""
    with pytest.raises(HTTPException) as e:
        asyncio.run(ops_mod.list_recent_errors(user=_bank_user(BANK_A)))
    assert e.value.status_code == 403
    assert ops_pool.statements == [], "must not query before refusing"


def test_ops_errors_still_serves_the_operator_console(ops_pool):
    out = asyncio.run(ops_mod.list_recent_errors(user=OPERATOR))
    assert "errors" in out

# -- batch-status: one query, still tenant-scoped ---------------------------

def test_batch_status_is_one_query_and_still_scoped(monkeypatch):
    """Eight COUNT round-trips became one COUNT(*) FILTER aggregate. The tenant
    predicate has to survive that rewrite."""
    counts = {"pending": 1, "active": 2, "failed": 3, "not_answered": 4,
              "completed": 5, "cancelled": 6, "wrong_contact": 7, "total": 28}
    pool = _SpyPool(row=counts)
    monkeypatch.setattr(state_mod, "db_pool", pool)

    async def _no_stop():
        return False

    monkeypatch.setattr(batch_mod, "is_emergency_stop_active", _no_stop)
    out = asyncio.run(batch_mod.batch_status(user=_bank_user(BANK_A)))

    aggs = [q for q in (s for s, _ in pool.statements) if "COUNT(*) FILTER" in q]
    assert len(aggs) == 1, f"expected a single aggregate query, got {len(aggs)}"
    assert "bank_id = $1" in aggs[0], "the tenant predicate must survive"
    assert pool.statements[0][1][0] == BANK_A
    assert out["total"] == 28 and out["pending"] == 1 and out["wrong_contact"] == 7


def test_batch_status_operator_is_not_bank_filtered(monkeypatch):
    counts = dict.fromkeys(
        ("pending", "active", "failed", "not_answered", "completed",
         "cancelled", "wrong_contact", "total"), 0)
    pool = _SpyPool(row=counts)
    monkeypatch.setattr(state_mod, "db_pool", pool)

    async def _no_stop():
        return False

    monkeypatch.setattr(batch_mod, "is_emergency_stop_active", _no_stop)
    asyncio.run(batch_mod.batch_status(user=OPERATOR))
    assert "bank_id = $" not in pool.sql
