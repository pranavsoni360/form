"""get_dashboard_stats: same response, far fewer queries.

It used to issue one COUNT(*) per headline figure and then one more per status
and per category option — about 29 scans of agent_calls per dashboard load.
That made it the slowest endpoint in the API under concurrency (p99 ~1.9s at 60
concurrent against QA). It is now one COUNT(*) FILTER aggregate plus two GROUP
BY queries.

The subtle part of the rewrite is the breakdowns: a GROUP BY only returns values
that exist, whereas the per-option loop always produced a key. The dicts are
therefore pre-seeded with every configured option at zero, and that contract is
what these tests pin — a missing key would silently break the dashboard tiles.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from agent import calls as calls_mod
from agent import state as state_mod
from agent.state import CATEGORY_OPTIONS, STATUS_OPTIONS

BANK = uuid.uuid4()


class _Pool:
    """Returns the aggregate row and whatever GROUP BY rows the test wants."""

    def __init__(self, status_rows=None, category_rows=None, agg=None):
        self.status_rows = status_rows or []
        self.category_rows = category_rows or []
        self.agg = agg or {
            "total": 7, "forms_sent": 3, "hot": 2, "warm": 1, "pending": 4,
            "not_answered": 2, "education": 1, "business": 2, "personal": 3,
        }
        self.queries: list[str] = []

    async def fetchrow(self, sql, *args):
        self.queries.append(sql)
        return self.agg

    async def fetch(self, sql, *args):
        self.queries.append(sql)
        if "GROUP BY status" in sql:
            return self.status_rows
        if "GROUP BY category" in sql:
            return self.category_rows
        return []

    async def fetchval(self, sql, *args):
        self.queries.append(sql)
        return 0


def _officer():
    return {"user_id": str(uuid.uuid4()), "role": "bank_officer",
            "bank_id": str(BANK), "user_type": "bank_user"}


def _run(pool, monkeypatch, user=None):
    monkeypatch.setattr(state_mod, "db_pool", pool)
    return asyncio.run(calls_mod.get_dashboard_stats(user=user or _officer()))


def test_the_endpoint_now_costs_three_queries(monkeypatch):
    pool = _Pool()
    _run(pool, monkeypatch)
    assert len(pool.queries) == 3, (
        f"expected 1 aggregate + 2 GROUP BY, got {len(pool.queries)}"
    )
    assert sum("COUNT(*) FILTER" in q for q in pool.queries) == 1
    assert sum("GROUP BY status" in q for q in pool.queries) == 1
    assert sum("GROUP BY category" in q for q in pool.queries) == 1


def test_headline_figures_come_from_the_aggregate(monkeypatch):
    out = _run(_Pool(), monkeypatch)
    assert out["total_calls"] == 7
    assert out["whatsapp_forms_sent"] == 3
    assert out["hot_leads"] == 2
    assert out["warm_leads"] == 1
    assert out["pending_calls"] == 4
    assert out["not_answered"] == 2
    assert out["loan_interests"] == {"education": 1, "business": 2, "personal": 3}


def test_every_status_option_keeps_a_key_even_with_no_rows(monkeypatch):
    """GROUP BY returns nothing for absent statuses; the tiles still need keys."""
    out = _run(_Pool(status_rows=[]), monkeypatch)
    assert set(out["by_status"]) == set(STATUS_OPTIONS)
    assert all(v == 0 for v in out["by_status"].values())


def test_every_category_option_keeps_a_key_even_with_no_rows(monkeypatch):
    out = _run(_Pool(category_rows=[]), monkeypatch)
    assert set(out["by_category"]) == set(CATEGORY_OPTIONS)
    assert all(v == 0 for v in out["by_category"].values())


def test_present_counts_are_filled_in_and_the_rest_stay_zero(monkeypatch):
    s0, s1 = STATUS_OPTIONS[0], STATUS_OPTIONS[1]
    c0 = CATEGORY_OPTIONS[0]
    pool = _Pool(
        status_rows=[{"status": s0, "n": 5}, {"status": s1, "n": 2}],
        category_rows=[{"category": c0, "n": 9}],
    )
    out = _run(pool, monkeypatch)
    assert out["by_status"][s0] == 5
    assert out["by_status"][s1] == 2
    assert all(out["by_status"][k] == 0 for k in STATUS_OPTIONS[2:])
    assert out["by_category"][c0] == 9


def test_an_unrecognised_value_from_the_db_is_ignored_not_added(monkeypatch):
    """A status the config does not know about must not appear as a new tile."""
    pool = _Pool(status_rows=[{"status": "Some Legacy Status", "n": 4}])
    out = _run(pool, monkeypatch)
    assert "Some Legacy Status" not in out["by_status"]
    assert set(out["by_status"]) == set(STATUS_OPTIONS)


def test_a_null_category_does_not_crash_the_breakdown(monkeypatch):
    pool = _Pool(category_rows=[{"category": None, "n": 3}])
    out = _run(pool, monkeypatch)
    assert set(out["by_category"]) == set(CATEGORY_OPTIONS)


def test_the_bank_predicate_is_still_applied(monkeypatch):
    pool = _Pool()
    _run(pool, monkeypatch)
    assert all("bank_id = $1" in q for q in pool.queries), \
        "every query must stay tenant-scoped"


def test_an_operator_is_not_bank_filtered(monkeypatch):
    pool = _Pool()
    operator = {"user_id": "op", "role": "operator", "bank_id": None,
                "user_type": "operator"}
    _run(pool, monkeypatch, user=operator)
    assert not any("bank_id = $" in q for q in pool.queries)


def test_the_date_filter_still_narrows_the_window(monkeypatch):
    pool = _Pool()
    monkeypatch.setattr(state_mod, "db_pool", pool)
    asyncio.run(calls_mod.get_dashboard_stats(date="2026-08-01", user=_officer()))
    assert all("created_at >=" in q for q in pool.queries)


def test_calling_hours_block_is_still_reported(monkeypatch):
    out = _run(_Pool(), monkeypatch)
    assert set(out["calling_hours"]) == {"start", "end", "currently_active"}
