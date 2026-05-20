"""
In-process event bus — pub/sub over asyncio.Queue.

One process = one EventBus instance (the module-level `event_bus` singleton).
Publishers (dispatcher, job worker, error handler) call `publish(topic, event)`.
Subscribers (SSE connections) call `subscribe(topics)` to get an async iterator
that yields every event published to those topics, plus periodic heartbeats
emitted by the SSE route itself.

Topics in use:
    "calls"    — voice-call state changes (initiated, answered, completed, failed)
    "phones"   — phone-pool acquire/release/cooldown updates
    "workers"  — JobWorker heartbeats + queue_depth snapshots
    "errors"   — unhandled exceptions from the FastAPI global handler
    "batches"  — batch-level aggregate progress (completed/active/failed counts)

Bounded queue (1000 events) + drop-oldest is intentional:
    - Bursty events (e.g. 50-call concurrent dispatch) can outpace a slow
      EventSource client by a few hundred events. We never want to block
      the publisher.
    - When we drop, the subscriber gets a synthetic {"type":"lag","dropped":N}
      event so its reducer can decide to hard-refresh from REST instead of
      trying to reconcile.

Multi-process note: this is per-process. If we ever scale to 2+ uvicorn
workers, we add Redis pub/sub here (with the same `EventBus` interface) and
no caller changes. Today: deferred per the M2 locked plan.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import AsyncIterator, Any

logger = logging.getLogger(__name__)

VALID_TOPICS = frozenset({"calls", "phones", "workers", "errors", "batches"})
QUEUE_SIZE = 1000


class _Subscription:
    """One subscriber's queue + topic filter + lag counter."""

    __slots__ = ("topics", "queue", "dropped", "created_at")

    def __init__(self, topics: frozenset[str]) -> None:
        self.topics = topics
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self.dropped = 0
        self.created_at = time.time()


class EventBus:
    """Module-level singleton. Thread-safe-by-virtue-of-asyncio (single-loop)."""

    def __init__(self) -> None:
        self._subscriptions: list[_Subscription] = []
        # Light protection for concurrent subscribe/unsubscribe (still
        # single-threaded under asyncio, but iteration during mutation is
        # what we want to guard).
        self._lock = asyncio.Lock()

    def publish(self, topic: str, event: dict[str, Any]) -> None:
        """Fire-and-forget. Never blocks. Drops oldest on per-subscriber overflow.

        Called from anywhere in async code (and via run_coroutine_threadsafe
        if ever called from a thread — but stick to async land for now).
        """
        if topic not in VALID_TOPICS:
            logger.warning("publish() to unknown topic=%r — dropping", topic)
            return

        # Normalize: ensure every event carries its topic + server timestamp
        payload = {**event, "topic": topic, "ts": time.time()}

        # Iterate a snapshot — subscribers added mid-publish just miss this one.
        for sub in list(self._subscriptions):
            if topic not in sub.topics:
                continue
            try:
                sub.queue.put_nowait(payload)
            except asyncio.QueueFull:
                # Drop oldest, push new, account for lag.
                try:
                    sub.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass  # racing with the consumer — fine
                sub.dropped += 1
                try:
                    sub.queue.put_nowait(payload)
                except asyncio.QueueFull:
                    # Still full somehow — give up on this event for this sub.
                    pass

    async def subscribe(self, topics: frozenset[str]) -> AsyncIterator[dict[str, Any]]:
        """Async generator. Caller wraps in `async for`. Cancellation-safe:
        the subscription is removed when the generator is closed."""
        # Reject unknown topics up front so misconfig surfaces loudly.
        unknown = topics - VALID_TOPICS
        if unknown:
            raise ValueError(f"unknown topics: {sorted(unknown)}")

        sub = _Subscription(topics)
        async with self._lock:
            self._subscriptions.append(sub)
        logger.info("event_bus subscribed topics=%s (n=%d)", sorted(topics), len(self._subscriptions))

        try:
            while True:
                event = await sub.queue.get()
                # If we've dropped since last yield, prepend a lag marker.
                if sub.dropped:
                    dropped = sub.dropped
                    sub.dropped = 0
                    yield {"type": "lag", "dropped": dropped, "topic": "_meta", "ts": time.time()}
                yield event
        finally:
            async with self._lock:
                try:
                    self._subscriptions.remove(sub)
                except ValueError:
                    pass
            logger.info("event_bus unsubscribed (n=%d)", len(self._subscriptions))

    def subscriber_count(self) -> int:
        return len(self._subscriptions)


# Module-level singleton. Import as `from lib.event_bus import event_bus`.
event_bus = EventBus()
