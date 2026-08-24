"""Per-bank calling isolation.

"Emergency stop" was a single row in `agent_system_config`, read by the
dispatcher before every call, by the batch runner, by the cron auto-chain and by
the guarantor runner. Any bank user could set it, and it stopped calling for
EVERY tenant: their live calls killed, their batches paused. `/resume-calling`
then ran `UPDATE agent_batches SET status='running' WHERE status='paused'`, so
one bank pressing Resume also restarted batches another bank had deliberately
paused. `/batch-call` cleared the flag unconditionally, so simply starting a
batch un-stopped the whole platform.

The model now:
  * `agent_system_config.emergency_stop` — PLATFORM switch, operator only.
  * `banks.calling_emergency_stopped` — that one bank's switch.
  * A call is blocked if EITHER is set, and each is cleared only by whoever owns
    it.

`banks.calling_paused` is deliberately NOT reused: the billing trigger owns it
(credit_balance <= 0), and clearing it here would let a bank with no credit dial.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException

from agent import batch as batch_mod
from agent import state as state_mod
from services import dispatcher as disp_mod

BANK_A = uuid.uuid4()
BANK_B = uuid.uuid4()


class _Pool:
    """Fake pool. `platform` is the agent_system_config value; `stopped` is the
    set of banks whose own flag is on."""

    def __init__(self, platform=False, stopped=(), rows=None, agg=None,
                 boom_platform=False, boom_bank=False):
        self.platform = platform
        self.stopped = {str(b) for b in stopped}
        self.rows = rows if rows is not None else []
        self.agg = agg
        self.boom_platform = boom_platform
        self.boom_bank = boom_bank
        self.statements: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.statements.append((sql, args))
        if "agent_system_config" in sql:
            if self.boom_platform:
                raise RuntimeError("db down")
            return {"value": "true" if self.platform else "false"}
        if "emergency_stopped_at" in sql:
            if self.boom_bank:
                raise RuntimeError("db down")
            b = str(args[0])
            return {"calling_emergency_stopped": b in self.stopped,
                    "emergency_stopped_at": None, "emergency_stopped_by": "someone",
                    "emergency_stop_reason": "because"}
        if self.agg is not None:
            return self.agg
        return None

    async def fetchval(self, sql, *args):
        self.statements.append((sql, args))
        if "calling_emergency_stopped" in sql:
            if self.boom_bank:
                raise RuntimeError("db down")
            return str(args[0]) in self.stopped
        if "FROM banks WHERE id" in sql:
            return 1
        return 0

    async def fetch(self, sql, *args):
        self.statements.append((sql, args))
        return self.rows

    async def execute(self, sql, *args):
        self.statements.append((sql, args))
        return "UPDATE 2"

    @property
    def sql(self):
        return " ".join(s for s, _ in self.statements)


def _install(monkeypatch, pool):
    monkeypatch.setattr(state_mod, "db_pool", pool)
    monkeypatch.setattr(state_mod, "_emergency_stop", False)
    return pool


def _officer(bank):
    return {"user_id": str(uuid.uuid4()), "role": "bank_officer",
            "bank_id": str(bank), "user_type": "bank_user"}


OPERATOR = {"user_id": "op", "role": "operator", "bank_id": None, "user_type": "operator"}


def _active(bank_id=None):
    return asyncio.run(state_mod.is_emergency_stop_active(bank_id))


# =====================================================================
# is_emergency_stop_active
# =====================================================================

def test_the_platform_switch_blocks_every_bank(monkeypatch):
    _install(monkeypatch, _Pool(platform=True))
    assert _active(BANK_A) is True
    assert _active(BANK_B) is True
    assert _active(None) is True


def test_one_banks_stop_does_not_touch_another(monkeypatch):
    """The whole point of A3."""
    _install(monkeypatch, _Pool(platform=False, stopped=[BANK_A]))
    assert _active(BANK_A) is True
    assert _active(BANK_B) is False


def test_no_bank_in_scope_checks_only_the_platform(monkeypatch):
    _install(monkeypatch, _Pool(platform=False, stopped=[BANK_A]))
    assert _active(None) is False


def test_nothing_stopped_means_dial(monkeypatch):
    _install(monkeypatch, _Pool())
    assert _active(BANK_A) is False


def test_a_platform_read_failure_fails_closed(monkeypatch):
    _install(monkeypatch, _Pool(boom_platform=True))
    assert _active(BANK_A) is True


def test_a_per_bank_read_failure_fails_closed(monkeypatch):
    _install(monkeypatch, _Pool(boom_bank=True))
    assert _active(BANK_A) is True


def test_an_unusable_bank_id_is_treated_as_no_bank(monkeypatch):
    _install(monkeypatch, _Pool(stopped=[BANK_A]))
    assert _active("not-a-uuid") is False


def test_a_bank_id_string_works_the_same_as_a_uuid(monkeypatch):
    _install(monkeypatch, _Pool(stopped=[BANK_A]))
    assert _active(str(BANK_A)) is True


# =====================================================================
# set_emergency_stop
# =====================================================================

def test_setting_without_a_bank_writes_the_platform_row(monkeypatch):
    pool = _install(monkeypatch, _Pool())
    asyncio.run(state_mod.set_emergency_stop(True))
    assert "agent_system_config" in pool.sql
    assert "UPDATE banks" not in pool.sql


def test_setting_with_a_bank_writes_only_that_bank(monkeypatch):
    pool = _install(monkeypatch, _Pool())
    asyncio.run(state_mod.set_emergency_stop(True, bank_id=BANK_A, actor="u1", reason="why"))
    upd = [ (s, a) for s, a in pool.statements if "UPDATE banks" in s ]
    assert len(upd) == 1
    sql, args = upd[0]
    assert "calling_emergency_stopped" in sql
    assert "calling_paused" not in sql, "must not touch the billing-owned column"
    assert BANK_A in args and "u1" in args and "why" in args
    assert "agent_system_config" not in pool.sql


def test_clearing_a_bank_wipes_the_reason(monkeypatch):
    pool = _install(monkeypatch, _Pool())
    asyncio.run(state_mod.set_emergency_stop(False, bank_id=BANK_A, actor="u1"))
    sql, args = [ (s, a) for s, a in pool.statements if "UPDATE banks" in s ][0]
    assert "CASE WHEN $1 THEN" in sql
    assert args[0] is False


def test_an_unusable_bank_id_writes_nothing_and_raises(monkeypatch):
    """It used to log and return, so the endpoint answered 200 "stopped" while
    nothing had been written anywhere."""
    pool = _install(monkeypatch, _Pool())
    with pytest.raises(ValueError):
        asyncio.run(state_mod.set_emergency_stop(True, bank_id="nope"))
    assert pool.statements == []


# =====================================================================
# emergency_stop_state
# =====================================================================

def test_state_reports_both_switches_separately(monkeypatch):
    _install(monkeypatch, _Pool(platform=True, stopped=[BANK_A]))
    st = asyncio.run(state_mod.emergency_stop_state(BANK_A))
    assert st["platform_stopped"] is True
    assert st["bank_stopped"] is True


def test_state_distinguishes_a_bank_only_stop(monkeypatch):
    _install(monkeypatch, _Pool(platform=False, stopped=[BANK_A]))
    st = asyncio.run(state_mod.emergency_stop_state(BANK_A))
    assert st["platform_stopped"] is False and st["bank_stopped"] is True
    st_b = asyncio.run(state_mod.emergency_stop_state(BANK_B))
    assert st_b["bank_stopped"] is False


# =====================================================================
# the dispatcher manager
# =====================================================================

class _FakeDisp:
    def __init__(self, bank_id):
        self.bank_id = str(bank_id) if bank_id else None
        self.stopped = False

    def stop(self):
        self.stopped = True


def test_stop_bank_signals_only_that_banks_dispatchers():
    m = disp_mod.DispatcherManager()
    a1, a2, b1 = _FakeDisp(BANK_A), _FakeDisp(BANK_A), _FakeDisp(BANK_B)
    m.register("b-a1", a1); m.register("b-a2", a2); m.register("b-b1", b1)
    n = m.stop_bank(str(BANK_A))
    assert n == 2
    assert a1.stopped and a2.stopped
    assert not b1.stopped, "another tenant's dispatcher was signalled"


def test_stop_bank_ignores_dispatchers_with_no_bank():
    m = disp_mod.DispatcherManager()
    orphan = _FakeDisp(None)
    m.register("orphan", orphan)
    assert m.stop_bank(str(BANK_A)) == 0
    assert not orphan.stopped


def test_stop_all_still_signals_everything():
    m = disp_mod.DispatcherManager()
    a, b = _FakeDisp(BANK_A), _FakeDisp(BANK_B)
    m.register("x", a); m.register("y", b)
    assert m.stop_all() == 2
    assert a.stopped and b.stopped


# =====================================================================
# the endpoints
# =====================================================================

@pytest.fixture
def no_livekit(monkeypatch):
    """Rows without room_name skip LiveKit entirely."""
    async def _noop():
        return True

    monkeypatch.setattr(batch_mod, "release_batch_lock", _noop)
    signalled = {}

    class _Mgr:
        def stop_all(self):
            signalled["all"] = True
            return 3

        def stop_bank(self, bank_id):
            signalled["bank"] = bank_id
            return 1

    monkeypatch.setattr(disp_mod, "manager", _Mgr())
    return signalled


def test_a_bank_stop_touches_only_that_banks_rows(monkeypatch, no_livekit):
    pool = _install(monkeypatch, _Pool(rows=[]))
    out = asyncio.run(batch_mod.emergency_stop(reason="test", user=_officer(BANK_A)))
    assert out["scope"] == "bank"
    kills = [s for s, _ in pool.statements if "status = 'Calling'" in s]
    assert kills and all("bank_id = $1" in s for s in kills), "killed calls beyond this bank"
    pauses = [s for s, _ in pool.statements if "SET status = 'paused'" in s]
    assert pauses and all("bank_id = $1" in s for s in pauses), "paused another bank's batches"
    assert no_livekit.get("bank") == str(BANK_A)
    assert "all" not in no_livekit, "signalled every dispatcher"
    assert "UPDATE banks" in pool.sql and "agent_system_config" not in pool.sql


def test_an_operator_stop_is_still_platform_wide(monkeypatch, no_livekit):
    pool = _install(monkeypatch, _Pool(rows=[]))
    out = asyncio.run(batch_mod.emergency_stop(reason=None, user=OPERATOR))
    assert out["scope"] == "platform"
    kills = [s for s, _ in pool.statements if "status = 'Calling'" in s]
    assert kills and not any("bank_id" in s for s in kills)
    assert no_livekit.get("all") is True
    assert "agent_system_config" in pool.sql


def test_a_bank_cannot_resume_past_the_platform_switch(monkeypatch):
    _install(monkeypatch, _Pool(platform=True))
    with pytest.raises(HTTPException) as e:
        asyncio.run(batch_mod.resume_calling(bank_id=None, user=_officer(BANK_A)))
    assert e.value.status_code == 409


def test_a_bank_resume_restarts_only_its_own_batches(monkeypatch):
    pool = _install(monkeypatch, _Pool(platform=False, stopped=[BANK_A]))
    out = asyncio.run(batch_mod.resume_calling(bank_id=None, user=_officer(BANK_A)))
    res = [s for s, _ in pool.statements if "SET status = 'running'" in s]
    assert res and all("bank_id = $1" in s for s in res), "restarted another bank's batches"
    assert out["batches_resumed"] == 2


def test_an_operator_resume_clears_the_platform_switch(monkeypatch):
    pool = _install(monkeypatch, _Pool(platform=True))
    asyncio.run(batch_mod.resume_calling(bank_id=None, user=OPERATOR))
    assert "agent_system_config" in pool.sql
    res = [s for s, _ in pool.statements if "SET status = 'running'" in s]
    assert res and not any("bank_id" in s for s in res)


def test_an_operator_can_resume_one_named_bank(monkeypatch):
    pool = _install(monkeypatch, _Pool(platform=False, stopped=[BANK_A]))
    asyncio.run(batch_mod.resume_calling(bank_id=str(BANK_A), user=OPERATOR))
    upd = [(s, a) for s, a in pool.statements if "UPDATE banks" in s]
    assert upd and BANK_A in upd[0][1]
    res = [s for s, _ in pool.statements if "SET status = 'running'" in s]
    assert res and all("bank_id = $1" in s for s in res)


def test_an_operator_resume_rejects_a_bad_bank_id(monkeypatch):
    _install(monkeypatch, _Pool())
    with pytest.raises(HTTPException) as e:
        asyncio.run(batch_mod.resume_calling(bank_id="nope", user=OPERATOR))
    assert e.value.status_code == 400


# =====================================================================
# batch-status must say WHICH switch is blocking
# =====================================================================

def _status(pool, user, monkeypatch):
    monkeypatch.setattr(batch_mod, "is_within_calling_hours", lambda: True)
    return asyncio.run(batch_mod.batch_status(user=user))


AGG = {"pending": 5, "active": 0, "failed": 0, "not_answered": 0,
       "completed": 0, "cancelled": 0, "wrong_contact": 0, "total": 5}


def test_status_names_the_platform_switch(monkeypatch):
    _install(monkeypatch, _Pool(platform=True, agg=AGG))
    out = _status(_Pool(platform=True, agg=AGG), _officer(BANK_A), monkeypatch)
    assert out["blocked_reason"] == "platform_emergency_stop"


def test_status_names_the_banks_own_switch(monkeypatch):
    _install(monkeypatch, _Pool(platform=False, stopped=[BANK_A], agg=AGG))
    out = _status(None, _officer(BANK_A), monkeypatch)
    assert out["blocked_reason"] == "bank_emergency_stop"


def test_status_is_not_blocked_for_an_unaffected_bank(monkeypatch):
    _install(monkeypatch, _Pool(platform=False, stopped=[BANK_A], agg=AGG))
    out = _status(None, _officer(BANK_B), monkeypatch)
    assert out["blocked_reason"] is None


def test_status_reports_outside_hours_when_nothing_is_stopped(monkeypatch):
    _install(monkeypatch, _Pool(agg=AGG))
    monkeypatch.setattr(batch_mod, "is_within_calling_hours", lambda: False)
    out = asyncio.run(batch_mod.batch_status(user=_officer(BANK_A)))
    assert out["blocked_reason"] == "outside_calling_hours"

# =====================================================================
# A failed persist must never be reported as a stop
# =====================================================================
# The first live run of this feature returned 200 {"scope":"bank"} while the
# UPDATE was failing every time: inside `CASE WHEN $1 THEN $2 ELSE NULL END`
# Postgres has no column to infer $2 from and defaults it to text, so it raised
# "column emergency_stopped_at is of type timestamp with time zone but
# expression is of type text" - and the except block logged and continued. A
# kill switch that reports success without persisting is worse than none.
# The fake pool here cannot type-check SQL, which is exactly why these tests
# assert the SHAPE of the statement and the failure behaviour instead.


class _BoomOnUpdate(_Pool):
    async def execute(self, sql, *args):
        self.statements.append((sql, args))
        if "UPDATE banks" in sql or "agent_system_config" in sql:
            raise RuntimeError("column ... is of type timestamp ... expression is of type text")
        return "UPDATE 0"


class _NoSuchBank(_Pool):
    async def execute(self, sql, *args):
        self.statements.append((sql, args))
        return "UPDATE 0"


def test_the_timestamp_parameter_is_cast(monkeypatch):
    """Without ::timestamptz Postgres infers text and the write fails."""
    pool = _install(monkeypatch, _Pool())
    asyncio.run(state_mod.set_emergency_stop(True, bank_id=BANK_A, actor="u", reason="r"))
    sql = [s for s, _ in pool.statements if "UPDATE banks" in s][0]
    assert "$2::timestamptz" in sql, "the CASE timestamp parameter is uncast again"
    assert "$4::text" in sql, "the CASE reason parameter is uncast again"


def test_a_failed_bank_persist_raises(monkeypatch):
    _install(monkeypatch, _BoomOnUpdate())
    with pytest.raises(Exception):
        asyncio.run(state_mod.set_emergency_stop(True, bank_id=BANK_A))


def test_a_failed_platform_persist_raises(monkeypatch):
    _install(monkeypatch, _BoomOnUpdate())
    with pytest.raises(Exception):
        asyncio.run(state_mod.set_emergency_stop(True))


def test_a_failed_platform_persist_leaves_the_cached_flag_alone(monkeypatch):
    """Setting the in-memory flag before the write succeeded would make the
    process believe it had stopped."""
    _install(monkeypatch, _BoomOnUpdate())
    monkeypatch.setattr(state_mod, "_emergency_stop", False)
    with pytest.raises(Exception):
        asyncio.run(state_mod.set_emergency_stop(True))
    assert state_mod._emergency_stop is False


def test_an_unknown_bank_raises_rather_than_silently_doing_nothing(monkeypatch):
    _install(monkeypatch, _NoSuchBank())
    with pytest.raises(ValueError):
        asyncio.run(state_mod.set_emergency_stop(True, bank_id=BANK_A))


def test_an_unusable_bank_id_raises(monkeypatch):
    _install(monkeypatch, _Pool())
    with pytest.raises(ValueError):
        asyncio.run(state_mod.set_emergency_stop(True, bank_id="nope"))


def test_the_stop_endpoint_reports_503_when_the_switch_did_not_persist(monkeypatch, no_livekit):
    _install(monkeypatch, _BoomOnUpdate())
    with pytest.raises(HTTPException) as e:
        asyncio.run(batch_mod.emergency_stop(reason=None, user=_officer(BANK_A)))
    assert e.value.status_code == 503
    assert "NOT stopped" in str(e.value.detail)


def test_the_resume_endpoint_reports_503_when_it_could_not_clear(monkeypatch):
    _install(monkeypatch, _BoomOnUpdate())
    with pytest.raises(HTTPException) as e:
        asyncio.run(batch_mod.resume_calling(bank_id=None, user=_officer(BANK_A)))
    assert e.value.status_code == 503
