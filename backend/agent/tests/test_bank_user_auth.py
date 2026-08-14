"""Unit tests for the hardened get_current_bank_user dependency (agent/state.py).

#16: a missing token must be REJECTED (was: silent operator access to all banks).
- no token   -> 401
- admin JWT  -> operator scope (bank_id=None, sees all)
- bank_user  -> scoped to their bank_id
- bad/expired/other -> 401/403
"""
import asyncio
import datetime

import jwt as pyjwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

import agent.state as state
from agent.state import get_current_bank_user, JWT_SECRET


def _tok(**claims):
    base = {"exp": datetime.datetime.utcnow() + datetime.timedelta(hours=1)}
    base.update(claims)
    return HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=pyjwt.encode(base, JWT_SECRET, algorithm="HS256"),
    )


def _run(cred):
    return asyncio.get_event_loop().run_until_complete(get_current_bank_user(cred))


def test_no_token_rejected():
    # the core #16 fix: missing credentials -> 401 (was operator/all-banks)
    with pytest.raises(HTTPException) as e:
        _run(None)
    assert e.value.status_code == 401


def test_admin_token_gets_operator_scope():
    u = _run(_tok(user_id="a1", user_type="admin", role="admin"))
    assert u["user_type"] == "operator"
    assert u["bank_id"] is None  # sees all banks


def test_bank_user_scoped_to_its_bank():
    u = _run(_tok(user_id="b1", user_type="bank_user", role="bank_officer", bank_id="bank-xyz"))
    assert u["user_type"] == "bank_user"
    assert u["bank_id"] == "bank-xyz"


def test_bank_user_wrong_role_forbidden():
    with pytest.raises(HTTPException) as e:
        _run(_tok(user_id="b1", user_type="bank_user", role="teller", bank_id="bank-xyz"))
    assert e.value.status_code == 403


def test_unknown_user_type_forbidden():
    with pytest.raises(HTTPException) as e:
        _run(_tok(user_id="v1", user_type="vendor", role="vendor"))
    assert e.value.status_code == 403


def test_bad_signature_rejected():
    bad = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=pyjwt.encode({"user_type": "admin"}, "wrong-secret", algorithm="HS256"),
    )
    with pytest.raises(HTTPException) as e:
        _run(bad)
    assert e.value.status_code == 401


def test_expired_token_rejected():
    expired = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=pyjwt.encode(
            {"user_type": "admin", "exp": datetime.datetime.utcnow() - datetime.timedelta(hours=1)},
            JWT_SECRET, algorithm="HS256",
        ),
    )
    with pytest.raises(HTTPException) as e:
        _run(expired)
    assert e.value.status_code == 401
