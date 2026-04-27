"""Shared in-process pub/sub for batch SSE updates.

Lives in its own module so that `import batch_pubsub` always resolves to the
same singleton, even when `main.py` is executed as `__main__` (which causes
`from main import ...` from other modules to load a SECOND copy of main.py
under the name `main` — with its own module-level globals).

The SSE endpoint (in main.py) subscribes; dispatch_call (in agent_routes.py)
publishes. Both import from here.
"""
from __future__ import annotations

import asyncio
from typing import Dict, List

# batch_id (the string form, e.g. "batch_xxxxxxxx_1234567890") -> list of queues
_subscribers: Dict[str, List[asyncio.Queue]] = {}


def subscribe(batch_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=512)
    _subscribers.setdefault(batch_id, []).append(q)
    return q


def unsubscribe(batch_id: str, q: asyncio.Queue) -> None:
    queues = _subscribers.get(batch_id, [])
    if q in queues:
        queues.remove(q)
    if not queues:
        _subscribers.pop(batch_id, None)


async def publish(batch_id: str, payload: dict) -> None:
    queues = _subscribers.get(batch_id, [])
    for q in list(queues):
        try:
            q.put_nowait(payload)
        except Exception:
            # If a queue is full or closed, drop the event rather than blocking
            # the dispatcher. SSE is best-effort.
            pass


def subscriber_count(batch_id: str) -> int:
    """For diagnostics / tests only."""
    return len(_subscribers.get(batch_id, []))
