"""Two abuse/correctness guards.

1. `POST /api/internal/frontend-error` accepts anonymous posts on purpose (a
   crash on the login page would otherwise be lost), but that let any internet
   client inject arbitrary exc_type / message / 4KB trace rows straight into the
   operator error console, unlimited — log injection into an operator surface,
   plus drown-out of a real incident. The anonymous path is now capped per IP.

2. `dispatch_guarantor_call` read LIVEKIT_* with `os.environ[...]` AFTER
   `_claim()` had already set status='calling' and incremented retry_count, and
   BEFORE the try block. A missing env raised KeyError with no cleanup: the row
   stranded in 'calling', `_reclaim_stuck` flipped it to 'failed' ten minutes
   later, and after _MAX_ATTEMPTS such cycles the application was stamped
   `guarantor_consent='no_answer'` — recording that the guarantor declined to
   answer when no call was ever placed.
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from guarantor import dispatch as gdispatch  # noqa: E402
from routers import internal as internal_mod  # noqa: E402


# -- anonymous ingest rate limit -------------------------------------------

@pytest.fixture(autouse=True)
def clean_buckets():
    internal_mod._anon_hits.clear()
    yield
    internal_mod._anon_hits.clear()


def test_first_reports_from_an_ip_are_accepted():
    for _ in range(internal_mod._ANON_MAX_PER_MIN):
        assert internal_mod._anon_rate_ok("203.0.113.7") is True


def test_the_next_report_from_that_ip_is_refused():
    ip = "203.0.113.7"
    for _ in range(internal_mod._ANON_MAX_PER_MIN):
        internal_mod._anon_rate_ok(ip)
    assert internal_mod._anon_rate_ok(ip) is False


def test_one_noisy_ip_does_not_block_another():
    noisy, quiet = "203.0.113.7", "198.51.100.4"
    for _ in range(internal_mod._ANON_MAX_PER_MIN + 5):
        internal_mod._anon_rate_ok(noisy)
    assert internal_mod._anon_rate_ok(quiet) is True


def test_the_window_slides(monkeypatch):
    ip = "203.0.113.7"
    t = [1_000_000.0]
    monkeypatch.setattr(internal_mod.time, "time", lambda: t[0])
    for _ in range(internal_mod._ANON_MAX_PER_MIN):
        internal_mod._anon_rate_ok(ip)
    assert internal_mod._anon_rate_ok(ip) is False
    t[0] += 61  # past the 60s window
    assert internal_mod._anon_rate_ok(ip) is True


def test_the_tracking_dict_stays_bounded():
    for i in range(internal_mod._ANON_TRACKED_IPS + 50):
        internal_mod._anon_rate_ok(f"10.0.{i // 256}.{i % 256}")
    assert len(internal_mod._anon_hits) <= internal_mod._ANON_TRACKED_IPS + 1


def test_the_hmac_ingest_is_unaffected():
    """/api/internal/errors keeps its own signed path — no anonymous branch."""
    assert "agent" in internal_mod.VALID_SOURCES
    assert internal_mod.VALID_LEVELS == frozenset({"error", "warning"})


# -- guarantor dispatch: config before claim -------------------------------

class _SpyPool:
    def __init__(self):
        self.calls: list[str] = []

    async def execute(self, sql, *args):
        self.calls.append(sql)
        return "UPDATE 1"

    async def fetchrow(self, sql, *args):
        self.calls.append(sql)
        return None

    async def fetchval(self, sql, *args):
        self.calls.append(sql)
        return None


@pytest.mark.parametrize("missing", ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"])
def test_missing_livekit_config_does_not_claim_the_row(monkeypatch, missing):
    for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        monkeypatch.setenv(k, "set")
    monkeypatch.delenv(missing, raising=False)

    claimed = []

    async def _claim(pool, row_id):
        claimed.append(row_id)
        return True

    monkeypatch.setattr(gdispatch, "_claim", _claim)
    pool = _SpyPool()
    row = {"id": uuid.uuid4(), "guarantor_phone": "9876543210", "guarantor_name": "G"}

    asyncio.run(gdispatch.dispatch_guarantor_call(pool, row))

    assert claimed == [], "the row must stay pending — no retry consumed"
    assert pool.calls == [], "and nothing should have been written"


def test_a_fully_configured_dispatch_gets_past_the_config_gate(monkeypatch):
    """With the env present the guard must not be what stops the dispatch;
    _claim returning False (another tick took it) is the expected exit."""
    for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        monkeypatch.setenv(k, "set")

    seen = []

    async def _claim(pool, row_id):
        seen.append(row_id)
        return False  # another tick already took it

    monkeypatch.setattr(gdispatch, "_claim", _claim)
    row = {"id": uuid.uuid4(), "guarantor_phone": "9876543210", "guarantor_name": "G"}
    asyncio.run(gdispatch.dispatch_guarantor_call(_SpyPool(), row))
    assert len(seen) == 1, "the config gate should have let this through to _claim"
