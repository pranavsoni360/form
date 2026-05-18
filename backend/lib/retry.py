"""
Exponential-backoff retry decorator for async functions.

Why:
    External APIs fail transiently — network blips, rate limits, brief
    provider outages. Most of these recover within seconds. A retry with
    jittered exponential backoff turns "noisy errors" into "imperceptible
    delays" without burying real failures (after max_attempts, we still
    raise so the caller sees what happened).

Usage:
    @retry(max_attempts=3, base_delay=0.5, max_delay=10,
           retry_on=(httpx.HTTPError, asyncio.TimeoutError))
    async def call_external(...):
        ...

Compose with circuit breaker (retry inside, breaker outside) so a sustained
outage trips the breaker rather than burning retries forever:

    @circuit(name="livekit")
    @retry(max_attempts=3)
    async def lk_call(...): ...
"""

from __future__ import annotations

import asyncio
import functools
import logging
import random
from typing import Awaitable, Callable, Type, TypeVar


logger = logging.getLogger(__name__)

T = TypeVar("T")


def retry(
    *,
    max_attempts: int = 3,
    base_delay: float = 0.5,
    max_delay: float = 10.0,
    jitter: bool = True,
    retry_on: tuple[Type[BaseException], ...] = (Exception,),
):
    """Decorate an async function with exponential-backoff retry.

    Args:
        max_attempts: total tries (including the first). max_attempts=1 means
                      no retry. Negative values are clamped to 1.
        base_delay: seconds before the 2nd attempt. Doubles each attempt.
        max_delay: cap on per-attempt sleep (after jitter applied).
        jitter: add random 0..base_delay seconds to spread thundering herds.
        retry_on: tuple of exception classes that should trigger a retry.
                  Everything else propagates immediately.

    Raises the last exception if all attempts fail.
    """
    if max_attempts < 1:
        max_attempts = 1

    def decorator(fn: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs) -> T:
            last_exc: BaseException | None = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return await fn(*args, **kwargs)
                except retry_on as e:
                    last_exc = e
                    if attempt >= max_attempts:
                        logger.warning(
                            "%s exhausted %d attempts: %s",
                            fn.__qualname__, max_attempts, e,
                        )
                        raise
                    # Compute next sleep: base * 2^(attempt-1), capped at max
                    delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
                    if jitter:
                        delay += random.uniform(0, base_delay)
                    logger.info(
                        "%s attempt %d/%d failed (%s); retrying in %.2fs",
                        fn.__qualname__, attempt, max_attempts,
                        type(e).__name__, delay,
                    )
                    await asyncio.sleep(delay)
            # Unreachable, but appease type checker
            assert last_exc is not None
            raise last_exc

        return wrapper

    return decorator
