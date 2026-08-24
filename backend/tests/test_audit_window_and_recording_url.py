"""Two smaller hardening items.

`_audit_page` ran an unbounded `SELECT count(*)` on append-only audit tables on
every page load, with only equality filters and never a time range. Postgres
cannot answer `count(*)` from an index, so at scale each audit page load became
a full table scan — and the six-tab `/ops/audit` UI issues several
concurrently. A default window bounds both the count and the page, and makes the
existing `(bank_id, created_at DESC)` indexes usable for both.

`recording_path` arrives from the agent transcript webhook, is stored, and is
later rendered to officers as a link. Nothing validated it. The webhook is
loopback-only, which is what keeps this low severity — but a stored traversing
or absolute URL is cheap to prevent.
"""
from __future__ import annotations

import asyncio
import datetime
import os
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import main as main_mod  # noqa: E402


# =========================================================================
# audit window
# =========================================================================

class _Pool:
    def __init__(self):
        self.count_sql = ""
        self.count_args: tuple = ()
        self.page_sql = ""

    async def fetchval(self, sql, *args):
        self.count_sql, self.count_args = sql, args
        return 0

    async def fetch(self, sql, *args):
        self.page_sql = sql
        return []


@pytest.fixture
def pool(monkeypatch):
    p = _Pool()
    monkeypatch.setattr(main_mod, "db_pool", p)
    return p


def _page(pool, **kw):
    return asyncio.run(main_mod._audit_page(
        "activity_log", "id, created_at", kw.pop("filters", []), 50, 0, **kw))


def test_the_count_is_time_bounded_by_default(pool):
    _page(pool)
    assert "created_at >=" in pool.count_sql, "count(*) is still unbounded"
    assert isinstance(pool.count_args[-1], datetime.datetime)


def test_the_page_query_carries_the_same_bound(pool):
    """A bound on the count but not the page would report a total that does not
    match the rows."""
    _page(pool)
    assert "created_at >=" in pool.page_sql


def test_the_window_uses_the_order_column(pool):
    """audit_logs is keyed on `timestamp`, not created_at."""
    asyncio.run(main_mod._audit_page("audit_logs", "id", [], 50, 0, order="timestamp"))
    assert "timestamp >=" in pool.count_sql


def test_the_bound_is_roughly_the_configured_window(pool):
    _page(pool)
    cutoff = pool.count_args[-1]
    days = (main_mod.now_utc() - cutoff).days
    assert abs(days - main_mod.AUDIT_DEFAULT_WINDOW_DAYS) <= 1


def test_a_caller_can_narrow_the_window(pool):
    _page(pool, since_days=7)
    cutoff = pool.count_args[-1]
    assert (main_mod.now_utc() - cutoff).days == 7


def test_a_caller_can_remove_the_bound(pool):
    """0 is the explicit escape hatch for a genuine full-history query."""
    _page(pool, since_days=0)
    assert "created_at >=" not in pool.count_sql
    assert pool.count_args == ()


def test_the_window_composes_with_the_existing_filters(pool):
    _page(pool, filters=[("bank_id", "b1"), ("action", None)])
    assert "bank_id = $1" in pool.count_sql
    assert "created_at >= $2" in pool.count_sql, "placeholders must stay in order"
    assert pool.count_args[0] == "b1"


def test_the_default_window_is_generous_enough_to_be_invisible():
    """This must not become a product limit that hides a bank's own history."""
    assert main_mod.AUDIT_DEFAULT_WINDOW_DAYS >= 365


def test_limit_is_still_clamped(pool):
    out = asyncio.run(main_mod._audit_page("activity_log", "id", [], 9999, -5))
    assert out["limit"] == 200 and out["offset"] == 0


# =========================================================================
# recording url
# =========================================================================

@pytest.fixture
def rec(monkeypatch):
    """Import the helper with a base URL configured."""
    monkeypatch.setenv("RECORDING_BASE_URL", "https://host/api/recordings/")
    import importlib

    from agent import state as st
    importlib.reload(st)
    from agent import transcript as t
    importlib.reload(t)
    yield t.safe_recording_url
    # leave the modules reloaded with a clean env for the rest of the suite
    monkeypatch.delenv("RECORDING_BASE_URL", raising=False)
    importlib.reload(st)
    importlib.reload(t)


@pytest.mark.parametrize("path", [
    "../../etc/passwd",
    "a/../../b.ogg",
    "https://evil.example/x.ogg",
    "http://evil.example/x.ogg",
    "//evil.example/x.ogg",
    "sub\\..\\x.ogg",
])
def test_a_traversing_or_absolute_path_is_refused(rec, path):
    assert rec(path) is None, f"{path!r} was accepted"


@pytest.mark.parametrize("path", [
    "call_123.ogg",
    "2026/08/call_123.ogg",
    "room-abc_1787000000.ogg",
])
def test_a_plain_relative_path_is_accepted(rec, path):
    assert rec(path) == f"https://host/api/recordings/{path}"


@pytest.mark.parametrize("path", [None, "", "   "])
def test_no_path_means_no_url(rec, path):
    assert rec(path) is None


def test_no_base_url_means_no_url(monkeypatch):
    """Unset RECORDING_BASE_URL must not produce a relative-looking URL."""
    monkeypatch.delenv("RECORDING_BASE_URL", raising=False)
    import importlib

    from agent import state as st
    importlib.reload(st)
    from agent import transcript as t
    importlib.reload(t)
    assert t.safe_recording_url("call_123.ogg") is None
