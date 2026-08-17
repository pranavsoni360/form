"""Unit tests for the calling-window guard (agent/state.py).

Covers the two compliance fixes:

  1. The global window is the LEGAL CAP and must exclude late-night hours.
     Regression for the old default CALL_END_HOUR=24 (10 AM–midnight), which
     allowed loan calls until midnight — a RBI/TRAI violation.
  2. A per-bank window (bank_settings.calling_window_start/end) may only NARROW
     the cap, never widen past it. Previously the per-bank window was ignored
     entirely (is_within_calling_hours was global-only).

Pure logic — now_ist() is patched, no DB or network.
"""
from datetime import datetime
from unittest.mock import patch

import pytz
import pytest

import agent.state as state
from agent.state import is_within_calling_hours, _hhmm_to_hour

IST = pytz.timezone("Asia/Kolkata")


def _ist_at(hour, minute=30):
    return IST.localize(datetime(2026, 8, 13, hour, minute, 0))


@pytest.fixture
def cap_10_19():
    """Pin the legal cap to 10:00–19:00 regardless of the runtime env."""
    with patch.object(state, "CALL_START_HOUR", 10), patch.object(state, "CALL_END_HOUR", 19):
        yield


def _at(hour, bank_window=None):
    with patch.object(state, "now_ist", lambda: _ist_at(hour)):
        return is_within_calling_hours(bank_window)


# ── global legal cap ────────────────────────────────────────────────────────
@pytest.mark.parametrize("hour,expected", [
    (9,  False),  # before start
    (10, True),   # start is inclusive
    (13, True),
    (18, True),   # last active hour
    (19, False),  # end is exclusive — 7 PM cutoff
    (22, False),
    (23, False),
    (0,  False),
])
def test_global_window(cap_10_19, hour, expected):
    assert _at(hour) is expected


def test_midnight_calling_is_blocked(cap_10_19):
    """Regression: CALL_END_HOUR=24 used to allow calls 10 AM–midnight."""
    assert _at(21) is False
    assert _at(23) is False
    assert _at(0) is False


# ── per-bank window may only narrow ─────────────────────────────────────────
def test_bank_narrows_window(cap_10_19):
    # bank calls only 10–15; at 16:30 the global cap would allow it, bank must not
    assert _at(16, ("10:00", "15:00")) is False
    assert _at(12, ("10:00", "15:00")) is True


def test_bank_cannot_widen_past_cap(cap_10_19):
    # bank asks for 09–22, but the legal cap 10–19 still wins
    assert _at(9,  ("09:00", "22:00")) is False   # before the legal start
    assert _at(20, ("09:00", "22:00")) is False   # after the legal end
    assert _at(11, ("09:00", "22:00")) is True


def test_bank_window_none_parts_fall_back(cap_10_19):
    # only an end is set; start falls back to the global 10
    assert _at(9,  (None, "18:00")) is False
    assert _at(10, (None, "18:00")) is True
    assert _at(18, (None, "18:00")) is False


def test_backward_compatible_no_args(cap_10_19):
    """Existing call sites call is_within_calling_hours() with no argument."""
    assert _at(12) is True
    assert _at(19) is False


# ── HH:MM parsing ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("val,expected", [
    ("19:00", 19), ("19:30", 19), ("09:05", 9), ("00:00", 0),
    (19, 19), ("7", 7),
    (None, None), ("", None), ("garbage", None),
])
def test_hhmm_to_hour(val, expected):
    assert _hhmm_to_hour(val) == expected
