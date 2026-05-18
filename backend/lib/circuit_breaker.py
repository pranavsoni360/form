"""
Async circuit breaker decorator.

Why:
    When an external dependency (LiveKit, Gemini, AiSensy) is degraded,
    retrying every call burns time and money for no benefit — the system
    just queues failures faster. A circuit breaker SHORT-CIRCUITS calls
    after a failure threshold is crossed, then probes occasionally to see
    if the service is healthy again.

State machine:
    CLOSED       → normal operation. Failures counted.
    OPEN         → entered when failure_threshold consecutive failures hit.
                   Calls fail fast with CircuitOpenError without invoking fn.
                   After recovery_timeout, transitions to HALF_OPEN.
    HALF_OPEN    → exactly ONE call is allowed through. If it succeeds, the
                   breaker resets to CLOSED. If it fails, back to OPEN with
                   a fresh recovery_timeout.

Usage:
    @circuit(name="livekit", failure_threshold=5, recovery_timeout=30)
    async def lk_call(...):
        ...

Inspecting state at runtime (e.g. for /readyz):
    from lib.circuit_breaker import get_breaker
    cb = get_breaker("livekit")
    cb.state  # "closed" | "open" | "half_open"

The breaker fires a Discord alert (rate-limited per-name) on every state
transition to OPEN, so ops sees outages without manually grepping logs.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import time
from enum import Enum
from typing import Awaitable, Callable, TypeVar


logger = logging.getLogger(__name__)

T = TypeVar("T")


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitOpenError(RuntimeError):
    """Raised when a call is short-circuited because the breaker is OPEN."""

    def __init__(self, name: str, opened_for: float):
        super().__init__(f"Circuit {name!r} is OPEN (opened {opened_for:.1f}s ago)")
        self.circuit_name = name
        self.opened_for = opened_for


class CircuitBreaker:
    """Async circuit breaker. One instance per logical dependency."""

    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
    ) -> None:
        self.name = name
        self.failure_threshold = max(1, failure_threshold)
        self.recovery_timeout = max(1.0, recovery_timeout)

        self._state: CircuitState = CircuitState.CLOSED
        self._consecutive_failures = 0
        self._opened_at: float | None = None
        self._lock = asyncio.Lock()

    @property
    def state(self) -> str:
        """Current state as string. Computed (transitions OPEN→HALF_OPEN
        when recovery_timeout has elapsed)."""
        if self._state == CircuitState.OPEN and self._opened_at is not None:
            if time.monotonic() - self._opened_at >= self.recovery_timeout:
                return CircuitState.HALF_OPEN.value
        return self._state.value

    @property
    def is_healthy(self) -> bool:
        """Cheap read for /readyz — True if CLOSED, False otherwise."""
        return self._state == CircuitState.CLOSED

    async def call(self, fn: Callable[..., Awaitable[T]], *args, **kwargs) -> T:
        """Invoke fn through the breaker. Raises CircuitOpenError if OPEN."""
        # Check state without holding the lock for the fn() duration
        async with self._lock:
            if self._state == CircuitState.OPEN:
                assert self._opened_at is not None
                elapsed = time.monotonic() - self._opened_at
                if elapsed < self.recovery_timeout:
                    raise CircuitOpenError(self.name, elapsed)
                # Recovery timeout elapsed → allow ONE probe
                self._state = CircuitState.HALF_OPEN
                logger.info("Circuit %r transitioning OPEN -> HALF_OPEN", self.name)

        try:
            result = await fn(*args, **kwargs)
        except Exception:
            await self._on_failure()
            raise
        else:
            await self._on_success()
            return result

    async def _on_success(self) -> None:
        async with self._lock:
            if self._state in (CircuitState.HALF_OPEN, CircuitState.OPEN):
                logger.info("Circuit %r recovered → CLOSED", self.name)
                self._notify_state_change("closed")
            self._state = CircuitState.CLOSED
            self._consecutive_failures = 0
            self._opened_at = None

    async def _on_failure(self) -> None:
        async with self._lock:
            self._consecutive_failures += 1
            if self._state == CircuitState.HALF_OPEN:
                # Probe failed — re-open
                self._state = CircuitState.OPEN
                self._opened_at = time.monotonic()
                logger.warning("Circuit %r probe failed → OPEN", self.name)
                self._notify_state_change("open")
                return
            if (
                self._state == CircuitState.CLOSED
                and self._consecutive_failures >= self.failure_threshold
            ):
                self._state = CircuitState.OPEN
                self._opened_at = time.monotonic()
                logger.error(
                    "Circuit %r tripped OPEN after %d consecutive failures",
                    self.name, self._consecutive_failures,
                )
                self._notify_state_change("open")

    def _notify_state_change(self, new_state: str) -> None:
        """Fire a Discord alert on state transition. Never raises."""
        try:
            # Late import so this module has no hard dep on the notifier
            from lib.notifier import notify  # type: ignore
            severity = "critical" if new_state == "open" else "info"
            asyncio.create_task(notify(
                severity=severity,
                title=f"Circuit breaker → {new_state.upper()}: {self.name}",
                body=(
                    f"Failure threshold ({self.failure_threshold}) reached. "
                    f"Calls to {self.name} are short-circuited for "
                    f"{self.recovery_timeout:.0f}s before probing recovery."
                ) if new_state == "open" else (
                    f"{self.name} is healthy again after a probe succeeded."
                ),
                dedupe_key=f"circuit:{self.name}",
            ))
        except Exception:
            # Alerting must never break the call path
            logger.exception("Discord notify failed for circuit %r (non-fatal)", self.name)


# ── Registry: one breaker per name, lazily created ──────────────────────────

_registry: dict[str, CircuitBreaker] = {}
_registry_lock = asyncio.Lock()


def get_breaker(
    name: str,
    *,
    failure_threshold: int = 5,
    recovery_timeout: float = 30.0,
) -> CircuitBreaker:
    """Get or create a breaker by name. First call wins on parameters."""
    cb = _registry.get(name)
    if cb is None:
        cb = CircuitBreaker(name, failure_threshold, recovery_timeout)
        _registry[name] = cb
    return cb


def all_breakers() -> dict[str, str]:
    """Return {name: state} for every breaker. Used by /readyz."""
    return {name: cb.state for name, cb in _registry.items()}


def circuit(
    *,
    name: str,
    failure_threshold: int = 5,
    recovery_timeout: float = 30.0,
):
    """Decorator wrapping an async function with a named circuit breaker."""
    cb = get_breaker(name, failure_threshold=failure_threshold,
                     recovery_timeout=recovery_timeout)

    def decorator(fn: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs) -> T:
            return await cb.call(fn, *args, **kwargs)
        return wrapper

    return decorator


async def protect(
    name: str,
    fn: Callable[..., Awaitable[T]],
    *args,
    timeout_s: float | None = None,
    failure_threshold: int = 5,
    recovery_timeout: float = 30.0,
    **kwargs,
) -> T:
    """Run an async fn through a named circuit breaker, optionally bounded
    by a timeout. The common case in call sites — easier to read than the
    decorator when you only want to protect specific call paths.

    Timeout failures count as breaker failures (so a slow downstream trips
    the breaker after `failure_threshold` slow calls). Using
    `asyncio.timeout(...)` so cancellation propagates cleanly into the
    underlying SDK.

    Usage:
        await protect("livekit",     lk.room.create_room,         req,  timeout_s=15)
        await protect("livekit_sip", lk.sip.create_sip_participant, req, timeout_s=30)
        await protect("gemini",      asyncio.to_thread,           f,    timeout_s=45)
    """
    cb = get_breaker(
        name,
        failure_threshold=failure_threshold,
        recovery_timeout=recovery_timeout,
    )
    if timeout_s is None:
        return await cb.call(fn, *args, **kwargs)

    async def _timed():
        async with asyncio.timeout(timeout_s):
            return await fn(*args, **kwargs)

    return await cb.call(_timed)
