"""The shared per-key sliding-window limiter.

Before this existed there was **no rate limiting anywhere** in the backend. The
only throttles were three bespoke DB counters (OTP send, per-username login
lockout, PAN mismatch attempts), which left unbounded:

  * `/api/verify-aadhaar`, `/api/aadhaar-link|documents|download` and
    `/api/verify-pan` — every one a **paid** third-party call, reachable with a
    single OTP-verified form token. Loop them and the vendor bill grows.
  * `/api/agent/export/*` and `/api/bank/admin/usage/export` — a full dump of a
    bank's call records per request.
  * The login endpoints had a per-**username** lockout with no IP dimension, so
    credential stuffing across many usernames from one host was unbounded — and
    an attacker who knew usernames could deliberately lock out every user.

Limits are abuse ceilings, not product limits: a real applicant never
approaches them.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services import ratelimit as rl  # noqa: E402


@pytest.fixture(autouse=True)
def clean():
    rl.reset()
    yield
    rl.reset()


@pytest.fixture
def clock(monkeypatch):
    t = [1_000_000.0]
    monkeypatch.setattr(rl.time, "time", lambda: t[0])
    return t


# -- window behaviour -------------------------------------------------------

def test_events_up_to_the_limit_are_allowed(monkeypatch):
    monkeypatch.setenv("RATELIMIT_TESTB", "3/60")
    assert [rl.allow("testb", "k") for _ in range(3)] == [True, True, True]


def test_the_next_event_is_refused(monkeypatch):
    monkeypatch.setenv("RATELIMIT_TESTB", "3/60")
    for _ in range(3):
        rl.allow("testb", "k")
    assert rl.allow("testb", "k") is False


def test_the_window_slides(monkeypatch, clock):
    monkeypatch.setenv("RATELIMIT_TESTB", "2/60")
    assert rl.allow("testb", "k") and rl.allow("testb", "k")
    assert rl.allow("testb", "k") is False
    clock[0] += 61
    assert rl.allow("testb", "k") is True


def test_it_is_a_sliding_window_not_a_fixed_bucket(monkeypatch, clock):
    """Two events 40s apart with a 60s window: at t+50 only the second counts."""
    monkeypatch.setenv("RATELIMIT_TESTB", "2/60")
    rl.allow("testb", "k")          # t
    clock[0] += 40
    rl.allow("testb", "k")          # t+40
    assert rl.allow("testb", "k") is False
    clock[0] += 21                  # t+61: the first has aged out, the second has not
    assert rl.allow("testb", "k") is True
    assert rl.allow("testb", "k") is False


# -- isolation --------------------------------------------------------------

def test_keys_are_independent(monkeypatch):
    monkeypatch.setenv("RATELIMIT_TESTB", "1/60")
    assert rl.allow("testb", "a") is True
    assert rl.allow("testb", "a") is False
    assert rl.allow("testb", "b") is True


def test_buckets_are_independent(monkeypatch):
    monkeypatch.setenv("RATELIMIT_ONE", "1/60")
    monkeypatch.setenv("RATELIMIT_TWO", "1/60")
    assert rl.allow("one", "k") is True
    assert rl.allow("one", "k") is False
    assert rl.allow("two", "k") is True


def test_a_missing_key_is_still_tracked(monkeypatch):
    """An unresolvable client IP must not become an unlimited free pass."""
    monkeypatch.setenv("RATELIMIT_TESTB", "1/60")
    assert rl.allow("testb", "") is True
    assert rl.allow("testb", "") is False
    assert rl.allow("testb", None) is False  # same "unknown" bucket key


# -- configuration ----------------------------------------------------------

def test_env_overrides_the_default(monkeypatch):
    monkeypatch.setenv("RATELIMIT_AADHAAR", "1/30")
    assert rl._limit_for("aadhaar") == (1, 30)


def test_a_malformed_env_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("RATELIMIT_AADHAAR", "nonsense")
    assert rl._limit_for("aadhaar") == rl._DEFAULTS["aadhaar"]


def test_an_unknown_bucket_still_gets_a_limit():
    """Never unlimited by accident."""
    n, w = rl._limit_for("something_new")
    assert n > 0 and w > 0


@pytest.mark.parametrize("bucket", ["aadhaar", "aadhaar_ip", "pan", "pan_ip",
                                    "export", "login_ip", "frontend_error"])
def test_every_wired_bucket_has_a_default(bucket):
    assert bucket in rl._DEFAULTS


@pytest.mark.parametrize("bucket", ["aadhaar", "pan"])
def test_the_per_token_kyc_cap_is_tight(bucket):
    """One application has no legitimate reason to need many paid vendor calls."""
    n, w = rl._DEFAULTS[bucket]
    assert n <= 15 and w >= 3600


@pytest.mark.parametrize("bucket", ["aadhaar_ip", "pan_ip"])
def test_the_per_ip_kyc_cap_is_loose_enough_for_cgnat(bucket):
    """Too tight here blocks real applicants who share a carrier address."""
    n, w = rl._DEFAULTS[bucket]
    assert n >= 100 and w >= 3600


def test_the_per_ip_cap_is_looser_than_the_per_token_cap():
    assert rl._DEFAULTS["aadhaar_ip"][0] > rl._DEFAULTS["aadhaar"][0]
    assert rl._DEFAULTS["pan_ip"][0] > rl._DEFAULTS["pan"][0]


# -- check() ----------------------------------------------------------------

def test_check_raises_429_with_retry_after(monkeypatch):
    monkeypatch.setenv("RATELIMIT_TESTB", "1/60")
    rl.check("testb", "k")
    with pytest.raises(HTTPException) as e:
        rl.check("testb", "k")
    assert e.value.status_code == 429
    assert int(e.value.headers["Retry-After"]) >= 1


def test_check_is_silent_while_under_the_limit(monkeypatch):
    monkeypatch.setenv("RATELIMIT_TESTB", "5/60")
    for _ in range(5):
        rl.check("testb", "k")  # must not raise


def test_check_request_keys_on_the_real_client_ip(monkeypatch):
    """Behind nginx the peer is always 127.0.0.1, so it must use the forwarded
    IP — otherwise every caller shares one bucket."""
    monkeypatch.setenv("RATELIMIT_TESTB", "1/60")
    seen = []
    monkeypatch.setattr("services.audit.get_client_ip", lambda r: seen.append(r) or "203.0.113.9")

    class _Req:
        pass

    req = _Req()
    rl.check_request("testb", req)
    with pytest.raises(HTTPException):
        rl.check_request("testb", req)
    assert seen == [req, req]


def test_an_unresolvable_ip_does_not_crash(monkeypatch):
    monkeypatch.setenv("RATELIMIT_TESTB", "1/60")
    monkeypatch.setattr("services.audit.get_client_ip", lambda r: None)
    rl.check_request("testb", object())
    with pytest.raises(HTTPException):
        rl.check_request("testb", object())


# -- memory -----------------------------------------------------------------

def test_the_key_table_stays_bounded(monkeypatch):
    monkeypatch.setenv("RATELIMIT_TESTB", "100/60")
    for i in range(rl._MAX_KEYS_PER_BUCKET + 200):
        rl.allow("testb", f"10.0.{i // 256}.{i % 256}")
    assert len(rl._hits["testb"]) <= rl._MAX_KEYS_PER_BUCKET + 1


def test_reset_clears_one_bucket_only(monkeypatch):
    monkeypatch.setenv("RATELIMIT_ONE", "1/60")
    monkeypatch.setenv("RATELIMIT_TWO", "1/60")
    rl.allow("one", "k")
    rl.allow("two", "k")
    rl.reset("one")
    assert rl.allow("one", "k") is True
    assert rl.allow("two", "k") is False
