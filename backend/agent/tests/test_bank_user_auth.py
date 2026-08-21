"""Unit tests for the hardened get_current_bank_user dependency (agent/state.py).

This dependency guards ~34 routes: all of agent/*, lrs/* and ops/*.

#16: a missing token must be REJECTED (was: silent operator access to all banks).
- no token   -> 401
- admin JWT  -> operator scope (bank_id=None, sees all)
- bank_user  -> scoped to their bank_id
- bad/expired/other -> 401/403

Later hardening, pinned below:
- A refresh token is not an API credential. It carries the same claims as an
  access token and differs only by "type", so it used to work as a bearer token
  for its full 9-hour life and survived logout (logout deletes the
  refresh_tokens row, but the JWT itself still verifies).
- Scope, role and active-status come from the DB row, never from the claims.
  Reading them from the token meant a deactivated user kept access on every
  route guarded here until their token expired, while the equivalent dependency
  in main.py, which always re-read the row, correctly locked them out.
"""
import asyncio
import datetime
import uuid

import jwt as pyjwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

import agent.state as state
from agent.state import get_current_bank_user, JWT_SECRET

ADMIN_ID = str(uuid.uuid4())
USER_ID = str(uuid.uuid4())
BANK_ID = str(uuid.uuid4())
BRANCH_ID = str(uuid.uuid4())
OTHER_BANK_ID = str(uuid.uuid4())


class _FakePool:
    """Minimal asyncpg-pool stand-in: one canned row per table."""

    def __init__(self, admin_row=None, bank_row=None):
        self._admin, self._bank = admin_row, bank_row
        self.seen = []

    async def fetchrow(self, sql, *args):
        self.seen.append((sql, args))
        return self._admin if "admin_users" in sql else self._bank


def _active_admin():
    return {"id": uuid.UUID(ADMIN_ID)}


def _active_bank_user(role="bank_officer", bank_id=BANK_ID, branch_id=BRANCH_ID):
    return {
        "id": uuid.UUID(USER_ID),
        "bank_id": uuid.UUID(bank_id) if bank_id else None,
        "branch_id": uuid.UUID(branch_id) if branch_id else None,
        "role": role,
    }


@pytest.fixture
def pool(monkeypatch):
    """Install a fake pool; each test can swap the canned rows."""
    p = _FakePool(admin_row=_active_admin(), bank_row=_active_bank_user())
    monkeypatch.setattr(state, "db_pool", p)
    return p


def _tok(**claims):
    base = {"exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)}
    base.update(claims)
    return HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=pyjwt.encode(base, JWT_SECRET, algorithm="HS256"),
    )


def _run(cred):
    return asyncio.run(get_current_bank_user(cred))


def _bank_tok(**over):
    claims = {"user_id": USER_ID, "user_type": "bank_user",
              "role": "bank_officer", "bank_id": BANK_ID}
    claims.update(over)
    return _tok(**claims)


# -- #16: token presence and validity ---------------------------------------

def test_no_token_rejected(pool):
    with pytest.raises(HTTPException) as e:
        _run(None)
    assert e.value.status_code == 401


def test_bad_signature_rejected(pool):
    bad = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=pyjwt.encode({"user_type": "admin"}, "wrong-secret", algorithm="HS256"),
    )
    with pytest.raises(HTTPException) as e:
        _run(bad)
    assert e.value.status_code == 401


def test_expired_token_rejected(pool):
    expired = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=pyjwt.encode(
            {"user_type": "admin",
             "exp": datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)},
            JWT_SECRET, algorithm="HS256",
        ),
    )
    with pytest.raises(HTTPException) as e:
        _run(expired)
    assert e.value.status_code == 401


def test_unknown_user_type_forbidden(pool):
    with pytest.raises(HTTPException) as e:
        _run(_tok(user_id=str(uuid.uuid4()), user_type="vendor", role="vendor"))
    assert e.value.status_code == 403


def test_malformed_user_id_rejected_not_crashed(pool):
    """A non-UUID claim used to reach uuid.UUID() unguarded -> unhandled 500."""
    with pytest.raises(HTTPException) as e:
        _run(_tok(user_id="not-a-uuid", user_type="bank_user", role="bank_officer"))
    assert e.value.status_code == 401


# -- refresh tokens are not API credentials ---------------------------------

def test_refresh_token_rejected(pool):
    with pytest.raises(HTTPException) as e:
        _run(_bank_tok(type="refresh", jti="whatever"))
    assert e.value.status_code == 401


def test_admin_refresh_token_rejected(pool):
    with pytest.raises(HTTPException) as e:
        _run(_tok(user_id=ADMIN_ID, user_type="admin", role="admin", type="refresh"))
    assert e.value.status_code == 401


def test_access_token_still_accepted(pool):
    assert _run(_bank_tok(type="access"))["user_type"] == "bank_user"


def test_token_without_a_type_claim_still_accepted(pool):
    """Legacy tokens carry no "type"; denying only "refresh" keeps them working."""
    assert _run(_bank_tok())["user_type"] == "bank_user"


# -- scope comes from the DB, not the claims --------------------------------

def test_admin_token_gets_operator_scope(pool):
    u = _run(_tok(user_id=ADMIN_ID, user_type="admin", role="admin"))
    assert u["user_type"] == "operator"
    assert u["bank_id"] is None  # sees all banks


def test_deactivated_admin_rejected(pool):
    pool._admin = None  # WHERE is_active = true matched nothing
    with pytest.raises(HTTPException) as e:
        _run(_tok(user_id=ADMIN_ID, user_type="admin", role="admin"))
    assert e.value.status_code == 401


def test_bank_user_scoped_to_its_bank(pool):
    u = _run(_bank_tok())
    assert u["user_type"] == "bank_user"
    assert u["bank_id"] == BANK_ID
    assert u["branch_id"] == BRANCH_ID  # was never returned before


def test_stale_bank_id_claim_is_ignored(pool):
    """A token minted before the user moved banks must not grant the old scope."""
    u = _run(_bank_tok(bank_id=OTHER_BANK_ID))
    assert u["bank_id"] == BANK_ID, "bank_id must come from the DB row, not the JWT"


def test_deactivated_bank_user_rejected(pool):
    pool._bank = None
    with pytest.raises(HTTPException) as e:
        _run(_bank_tok())
    assert e.value.status_code == 401


def test_role_comes_from_the_db_not_the_claim(pool):
    """Claim says officer, the row says teller -> forbidden."""
    pool._bank = _active_bank_user(role="teller")
    with pytest.raises(HTTPException) as e:
        _run(_bank_tok(role="bank_officer"))
    assert e.value.status_code == 403


def test_bank_user_wrong_role_forbidden(pool):
    pool._bank = _active_bank_user(role="teller")
    with pytest.raises(HTTPException) as e:
        _run(_bank_tok(role="teller"))
    assert e.value.status_code == 403


@pytest.mark.parametrize("role", ["bank_officer", "bank_supervisor", "bank_admin"])
def test_all_three_bank_roles_keep_read_access(pool, role):
    """bank_admin must keep bank-scoped reads (scorecard editor, call logs)."""
    pool._bank = _active_bank_user(role=role)
    assert _run(_bank_tok(role=role))["role"] == role


def test_user_with_no_branch_reports_none(pool):
    pool._bank = _active_bank_user(branch_id=None)
    assert _run(_bank_tok())["branch_id"] is None


# -- availability -----------------------------------------------------------

def test_no_db_pool_returns_503_not_a_crash(monkeypatch):
    monkeypatch.setattr(state, "db_pool", None)
    with pytest.raises(HTTPException) as e:
        _run(_bank_tok())
    assert e.value.status_code == 503
