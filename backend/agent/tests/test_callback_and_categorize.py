"""Three bugs in the callback / categorise paths.

1. `POST /api/agent/schedule-callback-manual` inserted the new `agent_calls` row
   with **no bank_id**. Two consequences: the call never showed up in the
   originating bank's own dashboards, and `_bill_completed_call` short-circuits
   on a missing bank_id — so real outbound PSTN calls were placed and **never
   billed to anyone**.

2. `PUT /api/agent/calls/{id}/categorize` read the row unscoped and then wrote
   with a tenant predicate, but never checked the affected-row count — so a
   cross-tenant attempt updated nothing and still returned
   `{"status": "updated"}`. False success, and an existence oracle.

3. `bank_id IS NOT DISTINCT FROM $n` was used with the comment "matches NULL=NULL
   (operator)". It does the opposite: for an operator ($n = NULL) it matches only
   rows whose bank_id **IS NULL**. So `/live-status` showed a platform operator
   nothing but orphaned calls, and categorise could only touch those. Replaced
   with `($n::uuid IS NULL OR bank_id = $n)` — NULL means no filter.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException

from agent import callbacks as cb_mod
from agent import calls as calls_mod
from agent import state as state_mod

BANK_A = uuid.uuid4()
BANK_B = uuid.uuid4()
CALL_ID = uuid.uuid4()


class _Pool:
    def __init__(self, row=None, val=1, exec_result="UPDATE 1", bank_status="active"):
        self.row = row
        self.val = val
        self.exec_result = exec_result
        self.bank_status = bank_status
        self.statements: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.statements.append((sql, args))
        return self.row

    async def fetchval(self, sql, *args):
        self.statements.append((sql, args))
        if "SELECT status FROM banks" in sql:
            return self.bank_status
        return self.val

    async def execute(self, sql, *args):
        self.statements.append((sql, args))
        return self.exec_result

    async def fetch(self, sql, *args):
        self.statements.append((sql, args))
        return []

    @property
    def sql(self):
        return " ".join(s for s, _ in self.statements)


def _officer(bank):
    return {"user_id": str(uuid.uuid4()), "role": "bank_officer",
            "bank_id": str(bank), "user_type": "bank_user"}


OPERATOR = {"user_id": "op", "role": "operator", "bank_id": None, "user_type": "operator"}


# =========================================================================
# 1. manual callbacks must belong to a bank
# =========================================================================

class _Req:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def _body(**over):
    b = {"customer_name": "Test", "phone": "9876543210",
         "callback_iso": "2099-01-01T11:00:00", "reason": "manual"}
    b.update(over)
    return b


@pytest.fixture
def cb_pool(monkeypatch):
    p = _Pool()
    monkeypatch.setattr(state_mod, "db_pool", p)

    async def _ensure():
        return None

    monkeypatch.setattr(cb_mod, "_ensure_manual_batch", _ensure)
    return p


def _schedule(body, user):
    return asyncio.run(cb_mod.schedule_callback_manual(_Req(body), user=user))


def test_a_bank_users_callback_carries_their_bank_id(cb_pool):
    out = _schedule(_body(), _officer(BANK_A))
    assert out["status"] == "success"
    insert = [(s, a) for s, a in cb_pool.statements if "INSERT INTO agent_calls" in s]
    assert len(insert) == 1
    sql, args = insert[0]
    assert "bank_id" in sql, "the INSERT must name bank_id"
    assert BANK_A in args, "and pass the caller's bank"


def test_an_operator_must_say_which_bank(cb_pool):
    """An operator has no bank of their own; an unattributed call is unbillable."""
    with pytest.raises(HTTPException) as e:
        _schedule(_body(), OPERATOR)
    assert e.value.status_code == 400
    assert not any("INSERT INTO agent_calls" in s for s, _ in cb_pool.statements)


def test_an_operator_supplying_a_bank_is_accepted(cb_pool):
    out = _schedule(_body(bank_id=str(BANK_B)), OPERATOR)
    assert out["status"] == "success"
    sql, args = [(s, a) for s, a in cb_pool.statements if "INSERT INTO agent_calls" in s][0]
    assert BANK_B in args


def test_an_unknown_bank_is_rejected(monkeypatch):
    pool = _Pool(bank_status=None)  # SELECT status FROM banks -> no row
    monkeypatch.setattr(state_mod, "db_pool", pool)

    async def _ensure():
        return None

    monkeypatch.setattr(cb_mod, "_ensure_manual_batch", _ensure)
    with pytest.raises(HTTPException) as e:
        _schedule(_body(bank_id=str(uuid.uuid4())), OPERATOR)
    assert e.value.status_code == 404


def test_a_malformed_bank_id_is_rejected(cb_pool):
    with pytest.raises(HTTPException) as e:
        _schedule(_body(bank_id="not-a-uuid"), OPERATOR)
    assert e.value.status_code == 400


def test_validation_still_runs_before_any_of_this(cb_pool):
    with pytest.raises(HTTPException) as e:
        _schedule(_body(customer_name=""), _officer(BANK_A))
    assert e.value.status_code == 400


# =========================================================================
# 2 + 3. categorise: no false success, and NULL means all banks
# =========================================================================

class _Data:
    category = "Interested - Callback Requested"
    reminder_date = None
    after_call_remark = "called back"


def _categorize(pool, user):
    return asyncio.run(calls_mod.categorize_call(str(CALL_ID), _Data(), user=user))


def test_a_cross_tenant_categorise_is_a_404_not_a_false_success(monkeypatch):
    pool = _Pool(row={"call_analysis": {}}, exec_result="UPDATE 0")
    monkeypatch.setattr(state_mod, "db_pool", pool)
    with pytest.raises(HTTPException) as e:
        _categorize(pool, _officer(BANK_A))
    assert e.value.status_code == 404


def test_own_bank_categorise_succeeds(monkeypatch):
    pool = _Pool(row={"call_analysis": {}}, exec_result="UPDATE 1")
    monkeypatch.setattr(state_mod, "db_pool", pool)
    out = _categorize(pool, _officer(BANK_A))
    assert out["status"] == "updated"


def test_categorise_uses_null_means_all_not_is_not_distinct_from(monkeypatch):
    pool = _Pool(row={"call_analysis": {}}, exec_result="UPDATE 1")
    monkeypatch.setattr(state_mod, "db_pool", pool)
    _categorize(pool, OPERATOR)
    upd = [s for s, _ in pool.statements if "UPDATE agent_calls" in s][0]
    assert "IS NOT DISTINCT FROM" not in upd, "the inverted operator predicate is back"
    assert "$5::uuid IS NULL OR bank_id = $5" in upd


def test_a_missing_call_is_still_a_404(monkeypatch):
    pool = _Pool(row=None)
    monkeypatch.setattr(state_mod, "db_pool", pool)
    with pytest.raises(HTTPException) as e:
        _categorize(pool, _officer(BANK_A))
    assert e.value.status_code == 404


def test_live_status_no_longer_hides_everything_from_an_operator(monkeypatch):
    pool = _Pool(row=None, val=0)
    monkeypatch.setattr(state_mod, "db_pool", pool)

    async def _no_stop():
        return False

    monkeypatch.setattr(calls_mod, "is_emergency_stop_active", _no_stop, raising=False)
    try:
        asyncio.run(calls_mod.get_live_status(user=OPERATOR))
    except Exception:
        pass  # the rest of the handler is not what we are pinning here
    assert "IS NOT DISTINCT FROM" not in pool.sql, "the inverted operator predicate is back"


@pytest.mark.parametrize("status", ["inactive", "suspended"])
def test_a_non_active_bank_is_rejected(monkeypatch, status):
    """The /ops bank picker lists every bank the admin API returns, including
    the LEGACY / UNASSIGNED placeholder (status=inactive). Assigning work to one
    would dial on behalf of a bank that is not supposed to be operating."""
    pool = _Pool(bank_status=status)
    monkeypatch.setattr(state_mod, "db_pool", pool)

    async def _ensure():
        return None

    monkeypatch.setattr(cb_mod, "_ensure_manual_batch", _ensure)
    with pytest.raises(HTTPException) as e:
        _schedule(_body(bank_id=str(BANK_B)), OPERATOR)
    assert e.value.status_code == 400
    assert status in str(e.value.detail)
    assert not any("INSERT INTO agent_calls" in s for s, _ in pool.statements)
