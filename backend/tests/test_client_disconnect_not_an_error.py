"""A client that hangs up is not a server fault.

The global exception handler treated every unhandled exception as a backend
error: a full `logger.exception` traceback, a row in `system_errors` via the
event bus, and — since the notification work landed — a "Loan system error:
ClientDisconnect" alert in the super-admin bell. Starlette raises
`ClientDisconnect` whenever a browser navigates away mid-request or an
EventSource is closed, so the alert fired on ordinary user behaviour and buried
real incidents.

Client-gone exceptions are matched by class NAME because the concrete types live
in starlette and uvicorn internals that move between versions; the two builtin
socket errors are matched by isinstance as well.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import main as main_mod  # noqa: E402
from lib import event_bus as bus_mod  # noqa: E402


class _Req:
    class _URL:
        path = "/api/agent/calls"

    url = _URL()
    method = "GET"


@pytest.fixture
def published(monkeypatch):
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(bus_mod.event_bus, "publish",
                        lambda topic, event: events.append((topic, event)))
    return events


def _handle(exc):
    return asyncio.run(main_mod._global_exception_handler(_Req(), exc))


# Starlette / uvicorn do not export a stable common base, so the handler matches
# on the class name. These stand in for the real ones.
class ClientDisconnect(Exception):
    pass


class ClientDisconnected(OSError):
    pass


class EndOfStream(Exception):
    pass


@pytest.mark.parametrize("exc", [
    ClientDisconnect(),
    ClientDisconnected(),
    EndOfStream(),
    ConnectionResetError("peer reset"),
    BrokenPipeError("pipe gone"),
])
def test_client_gone_does_not_publish_an_error_event(published, exc):
    resp = _handle(exc)
    assert published == [], f"{type(exc).__name__} was reported as a system error"
    assert resp.status_code == 499


def test_a_real_exception_is_still_reported(published):
    resp = _handle(ValueError("genuinely broken"))
    assert resp.status_code == 500
    assert len(published) == 1
    topic, event = published[0]
    assert topic == "errors"
    assert event["source"] == "backend"
    assert event["exc_type"] == "ValueError"
    assert event["route"] == "/api/agent/calls"


def test_the_response_body_never_leaks_the_exception(published):
    """A 500 body carries a correlation id and nothing else."""
    resp = _handle(ValueError("secret connection string in here"))
    body = bytes(resp.body).decode()
    assert "secret connection string" not in body
    assert "correlation_id" in body


def test_a_publish_failure_cannot_break_the_error_path(monkeypatch):
    def _boom(topic, event):
        raise RuntimeError("bus is down")

    monkeypatch.setattr(bus_mod.event_bus, "publish", _boom)
    resp = _handle(ValueError("x"))
    assert resp.status_code == 500  # still answered the caller


def test_the_matched_names_cover_what_starlette_and_uvicorn_raise():
    """Guard the name list itself — a rename upstream would silently re-open this."""
    for name in ("ClientDisconnect", "ClientDisconnected",
                 "ConnectionResetError", "BrokenPipeError"):
        assert name in main_mod._CLIENT_GONE
