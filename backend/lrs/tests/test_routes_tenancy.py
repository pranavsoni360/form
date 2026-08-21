"""Tenant-isolation tests for the LRS HTTP routes.

`lrs_scores` carries no bank_id column, so tenancy for these endpoints can only
come from the parent `loan_applications` row. None of the handlers consulted it:

  * GET  /api/lrs/score/{id}   returned SELECT * FROM lrs_scores WHERE
    application_id = $1 — any bank officer holding any application UUID read
    another bank's credit file, `raw_provider_data` (the raw bureau/KYC
    response) included.
  * POST /api/lrs/rescore/{id} force-rescored it too, overwriting the
    system_score/system_suggestion that the owning bank's officers see and
    re-firing paid bureau lookups against that borrower.
  * POST /api/lrs/rescore-pending selected up to 500 pre-decision applications
    with no bank predicate at all — one officer, every tenant.
  * PUT  /api/lrs/config accepted bank_officer, so the most junior role could
    publish the live scorecard behind every credit decision.

Operators (admin token, bank_id=None) are deliberately cross-bank throughout.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException

from lrs import routes

BANK_A = str(uuid.uuid4())
BANK_B = str(uuid.uuid4())
APP_ID = uuid.uuid4()


class _FakePool:
    """Records every statement so the tests can assert on the predicate."""

    def __init__(self, owner_bank=None, score_row=None, fetch_rows=None):
        self.owner_bank = owner_bank
        self.score_row = score_row
        self.fetch_rows = fetch_rows or []
        self.statements: list[tuple[str, tuple]] = []

    async def fetchval(self, sql, *args):
        self.statements.append((sql, args))
        return uuid.UUID(self.owner_bank) if self.owner_bank else None

    async def fetchrow(self, sql, *args):
        self.statements.append((sql, args))
        return self.score_row

    async def fetch(self, sql, *args):
        self.statements.append((sql, args))
        return self.fetch_rows


def _officer(bank_id):
    return {"user_id": str(uuid.uuid4()), "role": "bank_officer",
            "bank_id": bank_id, "user_type": "bank_user"}


def _admin_of(bank_id):
    return {**_officer(bank_id), "role": "bank_admin"}


OPERATOR = {"user_id": "op", "role": "operator", "bank_id": None, "user_type": "operator"}


def _install(monkeypatch, pool):
    from agent import state as _state
    monkeypatch.setattr(_state, "db_pool", pool)
    return pool


# -- the guard itself -------------------------------------------------------

def test_same_bank_passes(monkeypatch):
    pool = _FakePool(owner_bank=BANK_A)
    asyncio.run(routes._assert_app_in_scope(pool, APP_ID, _officer(BANK_A)))


def test_other_bank_is_404(monkeypatch):
    pool = _FakePool(owner_bank=BANK_B)
    with pytest.raises(HTTPException) as e:
        asyncio.run(routes._assert_app_in_scope(pool, APP_ID, _officer(BANK_A)))
    assert e.value.status_code == 404


def test_missing_application_is_the_same_404(monkeypatch):
    """Identical response for absent and out-of-scope: no existence oracle."""
    pool = _FakePool(owner_bank=None)
    with pytest.raises(HTTPException) as e:
        asyncio.run(routes._assert_app_in_scope(pool, APP_ID, _officer(BANK_A)))
    assert e.value.status_code == 404
    assert e.value.detail == "application not found"


def test_operator_is_not_scoped_and_does_not_query(monkeypatch):
    pool = _FakePool(owner_bank=BANK_B)
    asyncio.run(routes._assert_app_in_scope(pool, APP_ID, OPERATOR))
    assert pool.statements == [], "operator scope should short-circuit"


# -- GET /score/{id} --------------------------------------------------------

def test_get_score_refuses_another_banks_application(monkeypatch):
    pool = _install(monkeypatch, _FakePool(
        owner_bank=BANK_B,
        score_row={"application_id": APP_ID, "total_score": 71,
                   "raw_provider_data": '{"bureau": "secret"}'},
    ))
    with pytest.raises(HTTPException) as e:
        asyncio.run(routes.get_score(str(APP_ID), user=_officer(BANK_A)))
    assert e.value.status_code == 404
    assert not any("lrs_scores" in sql for sql, _ in pool.statements), \
        "must not read the score row before the ownership check"


def test_get_score_returns_own_banks_application(monkeypatch):
    _install(monkeypatch, _FakePool(
        owner_bank=BANK_A,
        score_row={"application_id": APP_ID, "total_score": 71,
                   "raw_provider_data": '{"bureau": "ok"}'},
    ))
    out = asyncio.run(routes.get_score(str(APP_ID), user=_officer(BANK_A)))
    assert out["total_score"] == 71
    assert out["raw_provider_data"] == {"bureau": "ok"}  # json-decoded


def test_get_score_rejects_a_malformed_id(monkeypatch):
    _install(monkeypatch, _FakePool(owner_bank=BANK_A))
    with pytest.raises(HTTPException) as e:
        asyncio.run(routes.get_score("not-a-uuid", user=_officer(BANK_A)))
    assert e.value.status_code == 400


# -- POST /rescore/{id} -----------------------------------------------------

def test_rescore_refuses_another_banks_application(monkeypatch):
    _install(monkeypatch, _FakePool(owner_bank=BANK_B))
    called = []

    async def _boom(*a, **k):
        called.append(a)
        return {"total_score": 1, "decision": "reject"}

    import lrs.handlers as h
    monkeypatch.setattr(h, "run_and_persist", _boom)
    with pytest.raises(HTTPException) as e:
        asyncio.run(routes.rescore(str(APP_ID), user=_officer(BANK_A)))
    assert e.value.status_code == 404
    assert called == [], "scoring must not run for another bank's application"


def test_rescore_runs_for_own_bank(monkeypatch):
    _install(monkeypatch, _FakePool(owner_bank=BANK_A))

    async def _ok(pool, app_uuid, force=False):
        return {"total_score": 64, "decision": "refer"}

    import lrs.handlers as h
    monkeypatch.setattr(h, "run_and_persist", _ok)
    out = asyncio.run(routes.rescore(str(APP_ID), user=_officer(BANK_A)))
    assert out == {"ok": True, "total_score": 64, "decision": "refer"}


# -- POST /rescore-pending --------------------------------------------------

def _stub_enqueue(monkeypatch):
    queued = []
    import services.job_worker as jw

    async def _enqueue(pool, job_type, payload):
        queued.append((job_type, payload))

    monkeypatch.setattr(jw, "enqueue_job", _enqueue)
    return queued


def test_rescore_pending_is_scoped_to_the_callers_bank(monkeypatch):
    pool = _install(monkeypatch, _FakePool(fetch_rows=[{"id": APP_ID}]))
    queued = _stub_enqueue(monkeypatch)
    out = asyncio.run(routes.rescore_pending(user=_officer(BANK_A)))
    sql, args = pool.statements[-1]
    assert "la.bank_id = $2" in sql, "bulk rescore must carry a tenant predicate"
    assert args[1] == uuid.UUID(BANK_A)
    assert out["queued"] == 1 and len(queued) == 1


def test_rescore_pending_stays_cross_bank_for_an_operator(monkeypatch):
    pool = _install(monkeypatch, _FakePool(fetch_rows=[]))
    _stub_enqueue(monkeypatch)
    asyncio.run(routes.rescore_pending(user=OPERATOR))
    sql, args = pool.statements[-1]
    assert "bank_id" not in sql
    assert len(args) == 1


def test_rescore_pending_never_touches_decided_applications(monkeypatch):
    """A scorecard tweak must not be able to flip a decision already made."""
    assert set(routes._RESCORABLE_STATUSES) == {"draft", "submitted", "documents_submitted"}
    for decided in ("officer_approved", "supervisor_rejected", "approved", "disbursed"):
        assert decided not in routes._RESCORABLE_STATUSES


# -- PUT /config ------------------------------------------------------------

class _Req:
    """Request stub whose body read explodes — proves the gate runs first."""

    async def json(self):
        raise AssertionError("body was parsed before the permission check")


def test_officer_cannot_publish_the_scorecard(monkeypatch):
    _install(monkeypatch, _FakePool())
    with pytest.raises(HTTPException) as e:
        asyncio.run(routes.put_config(_Req(), user=_officer(BANK_A)))
    assert e.value.status_code == 403


def test_supervisor_cannot_publish_the_scorecard(monkeypatch):
    _install(monkeypatch, _FakePool())
    user = {**_officer(BANK_A), "role": "bank_supervisor"}
    with pytest.raises(HTTPException) as e:
        asyncio.run(routes.put_config(_Req(), user=user))
    assert e.value.status_code == 403


def test_bank_admin_gets_past_the_gate(monkeypatch):
    """Reaching the body parse (400) means the role check allowed it through."""
    _install(monkeypatch, _FakePool())

    class _BadBody:
        async def json(self):
            raise ValueError("not json")

    with pytest.raises(HTTPException) as e:
        asyncio.run(routes.put_config(_BadBody(), user=_admin_of(BANK_A)))
    assert e.value.status_code == 400


def test_operator_gets_past_the_gate(monkeypatch):
    """Platform operators edit the global default template."""
    _install(monkeypatch, _FakePool())

    class _BadBody:
        async def json(self):
            raise ValueError("not json")

    with pytest.raises(HTTPException) as e:
        asyncio.run(routes.put_config(_BadBody(), user=OPERATOR))
    assert e.value.status_code == 400
