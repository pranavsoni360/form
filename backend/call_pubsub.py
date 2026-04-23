"""Shared in-process pub/sub for live-transcript SSE updates.

Lives in its own module so that `import call_pubsub` always resolves to
the same singleton, even when `main.py` is executed as `__main__` (which
causes `from main import ...` from other modules to load a SECOND copy
of main.py under the name `main` — with its own module-level globals).

The SSE endpoint (in main.py) subscribes; transcript webhooks
(in agent_routes.py) publish. Both import from here.
"""
from __future__ import annotations

import asyncio
from typing import Dict, List, Set

# call_id (UUID string) -> list of per-subscriber queues.
_subscribers: Dict[str, List[asyncio.Queue]] = {}
# Set of call_ids that have sent their terminal transcript burst, so
# long-lived SSE streams know when to emit `done` and close.
_ended: Set[str] = set()


def subscribe(call_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    _subscribers.setdefault(call_id, []).append(q)
    return q


def unsubscribe(call_id: str, q: asyncio.Queue) -> None:
    queues = _subscribers.get(call_id, [])
    if q in queues:
        queues.remove(q)
    if not queues:
        _subscribers.pop(call_id, None)


async def publish(call_id: str, payload: dict) -> None:
    queues = _subscribers.get(call_id, [])
    for q in list(queues):
        try:
            q.put_nowait(payload)
        except Exception:
            # If a queue is full or closed, drop the event rather than
            # blocking the publisher. SSE is best-effort.
            pass


def mark_ended(call_id: str) -> None:
    _ended.add(call_id)


def is_ended(call_id: str) -> bool:
    return call_id in _ended


def subscriber_count(call_id: str) -> int:
    """For diagnostics / tests only."""
    return len(_subscribers.get(call_id, []))
