"""Unit tests for Dispatcher._wait_for_cooldown_and_retry.

The dispatcher fires up to DISPATCHER_CONCURRENCY calls at once. When every
eligible trunk is momentarily unavailable, the call must WAIT for one to free
instead of failing. There are two flavours of "unavailable":

  * cooling down  — the trunk has a future ``cooldown_until`` (post-call rest)
  * busy at capacity — ``active_calls >= pool.capacity``, no cooldown yet

The original implementation only waited for the *cooling down* case. A trunk
that was *busy at capacity* (all channels in use) produced no cooldown row, so
the wait query returned nothing and the call was failed with
"No SIP trunk configured" — even though a channel would free seconds later.
These tests pin down the correct behaviour.
"""
import asyncio
import uuid
from unittest.mock import patch

import services.dispatcher as disp
from services.dispatcher import Dispatcher


PHONE_ID = "11111111-1111-1111-1111-111111111111"
TRUNK = {
    "id": PHONE_ID,
    "trunk_id": "ST_x",
    "phone_number": "+910000000000",
    "cooldown_min": 0,
    "cooldown_max": 0,
}


class FakePool:
    """Minimal asyncpg-pool stand-in. Returns scripted values and records how
    many times each method was called. The last element of a sequence is
    repeated for any further calls."""

    def __init__(self, fetchrow_seq=None, fetchval_seq=None):
        self._fetchrow_seq = list(fetchrow_seq or [])
        self._fetchval_seq = list(fetchval_seq or [])
        self.fetchrow_calls = 0
        self.fetchval_calls = 0

    async def fetchrow(self, query, *args):
        self.fetchrow_calls += 1
        if not self._fetchrow_seq:
            return None
        i = min(self.fetchrow_calls - 1, len(self._fetchrow_seq) - 1)
        return self._fetchrow_seq[i]

    async def fetchval(self, query, *args):
        self.fetchval_calls += 1
        if not self._fetchval_seq:
            return None
        i = min(self.fetchval_calls - 1, len(self._fetchval_seq) - 1)
        return self._fetchval_seq[i]


def _make_dispatcher(pool, preferred=PHONE_ID):
    return Dispatcher(
        batch_id_uuid="b", call_batch_id="cb", db_pool=pool,
        livekit_url="", livekit_api_key="", livekit_api_secret="",
        sip_trunk_id_fallback="", agent_name_pusad="p", agent_name_union="u",
        demo_mode=False, wait_for_call_completion=None,
        is_within_calling_hours_fn=lambda: True,
        is_emergency_stop_active_fn=None, now_ist_fn=None,
        max_retries=2, preferred_phone_id=preferred,
    )


def _run(coro):
    return asyncio.run(coro)


async def _noop_sleep(*_a, **_k):
    return None


def test_waits_for_busy_at_capacity_trunk_then_acquires():
    """A trunk that is busy at capacity (no cooldown) must be waited on: the
    function polls and returns the trunk once a channel frees, instead of
    giving up. This is the bug — the old code returned None here."""
    pool = FakePool(
        # New code: an eligible trunk exists but has no cooldown ETA (busy).
        fetchrow_seq=[{"candidates": 1, "cooldown_s": None}],
        # Old code path: no cooling-down trunk -> scalar is None.
        fetchval_seq=[None],
    )
    acquire_results = [None, dict(TRUNK)]  # busy on 1st poll, free on 2nd
    calls = {"n": 0}

    async def fake_acquire(_db_pool, preferred_phone_id=None):
        i = calls["n"]
        calls["n"] += 1
        return acquire_results[min(i, len(acquire_results) - 1)]

    with patch.object(disp, "_acquire_trunk_from_db", fake_acquire), \
            patch.object(disp.asyncio, "sleep", _noop_sleep):
        d = _make_dispatcher(pool)
        trunk = _run(d._wait_for_cooldown_and_retry(uuid.uuid4()))

    assert trunk is not None, "should wait for the busy trunk, not fail the call"
    assert trunk["trunk_id"] == "ST_x"
    assert calls["n"] >= 1, "should actually retry acquisition"


def test_returns_none_when_no_eligible_trunk_exists():
    """When no eligible trunk is configured at all, return None immediately —
    never wait for something that will never free, and never try to acquire."""
    pool = FakePool(
        fetchrow_seq=[{"candidates": 0, "cooldown_s": None}],
        fetchval_seq=[None],
    )

    async def fake_acquire(*_a, **_k):
        raise AssertionError("must not attempt acquire when no candidate exists")

    with patch.object(disp, "_acquire_trunk_from_db", fake_acquire), \
            patch.object(disp.asyncio, "sleep", _noop_sleep):
        d = _make_dispatcher(pool)
        trunk = _run(d._wait_for_cooldown_and_retry(uuid.uuid4()))

    assert trunk is None


def test_waits_for_cooldown_then_acquires():
    """Regression guard: the original cooling-down path still works — wait for
    the cooldown to expire, then acquire."""
    pool = FakePool(
        fetchrow_seq=[{"candidates": 1, "cooldown_s": 0.2}],
        fetchval_seq=[0.2],
    )
    calls = {"n": 0}

    async def fake_acquire(*_a, **_k):
        calls["n"] += 1
        return dict(TRUNK)

    with patch.object(disp, "_acquire_trunk_from_db", fake_acquire), \
            patch.object(disp.asyncio, "sleep", _noop_sleep):
        d = _make_dispatcher(pool)
        trunk = _run(d._wait_for_cooldown_and_retry(uuid.uuid4()))

    assert trunk is not None
    assert calls["n"] == 1
