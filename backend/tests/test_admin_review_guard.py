"""`POST /api/admin/review` must not resurrect a dead application.

Every bank-side decision endpoint pins `status = ANY(...)` in its UPDATE and
checks the affected-row count. This one had neither: a bare `WHERE id = $6`.
So a stale admin tab could take an application the customer had **withdrawn**,
or one already **disbursed**, or a **draft** that was never submitted, straight
to `approved` — and the handler then WhatsApps the customer "Congratulations ...
Your loan application has been APPROVED."

Platform-admin override on a live application is intentional and still works.
Terminal and not-yet-submitted states are refused, and a concurrent change now
returns 409 instead of sending the customer a message about a decision that did
not land.
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import main as main_mod  # noqa: E402

APP_ID = uuid.uuid4()
ADMIN_ID = str(uuid.uuid4())


class _Pool:
    def __init__(self, status="submitted", disbursed_at=None, rows="UPDATE 1"):
        self.row = {
            "id": APP_ID, "status": status, "disbursed_at": disbursed_at,
            "customer_name": "Test User", "loan_id": "LN-1", "phone": "9999999999",
        }
        self.rows = rows
        self.updates: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        return self.row

    async def execute(self, sql, *args):
        self.updates.append((sql, args))
        return self.rows

    async def fetchval(self, sql, *args):
        return None


class _Payload:
    def __init__(self, action="approve", notes="ok", reason=None):
        self.application_id = str(APP_ID)
        self.action = action
        self.notes = notes
        self.rejection_reason = reason


class _Req:
    class _URL:
        path = "/api/admin/review"

    url = _URL()
    method = "POST"
    headers: dict = {}
    client = None


@pytest.fixture(autouse=True)
def stubs(monkeypatch):
    """Neutralise the side effects: transition log, WhatsApp, audit."""
    sent = []

    async def _noop(*a, **k):
        return None

    async def _wa(phone, message):
        sent.append((phone, message))

    monkeypatch.setattr(main_mod, "record_transition", _noop)
    monkeypatch.setattr(main_mod, "send_whatsapp_message", _wa)
    return sent


def _run(pool, payload=None, monkeypatch=None):
    return asyncio.run(main_mod.review_application(
        payload or _Payload(), _Req(), admin={"id": ADMIN_ID},
    ))


def _install(monkeypatch, pool):
    monkeypatch.setattr(main_mod, "db_pool", pool)
    return pool


# -- states that must be refused -------------------------------------------

@pytest.mark.parametrize("status", ["cancelled", "withdrawn", "disbursed", "draft"])
@pytest.mark.parametrize("action", ["approve", "reject"])
def test_terminal_and_draft_states_are_refused(monkeypatch, stubs, status, action):
    pool = _install(monkeypatch, _Pool(status=status))
    with pytest.raises(HTTPException) as e:
        _run(pool, _Payload(action=action, reason="r"))
    assert e.value.status_code == 400
    assert pool.updates == [], "must not write"
    assert stubs == [], "must not message the customer"


def test_a_disbursed_loan_is_refused_even_if_the_status_says_otherwise(monkeypatch, stubs):
    """disbursed_at is the money-has-moved signal; trust it over status."""
    pool = _install(monkeypatch, _Pool(status="approved", disbursed_at="2026-01-01"))
    with pytest.raises(HTTPException) as e:
        _run(pool)
    assert e.value.status_code == 400
    assert pool.updates == []
    assert stubs == []


# -- live applications still work -----------------------------------------

@pytest.mark.parametrize("status", ["submitted", "documents_submitted", "officer_approved", "approved"])
def test_admin_override_on_a_live_application_still_works(monkeypatch, stubs, status):
    pool = _install(monkeypatch, _Pool(status=status))
    out = _run(pool)
    assert out["status"] == "success"
    assert len(pool.updates) == 1
    assert len(stubs) == 1, "the customer should be told about a real decision"


def test_the_update_pins_the_status_it_read(monkeypatch, stubs):
    pool = _install(monkeypatch, _Pool(status="submitted"))
    _run(pool)
    sql, args = pool.updates[0]
    assert "AND status=" in sql, "optimistic-concurrency guard missing"
    assert "submitted" in args


def test_reject_records_the_reason(monkeypatch, stubs):
    pool = _install(monkeypatch, _Pool(status="officer_approved"))
    _run(pool, _Payload(action="reject", reason="income too low"))
    sql, args = pool.updates[0]
    assert "rejection_reason" in sql
    assert "income too low" in args
    assert "supervisor_rejected" in args


def test_an_invalid_action_is_rejected_before_anything_else(monkeypatch, stubs):
    pool = _install(monkeypatch, _Pool(status="submitted"))
    with pytest.raises(HTTPException) as e:
        _run(pool, _Payload(action="maybe"))
    assert e.value.status_code == 400
    assert pool.updates == []


# -- concurrency ----------------------------------------------------------

def test_a_concurrent_change_returns_409_and_sends_no_message(monkeypatch, stubs):
    """Someone else moved it between our read and our write."""
    pool = _install(monkeypatch, _Pool(status="submitted", rows="UPDATE 0"))
    with pytest.raises(HTTPException) as e:
        _run(pool)
    assert e.value.status_code == 409
    assert stubs == [], "no 'APPROVED' WhatsApp for a decision that did not land"
