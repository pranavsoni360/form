"""A refresh token must not authenticate a request — on ANY dependency.

`create_refresh_token` emits the same claim shape as `create_access_token`;
the only difference is `"type": "refresh"`. Every auth dependency checked
`user_type` and nothing checked `type`, so a refresh token was a valid bearer
credential for its full `REFRESH_TOKEN_HOURS` (9h vs the access token's 30 min)
— and it survived logout, because `/api/auth/logout` deletes the
`refresh_tokens` row while the JWT itself still verifies. A suspended or
departed employee kept access to call data, recordings and LRS for hours.

The guard denies `type == "refresh"` rather than requiring `type == "access"`,
so tokens minted before the claim existed (the legacy admin-login path) keep
working. Both halves are pinned below.

This file covers every request-auth dependency in the codebase. Add a new one
and add it here.
"""
from __future__ import annotations

import asyncio
import datetime
import sys
import uuid
from pathlib import Path

import jwt as pyjwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import main as main_mod  # noqa: E402
from agent import state as agent_state  # noqa: E402
from routers import bank_admin as bank_admin_mod  # noqa: E402
from routers import realtime as realtime_mod  # noqa: E402
from routers import vendors as vendors_mod  # noqa: E402

ADMIN_ID = str(uuid.uuid4())
USER_ID = str(uuid.uuid4())
BANK_ID = str(uuid.uuid4())
VENDOR_USER_ID = str(uuid.uuid4())


def _tok(**claims) -> HTTPAuthorizationCredentials:
    base = {"exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)}
    base.update(claims)
    return HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=pyjwt.encode(base, main_mod.JWT_SECRET, algorithm="HS256"),
    )


class _Pool:
    """Returns a plausible row for whichever table is asked about."""

    def __init__(self):
        self.queried = False

    async def fetchrow(self, sql, *args):
        self.queried = True
        if "admin_users" in sql:
            return {"id": uuid.UUID(ADMIN_ID), "email": "a@b.c", "role": "super_admin",
                    "full_name": "A", "is_active": True}
        if "bank_users" in sql or "bank_users bu" in sql:
            return {"id": uuid.UUID(USER_ID), "bank_id": uuid.UUID(BANK_ID),
                    "branch_id": None, "role": "bank_admin", "is_active": True,
                    "bank_name": "B", "bank_code": "B1", "seat_cap": 10,
                    "minute_quota": 100, "credit_balance": 0, "full_name": "U",
                    "username": "u"}
        if "vendor_users" in sql:
            return {"id": uuid.UUID(VENDOR_USER_ID), "vendor_id": uuid.uuid4(),
                    "vendor_name": "V", "vendor_status": "active", "status": "active"}
        return None

    async def fetchval(self, sql, *args):
        return None

    async def execute(self, sql, *args):
        return "UPDATE 1"


@pytest.fixture(autouse=True)
def pools(monkeypatch):
    p = _Pool()
    monkeypatch.setattr(main_mod, "db_pool", p)
    monkeypatch.setattr(agent_state, "db_pool", p)
    monkeypatch.setattr(bank_admin_mod, "_db", lambda: p)
    monkeypatch.setattr(vendors_mod, "_db", lambda: p)
    return p


# Every request-auth dependency, with the claims its happy path needs.
DEPENDENCIES = [
    ("main.get_current_admin", main_mod.get_current_admin,
     {"user_id": ADMIN_ID, "user_type": "admin", "role": "super_admin"}),
    ("main.get_current_bank_user", main_mod.get_current_bank_user,
     {"user_id": USER_ID, "user_type": "bank_user", "role": "bank_officer", "bank_id": BANK_ID}),
    ("main.auth_me", main_mod.auth_me,
     {"user_id": ADMIN_ID, "user_type": "admin", "role": "super_admin"}),
    ("bank_admin.get_bank_admin", bank_admin_mod.get_bank_admin,
     {"user_id": USER_ID, "user_type": "bank_user", "role": "bank_admin", "bank_id": BANK_ID}),
    ("vendors.get_current_vendor", vendors_mod.get_current_vendor,
     {"user_id": VENDOR_USER_ID, "user_type": "vendor", "role": "vendor"}),
    ("realtime.issue_stream_token", realtime_mod.issue_stream_token,
     {"user_id": ADMIN_ID, "user_type": "admin", "role": "super_admin"}),
    ("agent.state.get_current_bank_user", agent_state.get_current_bank_user,
     {"user_id": USER_ID, "user_type": "bank_user", "role": "bank_officer", "bank_id": BANK_ID}),
]

IDS = [d[0] for d in DEPENDENCIES]


@pytest.mark.parametrize("name,dep,claims", DEPENDENCIES, ids=IDS)
def test_a_refresh_token_is_rejected(name, dep, claims):
    cred = _tok(**claims, type="refresh", jti=uuid.uuid4().hex)
    with pytest.raises(HTTPException) as e:
        asyncio.run(dep(cred))
    assert e.value.status_code == 401, f"{name} accepted a refresh token"
    assert "refresh" in str(e.value.detail).lower()


@pytest.mark.parametrize("name,dep,claims", DEPENDENCIES, ids=IDS)
def test_an_access_token_is_still_accepted(name, dep, claims):
    """The guard must not have broken the normal path."""
    cred = _tok(**claims, type="access")
    try:
        asyncio.run(dep(cred))
    except HTTPException as e:
        # 401/403 here would mean the guard (or the stub row) rejected a valid
        # access token. Anything else is this test's own stubbing limits.
        assert e.status_code not in (401, 403), f"{name} rejected a valid access token: {e.detail}"


@pytest.mark.parametrize("name,dep,claims", DEPENDENCIES, ids=IDS)
def test_a_legacy_token_with_no_type_claim_is_still_accepted(name, dep, claims):
    """`/api/admin/login` historically minted tokens with no "type" claim, which
    is why the guard denies "refresh" instead of requiring "access"."""
    cred = _tok(**claims)
    try:
        asyncio.run(dep(cred))
    except HTTPException as e:
        assert e.status_code not in (401, 403), f"{name} rejected a legacy token: {e.detail}"


def test_the_refresh_endpoint_itself_still_accepts_one():
    """The guard must not be applied to the refresh flow — that is the one place
    a refresh token is the correct credential."""
    import inspect
    src = inspect.getsource(main_mod.auth_refresh)
    assert 'type") == "refresh"' not in src, \
        "the refresh endpoint must not reject refresh tokens"
    assert '"refresh"' in src, "auth_refresh should still validate the token type"
