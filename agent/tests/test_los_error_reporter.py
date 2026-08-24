"""Regression tests for the agent → backend error reporter.

Two real bugs are pinned here; both made the reporter look armed while
silently dropping every event:

1. `install()` runs at module import time (agent_core.py imports it before the
   LiveKit worker loop exists). It used to call `asyncio.get_event_loop()`,
   which on Python 3.12 returns a brand-new loop that never runs — every
   report was queued onto that dead loop and lost. The loop must be captured
   at first report instead.
2. The backend serves TLS on loopback with a cert issued for its public
   hostname, so `https://127.0.0.1:<port>` fails hostname verification. Without
   an opt-out the POST raised inside `_post` and was swallowed at debug level.
"""
from __future__ import annotations

import asyncio
import logging

import pytest

import los_error_reporter as R


@pytest.fixture(autouse=True)
def reset_reporter():
    """The reporter is module-global singleton state — reset around each test."""
    root = logging.getLogger()
    before = list(root.handlers)
    yield
    for h in list(root.handlers):
        if h not in before:
            root.removeHandler(h)
    R._INSTALLED = False
    R._LOOP = None
    R._DEDUP.clear()
    R._RATE_BUCKET.clear()
    R._CONFIG.update({"backend_url": "", "secret": "", "tls_verify": True,
                      "min_level": logging.ERROR, "dedup_window_s": 60, "max_qps": 5})


def _arm(monkeypatch, **env):
    """install() the reporter the way agent_core does: at import time, with no
    running event loop. Returns the list that captured payloads land in."""
    monkeypatch.setenv("LOS_BACKEND_URL", env.pop("url", "https://127.0.0.1:8300"))
    monkeypatch.setenv("LOS_INTERNAL_HMAC_SECRET", env.pop("secret", "test-secret"))
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert R.install() is True

    sent: list[dict] = []

    async def _capture(payload):
        sent.append(payload)

    monkeypatch.setattr(R, "_post", _capture)
    return sent


# ── bug 1: the dead-loop drop ────────────────────────────────────────────────

def test_install_without_running_loop_does_not_capture_a_dead_loop(monkeypatch):
    """install() at import time must leave the loop unresolved, not invent one."""
    _arm(monkeypatch)
    assert R._LOOP is None


def test_error_logged_inside_the_agent_loop_is_actually_delivered(monkeypatch):
    """The end-to-end regression: armed at import, report from the running loop."""
    sent = _arm(monkeypatch)

    async def main():
        logging.getLogger("agent.calls").error("SIP trunk refused the call")
        await asyncio.sleep(0.05)  # let the fire-and-forget task run

    asyncio.run(main())

    assert len(sent) == 1, "report was dropped instead of being posted"
    assert sent[0]["source"] == "agent"
    assert sent[0]["level"] == "error"
    assert "SIP trunk refused" in sent[0]["message"]
    assert sent[0]["metadata"]["logger"] == "agent.calls"


def test_a_stale_captured_loop_is_replaced_not_reused(monkeypatch):
    """A closed loop from a previous job must not swallow the next job's reports."""
    sent = _arm(monkeypatch)

    dead = asyncio.new_event_loop()
    dead.close()
    R._LOOP = dead

    async def main():
        logging.getLogger("agent").error("llm timeout")
        await asyncio.sleep(0.05)

    asyncio.run(main())

    assert len(sent) == 1
    assert R._LOOP is not dead


def test_report_from_a_thread_with_no_loop_is_dropped_quietly(monkeypatch):
    """No loop anywhere = nothing to schedule on. Must not raise."""
    sent = _arm(monkeypatch)
    logging.getLogger("agent").error("boom outside any loop")
    assert sent == []


# ── bug 2: loopback TLS ──────────────────────────────────────────────────────

@pytest.mark.parametrize("value,expected", [
    ("0", False), ("false", False), ("no", False), ("off", False), ("OFF", False),
    ("1", True), ("true", True), ("", True),
])
def test_tls_verify_env_parsing(monkeypatch, value, expected):
    _arm(monkeypatch, LOS_REPORT_TLS_VERIFY=value)
    assert R._CONFIG["tls_verify"] is expected


def test_tls_verify_defaults_to_on(monkeypatch):
    monkeypatch.delenv("LOS_REPORT_TLS_VERIFY", raising=False)
    _arm(monkeypatch)
    assert R._CONFIG["tls_verify"] is True


# ── the guards that keep observability from becoming a self-DOS ──────────────

def test_missing_env_leaves_the_reporter_disarmed(monkeypatch):
    monkeypatch.delenv("LOS_BACKEND_URL", raising=False)
    monkeypatch.delenv("LOS_INTERNAL_HMAC_SECRET", raising=False)
    assert R.install() is False
    assert R._INSTALLED is False


def test_below_threshold_records_are_not_reported(monkeypatch):
    sent = _arm(monkeypatch)

    async def main():
        logging.getLogger("agent").info("greeting sent")
        logging.getLogger("agent").warning("stt reconnecting")
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert sent == [], "only ERROR+ should reach the webhook at the default level"


def test_duplicate_message_is_suppressed_within_the_dedup_window(monkeypatch):
    sent = _arm(monkeypatch)

    async def main():
        for _ in range(5):
            logging.getLogger("agent").error("deepgram websocket closed")
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert len(sent) == 1, "a reconnect loop must not flood the backend"


def test_burst_of_distinct_errors_is_rate_capped(monkeypatch):
    sent = _arm(monkeypatch, LOS_REPORT_MAX_QPS="3")

    async def main():
        for i in range(10):
            logging.getLogger("agent").error("distinct failure %d", i)
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert len(sent) == 3, f"max_qps=3 should cap the burst, got {len(sent)}"


def test_exception_info_is_forwarded_with_a_traceback(monkeypatch):
    sent = _arm(monkeypatch)

    async def main():
        try:
            raise ValueError("trunk 4 unreachable")
        except ValueError:
            logging.getLogger("agent").exception("dial failed")
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert len(sent) == 1
    assert sent[0]["exc_type"] == "ValueError"
    assert "trunk 4 unreachable" in sent[0]["trace"]


def test_reporter_never_reports_its_own_logs(monkeypatch):
    """A feedback loop here would take the backend down with the agent."""
    sent = _arm(monkeypatch)

    async def main():
        logging.getLogger("los-error-reporter").error("error report failed")
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert sent == []

# -- deploy noise must not become a "Calling system error" -------------------

@pytest.mark.parametrize("message", [
    "process exited with non-zero exit code 255",
    "draining worker",
    "shutting down worker",
    "worker closed",
    "Process exited with non-zero exit code 1",  # case-insensitive
])
def test_worker_lifecycle_lines_are_not_reported(monkeypatch, message):
    """LiveKit logs these at ERROR on every deploy and restart. Reporting them
    turned each restart into a super-admin notification. The gpu-error-tailer
    already skips the same phrases."""
    sent = _arm(monkeypatch)

    async def main():
        logging.getLogger("livekit.agents").error(message)
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert sent == [], f"reported deploy noise: {message!r}"


def test_a_real_failure_is_still_reported(monkeypatch):
    """The noise filter must be a substring match, not a blanket mute."""
    sent = _arm(monkeypatch)

    async def main():
        logging.getLogger("livekit.agents").error("SIP INVITE failed: 503 from trunk")
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert len(sent) == 1
