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
from collections import deque
from typing import AsyncIterator, Any, Deque

logger = logging.getLogger(__name__)

VALID_TOPICS = frozenset({"calls", "phones", "workers", "errors", "batches"})
QUEUE_SIZE = 1000

# Per-topic ring-buffer capacity. Events on these topics get held in memory
# and replayed to new subscribers on connect — so a page refresh doesn't wipe
# the user's view.
#
# `errors` is the only topic we replay: low-frequency, high-value events.
# Other topics are HIGH-frequency live state (workers heartbeat every 2s,
# calls fire many per dispatch) and replaying them would just spam reducers
# with stale snapshots — better to refetch from REST on mount.
#
# Capacity of 0 = no buffering. Default for unlisted topics also 0.
HISTORY_CAPACITY: dict[str, int] = {
    "errors": 500,
    "calls": 0,
    "phones": 0,
    "workers": 0,
    "batches": 0,
}


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
        # Per-topic ring buffer for replay-on-subscribe. Sized via
        # HISTORY_CAPACITY above. Topics with capacity 0 still get a deque
        # of maxlen=1 (skipped at publish time) to keep `_history[topic]`
        # always indexable — cleaner than `if topic in self._history`.
        self._history: dict[str, Deque[dict[str, Any]]] = {
            topic: deque(maxlen=max(1, HISTORY_CAPACITY.get(topic, 0)))
            for topic in VALID_TOPICS
        }

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

        # Persist errors to system_errors so /ops/errors survives backend
        # restarts. Fire-and-forget — never blocks the publisher even if the
        # DB is slow or unavailable (we still fan out via SSE either way).
        # Only the "errors" topic gets persisted; other topics are high-
        # frequency live state (workers heartbeat every 2s, calls fire many
        # per dispatch) that wouldn't survive any reasonable retention policy.
        if topic == "errors":
            self._schedule_db_persist(payload)

        # Buffer for replay on subscribe (only if this topic has capacity).
        # Stored BEFORE fan-out so a brand-new subscriber that connects mid-
        # publish would see this event in its replay window.
        if HISTORY_CAPACITY.get(topic, 0) > 0:
            self._history[topic].append(payload)

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
            # ── Replay phase: drain any buffered history for subscribed topics
            # in chronological order so reducers see them in correct sequence.
            # Tag each replayed event with `_replay=True` so client code can
            # distinguish backfill from real-time (e.g. skip animation, mark
            # rows as "historical"). Page reducers that just append to a list
            # need no change — `_replay` is purely informational.
            replay_events: list[dict[str, Any]] = []
            for topic in topics:
                if HISTORY_CAPACITY.get(topic, 0) > 0:
                    replay_events.extend(self._history[topic])
            replay_events.sort(key=lambda e: e.get("ts", 0.0))
            if replay_events:
                logger.info(
                    "event_bus replaying %d historical events on subscribe topics=%s",
                    len(replay_events), sorted(topics),
                )
                for old_evt in replay_events:
                    yield {**old_evt, "_replay": True}

            # ── Live phase: standard loop.
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

    # ── DB persistence for errors topic ─────────────────────────────────
    # Why a wrapper: publish() is sync (it's called from inside Sentry
    # hooks, FastAPI exception handlers, even non-async code paths). The DB
    # write must happen on the event loop. We schedule it as a task and
    # absorb every failure — the in-memory broadcast already happened.

    def _schedule_db_persist(self, payload: dict[str, Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop (e.g. called from sync test code) — skip.
            return
        loop.create_task(self._persist_error(payload))

    async def _persist_error(self, payload: dict[str, Any]) -> None:
        import json as _json
        try:
            # Lazy import to avoid a circular import at module load
            # (main imports lib.event_bus before db_pool exists).
            import main as _main
            pool = getattr(_main, "db_pool", None)
            if pool is None:
                return  # backend still booting; we accept the drop

            source = str(payload.get("source", "backend"))[:20]
            level = str(payload.get("level", "error"))
            if level not in ("error", "warning"):
                level = "error"
            exc_type = str(payload.get("exc_type", "Unknown"))[:200]
            message = str(payload.get("message", ""))[:2000]
            cid = payload.get("correlation_id")
            cid = str(cid)[:100] if cid and cid != "-" else None
            route = payload.get("route")
            route = str(route)[:300] if route is not None else None
            method = payload.get("method")
            method = str(method)[:10] if method is not None else None
            trace = payload.get("trace")
            trace = str(trace)[:8000] if trace is not None else None
            metadata = payload.get("metadata")
            metadata_json = _json.dumps(metadata, default=str)[:8000] if metadata is not None else None
            ts = float(payload.get("ts", time.time()))

            # ON CONFLICT (correlation_id, ts) DO NOTHING — defeats double-
            # publish from publisher retries. The partial unique idx in the
            # migration makes this O(1).
            await pool.execute(
                """
                INSERT INTO system_errors
                  (source, level, exc_type, message, correlation_id, route, method, trace, metadata, ts)
                VALUES
                  ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
                ON CONFLICT (correlation_id, ts) WHERE correlation_id IS NOT NULL DO NOTHING
                """,
                source, level, exc_type, message, cid, route, method, trace, metadata_json, ts,
            )

            # Surface real errors as a super-admin notification (security_events).
            # Throttled: skip if an unacknowledged alert for this same source+type
            # already exists in the last hour, so a recurring error can't flood the
            # bell. Warnings are not turned into notifications (too noisy).
            if level == "error":
                try:
                    dup = await pool.fetchval(
                        "SELECT 1 FROM security_events WHERE event_type = 'system_error' "
                        "AND acknowledged = false AND metadata->>'source' = $1 "
                        "AND metadata->>'exc_type' = $2 AND created_at > NOW() - interval '60 minutes' LIMIT 1",
                        source, exc_type,
                    )
                    if not dup:
                        area = "Calling system" if source in ("agent", "livekit", "sip") else (
                            "Database" if source == "postgres" else "Loan system")
                        severity = "critical" if source == "postgres" else "high"
                        await pool.execute(
                            """INSERT INTO security_events
                                   (event_type, severity, actor_type, title, description, metadata)
                               VALUES ('system_error', $1, 'system', $2, $3, $4::jsonb)""",
                            severity,
                            f"{area} error: {exc_type}",
                            message[:500],
                            _json.dumps({"source": source, "exc_type": exc_type,
                                         "route": route, "method": method, "correlation_id": cid}),
                        )
                except Exception:
                    logger.exception("event_bus: system_error notification failed")
        except Exception:
            # Never let DB failure break the in-memory broadcast.
            logger.exception("event_bus._persist_error failed (event dropped from DB)")


# Module-level singleton. Import as `from lib.event_bus import event_bus`.
event_bus = EventBus()
