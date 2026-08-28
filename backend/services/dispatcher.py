"""
Concurrent batch dispatcher (M4-lite).

Why:
    The previous dispatcher in agent/batch.py was a sequential for-loop with
    `await asyncio.sleep(10)` between calls. Best-case throughput ~6 calls/min;
    realistic (with 60s wait_for_completion polling) ~1 call/min. That caps
    daily volume around 100. To hit 500+/day comfortably, we need parallel
    dispatch.

Design (kept SalkAI-simple):
    - asyncio.Semaphore bounds peak concurrency (env DISPATCHER_CONCURRENCY,
      default 5). This is the only knob you need to tune for higher volume.
    - Per-call task: acquire a SIP trunk, place the call via LiveKit, poll
      until completion, release the trunk. All existing behavior preserved
      (room creation, agent dispatch order, retry counter, DEMO_MODE,
      Union-Bank vs Pusad agent routing).
    - Trunk selection prefers the new `phone_numbers` table (DB-driven with
      cooldown). If the table is empty, falls back to the legacy single
      SIP_TRUNK_ID env var so existing deployments keep working without
      seeding phone_numbers first.
    - Working-hours + emergency-stop checks happen BEFORE each task picks up
      its work, not just at batch start, so a 60-minute batch respects the
      window closing mid-run.

Lifecycle:
    DispatcherManager (singleton on _active dict) tracks running batches.
    process_batch_run() in agent/batch.py constructs a Dispatcher and awaits
    its run(). agent_shutdown() calls stop_all() to signal in-flight tasks.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
import uuid
from typing import Optional

from livekit import api

from lib.circuit_breaker import protect, CircuitOpenError
from lib.event_bus import event_bus


logger = logging.getLogger(__name__)


def _emit(topic: str, event: dict) -> None:
    """Fire-and-forget pub. Never raises — keeps the dispatcher hot path
    safe even if the event bus or SSE listeners misbehave."""
    try:
        event_bus.publish(topic, event)
    except Exception:
        pass

# How many calls to launch in parallel. Below the dispatcher's actual ceiling
# (which is min(this, total phone pool capacity)). For 500/day on a single
# trunk, 5 is comfortable; bump to 10 if you add a second trunk.
DEFAULT_CONCURRENCY = int(os.getenv("DISPATCHER_CONCURRENCY", "5"))

# Hard cap on calls processed per batch invocation. Matches the previous
# behavior in agent/batch.py:197 — keeps each cron tick bounded.
MAX_CALLS_PER_RUN = int(os.getenv("DISPATCHER_MAX_CALLS_PER_RUN", "50"))

# When every eligible trunk is busy-at-capacity (all channels in use) we have
# no cooldown timestamp telling us when one frees, so we poll on this interval.
# Short enough to grab a freed channel promptly, long enough not to hammer DB.
TRUNK_BUSY_POLL_INTERVAL_S = float(os.getenv("DISPATCHER_BUSY_POLL_S", "5"))

# Upper bound on how long a single call waits for a trunk to free before giving
# up. Must exceed the worst realistic "call in progress (≤ wait_for_completion
# timeout, 600s) + post-call cooldown (≤ 300s)" so an overflow call queued
# behind a full pool is not failed prematurely.
TRUNK_WAIT_DEADLINE_S = float(os.getenv("DISPATCHER_TRUNK_WAIT_S", "900"))


# ============================================================================
# Phone formatting
# ============================================================================

def _to_e164(phone: str) -> str:
    """Best-effort E.164 for outbound dialing. Keeps every Indian format
    behaving exactly as before; the ONLY new behavior is that a bare number
    already carrying a non-91 country code is dialed as +<digits> instead of
    being mangled into +91<last10>.
      • already '+'             -> as-is
      • 10 digits               -> +91<d>            (Indian mobile)
      • 11 digits, leading 0    -> +91<last10>       (Indian, trunk-0)
      • 12 digits, starts '91'  -> +<d>              (Indian w/ country code)
      • any other digits        -> +<d>              (already international)
    """
    p = (phone or "").strip()
    if p.startswith("+"):
        return p
    d = "".join(ch for ch in p if ch.isdigit())
    if not d:
        return p
    if len(d) == 10:
        return f"+91{d}"
    if len(d) == 11 and d.startswith("0"):
        return f"+91{d[-10:]}"
    if len(d) == 12 and d.startswith("91"):
        return f"+{d}"
    # Un-normalizable (e.g. a 13-15 digit blob from a corrupted Excel cell). Do NOT
    # dial a "+<garbage>" number — return None so the caller marks it Invalid Phone.
    return None


# ============================================================================
# Trunk acquisition helpers
# ============================================================================

async def _acquire_trunk_from_db(
    db_pool,
    preferred_phone_id: Optional[str] = None,
) -> Optional[dict]:
    """Try to claim the least-loaded available trunk from phone_numbers.

    Returns a dict with id/trunk_id/cooldown bounds, or None if no row is
    eligible. Uses FOR UPDATE SKIP LOCKED so two parallel callers never race
    on the same row.

    When `preferred_phone_id` is provided (operator picked a specific number
    via the /ops/batch "From number" dropdown), the query restricts to that
    one row — still respecting status / cooldown / capacity. If that row is
    not eligible the function returns None (caller decides whether to fall
    back to env trunk or fail the call).

    Default selection order (no preference):
      1. status='active'
      2. cooldown_until passed (or NULL)
      3. active_calls < pool.capacity (room to take another call)
      4. Sort by least-loaded then least-used then id (deterministic tiebreak)
    """
    async with db_pool.acquire() as conn:
        async with conn.transaction():
            if preferred_phone_id:
                # Strict — operator picked this phone, don't fall back to others
                row = await conn.fetchrow(
                    """SELECT pn.id, pn.phone_number, pn.livekit_trunk_id,
                              pp.cooldown_seconds_min, pp.cooldown_seconds_max
                         FROM phone_numbers pn
                         JOIN phone_pools pp ON pp.id = pn.pool_id
                        WHERE pn.id = $1
                          AND pn.status = 'active'
                          AND (pn.cooldown_until IS NULL OR pn.cooldown_until <= NOW())
                          AND pn.active_calls < pp.capacity
                        FOR UPDATE SKIP LOCKED
                        LIMIT 1""",
                    uuid.UUID(preferred_phone_id),
                )
            else:
                # Automatic least-loaded pick. auto_dial_eligible gates this
                # path only — a number flagged FALSE (e.g. the Twilio US
                # caller-ID) is never auto-dialled to Indian customers, but
                # stays selectable via the operator's "From number" dropdown
                # (the preferred_phone_id branch above ignores this flag).
                row = await conn.fetchrow(
                    """SELECT pn.id, pn.phone_number, pn.livekit_trunk_id,
                              pp.cooldown_seconds_min, pp.cooldown_seconds_max
                         FROM phone_numbers pn
                         JOIN phone_pools pp ON pp.id = pn.pool_id
                        WHERE pn.status = 'active'
                          AND pn.auto_dial_eligible = TRUE
                          AND (pn.cooldown_until IS NULL OR pn.cooldown_until <= NOW())
                          AND pn.active_calls < pp.capacity
                        ORDER BY pn.active_calls ASC, pn.total_calls ASC, pn.id
                        FOR UPDATE SKIP LOCKED
                        LIMIT 1"""
                )
            if row is None:
                return None
            await conn.execute(
                """UPDATE phone_numbers
                      SET active_calls = active_calls + 1,
                          total_calls  = total_calls  + 1,
                          updated_at   = NOW()
                    WHERE id = $1""",
                row["id"],
            )
    phone_id = str(row["id"])
    _emit("phones", {
        "type": "pool_update",
        "action": "acquire",
        "phone_id": phone_id,
        "phone_number": row["phone_number"],
        "active_delta": 1,
    })
    return {
        "id": phone_id,
        "trunk_id": row["livekit_trunk_id"],
        "phone_number": row["phone_number"],
        "cooldown_min": int(row["cooldown_seconds_min"] or 0),
        "cooldown_max": int(row["cooldown_seconds_max"] or 0),
    }


async def _release_trunk_to_db(db_pool, trunk: dict, success: bool) -> None:
    """Decrement active_calls and (on success) set a random cooldown."""
    if trunk["id"] is None:
        return  # env fallback — nothing to release
    cooldown_extra = ""
    if success and trunk["cooldown_max"] > 0:
        # Random uniform between min and max, exclusive of upper bound.
        cooldown_extra = (
            f", cooldown_until = NOW() + "
            f"(({trunk['cooldown_min']}) + random() * "
            f"({trunk['cooldown_max']} - {trunk['cooldown_min']})) * INTERVAL '1 second'"
        )
    await db_pool.execute(
        f"""UPDATE phone_numbers
              SET active_calls = GREATEST(0, active_calls - 1),
                  updated_at = NOW()
                  {cooldown_extra}
            WHERE id = $1""",
        uuid.UUID(trunk["id"]),
    )
    _emit("phones", {
        "type": "pool_update",
        "action": "release",
        "phone_id": trunk["id"],
        "phone_number": trunk.get("phone_number"),
        "active_delta": -1,
        "cooldown_started": bool(success and trunk["cooldown_max"] > 0),
        "cooldown_seconds": trunk["cooldown_max"] if success else 0,
    })


def _env_fallback_trunk(sip_trunk_id: str) -> Optional[dict]:
    """Return an "uncounted" trunk descriptor using the legacy env var.
    Used when phone_numbers table is empty. No DB cooldown enforcement —
    concurrency is bounded entirely by the dispatcher semaphore."""
    if not sip_trunk_id:
        return None
    return {
        "id": None,  # signals env-fallback (no DB row to update)
        "trunk_id": sip_trunk_id,
        "phone_number": None,
        "cooldown_min": 0,
        "cooldown_max": 0,
    }


# ============================================================================
# Dispatcher
# ============================================================================

class Dispatcher:
    """Concurrent dispatcher for a single batch.

    Construct, then `await dispatcher.run()`. Returns aggregate counts.
    Call `dispatcher.stop()` to signal graceful stop (in-flight tasks finish,
    no new ones picked up from the queue).
    """

    def __init__(
        self,
        batch_id_uuid: str,
        call_batch_id: str,
        db_pool,
        livekit_url: str,
        livekit_api_key: str,
        livekit_api_secret: str,
        sip_trunk_id_fallback: str,
        agent_name_pusad: str,
        agent_name_union: str,
        demo_mode: bool,
        wait_for_call_completion,  # injected from agent/batch.py to avoid circular import
        is_within_calling_hours_fn,
        is_emergency_stop_active_fn,
        now_ist_fn,
        max_retries: int,
        concurrency: int = DEFAULT_CONCURRENCY,
        preferred_phone_id: Optional[str] = None,
        bank_id: Optional[str] = None,
        # Raw is_emergency_stop_active(bank_id) — used for the PER-CALL tenant
        # gate when this batch has no single bank (the shared manual-callbacks
        # batch that mixes every tenant's due callbacks). See _call_bank_stopped.
        bank_emergency_stop_fn=None,
    ) -> None:
        self.batch_id_uuid = batch_id_uuid
        self.call_batch_id = call_batch_id
        self.db_pool = db_pool
        self.livekit_url = livekit_url
        self.livekit_api_key = livekit_api_key
        self.livekit_api_secret = livekit_api_secret
        self.sip_trunk_id_fallback = sip_trunk_id_fallback
        self.agent_name_pusad = agent_name_pusad
        self.agent_name_union = agent_name_union
        self.demo_mode = demo_mode
        self.wait_for_call_completion = wait_for_call_completion
        self.is_within_calling_hours = is_within_calling_hours_fn
        self.is_emergency_stop_active = is_emergency_stop_active_fn
        self.now_ist = now_ist_fn
        self.max_retries = max_retries
        # When set, every call in this batch dials FROM this specific
        # phone_numbers row. Set via /ops/batch "From number" dropdown.
        self.preferred_phone_id = preferred_phone_id
        # Which tenant this batch belongs to. Lets an emergency stop raised by
        # one bank signal only that bank's dispatchers instead of every one.
        self.bank_id = str(bank_id) if bank_id else None
        self._bank_stop_fn = bank_emergency_stop_fn

        self.semaphore = asyncio.Semaphore(concurrency)
        self._stopped = False
        self.counts = {"completed": 0, "successful": 0, "failed": 0}
        self._counts_lock = asyncio.Lock()

    def stop(self) -> None:
        """Signal: stop picking up new work. In-flight tasks finish naturally."""
        self._stopped = True

    async def _call_bank_stopped(self, call: dict) -> bool:
        """Per-call tenant emergency-stop gate.

        `self.is_emergency_stop_active` is bound to THIS batch's bank (or, when
        the batch has no bank, only the platform flag). That is correct for a
        normal single-bank batch, but the shared manual-callbacks batch mixes
        every tenant's due callbacks under bank_id=NULL — so the batch gate alone
        would keep dialling one bank's callbacks through that bank's own
        Emergency stop. Here we consult each call's OWN bank.

        Only runs for the bank-less mixed batch (self.bank_id is None); a normal
        batch's calls all share its bank, which the batch gate already covers, so
        we skip the extra per-call read there.
        """
        if self._bank_stop_fn is None or self.bank_id is not None:
            return False
        cbid = call.get("bank_id")
        if not cbid:
            return False
        try:
            return await self._bank_stop_fn(str(cbid))
        except Exception:
            # Fail-open only for this ancillary check; the batch-level and
            # platform gates still apply.
            return False

    async def _bump(self, key: str) -> None:
        async with self._counts_lock:
            self.counts[key] = self.counts.get(key, 0) + 1

    async def run(self) -> dict:
        """Process pending calls for the batch concurrently. Returns counts."""
        # Fetch pending calls for this batch (same filter as the old loop)
        pending_rows = await self.db_pool.fetch(
            """SELECT * FROM agent_calls
                WHERE batch_id = $1
                  AND (
                    status = 'Pending'
                    OR (status IN ('Scheduled', 'Called - Callback Requested')
                        AND (scheduled_callback_at IS NULL OR scheduled_callback_at <= NOW()))
                  )
                ORDER BY COALESCE(scheduled_callback_at, created_at) ASC
                LIMIT $2""",
            self.call_batch_id,
            MAX_CALLS_PER_RUN,
        )

        if not pending_rows:
            return self.counts

        # Convert rows to plain dicts up front (asyncpg Records aren't safe to
        # share across tasks if the underlying conn is released).
        pending = []
        for r in pending_rows:
            d = dict(r)
            for k, v in d.items():
                if isinstance(v, uuid.UUID):
                    d[k] = str(v)
            pending.append(d)

        logger.info(
            "Dispatcher batch=%s starting | pending=%d | concurrency=%d",
            self.batch_id_uuid, len(pending), self.semaphore._value,
        )
        _emit("batches", {
            "type": "batch_progress",
            "status": "running",
            "batch_id": self.call_batch_id,
            "batch_uuid": self.batch_id_uuid,
            "bank_id": pending[0].get("bank_id") if pending else None,
            "total": len(pending),
            "completed": 0,
            "failed": 0,
            "successful": 0,
        })

        # Launch one task per call; semaphore inside _dispatch_one bounds peak.
        tasks = [asyncio.create_task(self._dispatch_one(c), name=f"call-{c['id']}")
                 for c in pending]
        await asyncio.gather(*tasks, return_exceptions=True)

        logger.info(
            "Dispatcher batch=%s done | %s",
            self.batch_id_uuid, self.counts,
        )
        # Ops acknowledgement — one Telegram ping per finished batch so the
        # operator doesn't have to babysit the dashboard.
        try:
            from lib.notifier import notify
            await notify(
                severity="info",
                title="Batch complete",
                body=(
                    f"Batch {self.batch_id_uuid}: "
                    f"{self.counts.get('successful', 0)} successful, "
                    f"{self.counts.get('failed', 0)} failed, "
                    f"{self.counts.get('completed', 0)} total."
                ),
                dedupe_key=f"batch_done_{self.batch_id_uuid}",
            )
        except Exception:
            pass
        _emit("batches", {
            "type": "batch_progress",
            "status": "done",
            "batch_id": self.call_batch_id,
            "batch_uuid": self.batch_id_uuid,
            "bank_id": pending[0].get("bank_id") if pending else None,
            "total": len(pending),
            **self.counts,
        })

        # M5: alert on sustained failure rate. Threshold: >=5 failures AND
        # >50% of attempts failed. dedupe_key includes the batch so we get
        # one alert per bad batch, not one per cron tick.
        completed = self.counts.get("completed", 0)
        failed = self.counts.get("failed", 0)
        if completed >= 5 and failed / max(1, completed) > 0.5:
            try:
                from lib.notifier import notify
                await notify(
                    severity="warning",
                    title=f"Dispatcher: high failure rate ({failed}/{completed})",
                    body=(
                        f"Batch {self.batch_id_uuid} finished with "
                        f"{failed} failures out of {completed} calls "
                        f"({failed * 100 // max(1, completed)}%). "
                        "Investigate LiveKit/SIP/agent worker health."
                    ),
                    dedupe_key=f"dispatcher_fail_rate:{self.batch_id_uuid}",
                    fields={"successful": str(self.counts.get("successful", 0)),
                            "failed": str(failed), "total": str(completed)},
                )
            except Exception:
                pass

        return self.counts

    async def _wait_for_cooldown_and_retry(self, call_uuid) -> Optional[dict]:
        """Every eligible trunk is momentarily unavailable — either COOLING
        DOWN (a future cooldown_until after a successful call) or BUSY at
        capacity (active_calls >= pool.capacity, all channels in use). Both are
        temporary, so wait for one to free and re-acquire rather than failing
        the call. Only give up when NO eligible trunk is configured at all
        (nothing to wait for) or the wait deadline is exceeded.

        Cooling-down trunks have a known ETA (cooldown_until) so we sleep
        exactly that long; busy-at-capacity trunks have no ETA (a call can run
        up to the completion timeout) so we poll on a fixed interval.

        Single-number pools hit the cooling case after EVERY successful call
        (180-300s cooldown) and the busy case whenever a batch fans out wider
        than the trunk's channel count — failing the call in either meant a
        re-uploaded batch never rang.
        Returns a trunk dict or None (caller falls through to the fail path)."""
        deadline = asyncio.get_event_loop().time() + TRUNK_WAIT_DEADLINE_S
        while not self._stopped:
            # Does an eligible trunk for this call exist at all (ignoring the
            # transient busy/cooldown state)? And of those merely cooling down,
            # how long until the soonest frees? A busy-at-capacity trunk has no
            # cooldown_until, so cooldown_s is NULL and we fall back to polling.
            # The eligibility filter MUST mirror _acquire_trunk_from_db so we
            # never wait for a trunk acquisition would skip (e.g. a number that
            # is not auto_dial_eligible on the automatic path).
            q = """SELECT COUNT(*) AS candidates,
                          EXTRACT(EPOCH FROM (
                              MIN(pn.cooldown_until)
                                  FILTER (WHERE pn.cooldown_until > NOW())
                              - NOW()
                          )) AS cooldown_s
                     FROM phone_numbers pn
                     JOIN phone_pools pp ON pp.id = pn.pool_id
                    WHERE pn.status = 'active'"""
            args: list = []
            if self.preferred_phone_id:
                q += " AND pn.id = $1"
                args.append(uuid.UUID(self.preferred_phone_id))
            else:
                q += " AND pn.auto_dial_eligible = TRUE"
            row = await self.db_pool.fetchrow(q, *args)
            if row is None or row["candidates"] == 0:
                return None  # no eligible trunk exists — nothing to wait for
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                logger.error(
                    "Trunk wait exceeded %.0fs for call %s — giving up",
                    TRUNK_WAIT_DEADLINE_S, call_uuid,
                )
                return None
            cooldown_s = row["cooldown_s"]
            if cooldown_s is not None and cooldown_s > 0:
                sleep_s = float(cooldown_s) + 1.0        # wait exactly for cooldown
                reason = "cooling down"
            else:
                sleep_s = TRUNK_BUSY_POLL_INTERVAL_S      # busy at capacity, no ETA
                reason = "busy at capacity"
            sleep_s = min(max(sleep_s, 2.0), remaining)
            logger.info(
                "All trunks %s — waiting %.0fs for the pool to free up (call %s)",
                reason, sleep_s, call_uuid,
            )
            await asyncio.sleep(sleep_s)
            trunk = await _acquire_trunk_from_db(
                self.db_pool, preferred_phone_id=self.preferred_phone_id
            )
            if trunk is not None:
                return trunk
        return None

    async def _dispatch_one(self, call: dict) -> None:
        async with self.semaphore:
            # Re-check exit conditions inside the semaphore — windows may have
            # closed while we were waiting our turn.
            if self._stopped:
                return
            if not self.is_within_calling_hours():
                logger.info("Skipping %s: calling hours ended", call.get("id"))
                return
            if await self.is_emergency_stop_active():
                logger.warning("Skipping %s: emergency stop", call.get("id"))
                return
            if await self._call_bank_stopped(call):
                logger.warning(
                    "Skipping %s: bank %s emergency stop (shared callback batch)",
                    call.get("id"), call.get("bank_id"),
                )
                return

            call_uuid = uuid.UUID(call["id"])
            name = call.get("customer_name") or "Customer"
            phone = call.get("phone") or ""

            # Emit lifecycle event: dispatcher has picked this call up.
            # UI uses this to insert a card into /ops/live instantly.
            _emit("calls", {
                "type": "call_state",
                "status": "dispatching",
                "call_id": str(call_uuid),
                "batch_id": call.get("batch_id"),
                "bank_id": call.get("bank_id"),
                "customer_name": name,
                "phone": phone,
                "language": call.get("language"),
                "agent_type": call.get("agent_type"),
            })

            # Validate phone on DIGIT COUNT, not raw string length. A number like
            # "+91 98765 43210" is 16 raw chars but formatting/spaces shouldn't
            # count; conversely "1234567890.0" from Excel must not pass. We mirror
            # the dialer's own normalisation (_to_e164) and count digits, so the
            # "Invalid Phone" verdict matches what would actually be dialed.
            phone_digits = "".join(ch for ch in (phone or "") if ch.isdigit())
            if len(phone_digits) < 10 or _to_e164(phone) is None:
                logger.warning(
                    "Call %s marked Invalid Phone: customer=%r phone=%r (digits=%d, e164=%r)",
                    call_uuid, name, phone, len(phone_digits), _to_e164(phone),
                )
                await self.db_pool.execute(
                    """UPDATE agent_calls
                          SET status = 'Invalid Phone',
                              error_message = $4,
                              retry_count = $1, updated_at = $2
                        WHERE id = $3""",
                    self.max_retries + 1, self.now_ist(), call_uuid,
                    f"Un-dialable phone (digits={len(phone_digits)}): {phone!r}",
                )
                await self._bump("failed")
                await self._bump("completed")
                return

            # Acquire a trunk: DB first, env fallback otherwise. If the operator
            # picked a specific phone for this batch, restrict to that row —
            # do NOT fall back to env trunk in that case (the operator's pick
            # is authoritative; falling back would surprise them).
            trunk = await _acquire_trunk_from_db(
                self.db_pool,
                preferred_phone_id=self.preferred_phone_id,
            )
            # If every pooled number is merely COOLING DOWN, wait for one to free
            # up rather than reaching for the env trunk. The env fallback exists
            # for "phone_numbers is empty" (see _env_fallback_trunk) — trying it
            # first meant that on a single-number pool (which cools down 180-300s
            # after every call) we dialed SIP_TRUNK_ID instead of waiting. When
            # that env value is stale, LiveKit rejects the call with
            # "requested sip trunk does not exist" (Twirp 404) and the customer
            # is never rung; the env trunk also carries no caller ID.
            if trunk is None:
                trunk = await self._wait_for_cooldown_and_retry(call_uuid)
            if trunk is None and not self.preferred_phone_id:
                trunk = _env_fallback_trunk(self.sip_trunk_id_fallback)
            if trunk is None:
                logger.error(
                    "No outbound trunk available for call %s — neither phone_numbers nor SIP_TRUNK_ID env",
                    call_uuid,
                )
                # M5: ops-visible alert. Rate-limited so a misconfigured deploy
                # doesn't flood Telegram; ops just needs to see the issue once.
                try:
                    from lib.notifier import notify
                    await notify(
                        severity="critical",
                        title="Dispatcher: no SIP trunk available",
                        body=(
                            "Calls cannot be placed because neither the phone_numbers "
                            "table nor the SIP_TRUNK_ID env var has an active trunk. "
                            "Seed phone_numbers or set SIP_TRUNK_ID."
                        ),
                        dedupe_key="dispatcher_no_trunk",
                    )
                except Exception:
                    pass
                await self.db_pool.execute(
                    """UPDATE agent_calls
                          SET status = 'Failed',
                              error_message = 'No SIP trunk configured',
                              ended_at = $1, updated_at = $1,
                              retry_count = retry_count + 1
                        WHERE id = $2""",
                    self.now_ist(), call_uuid,
                )
                await self._bump("failed")
                await self._bump("completed")
                return

            # We may have parked in _wait_for_cooldown_and_retry for up to
            # TRUNK_WAIT_DEADLINE_S waiting for a channel. Re-validate the exit
            # gates before dialing so a parked call never dials past the calling
            # window or after an emergency stop. Release the trunk and leave the
            # call Pending so it dials in the next window.
            if (self._stopped or not self.is_within_calling_hours()
                    or await self.is_emergency_stop_active()
                    or await self._call_bank_stopped(call)):
                logger.info(
                    "Aborting call %s after trunk wait: window closed / stopped / emergency-stop",
                    call_uuid,
                )
                await _release_trunk_to_db(self.db_pool, trunk, success=False)
                return

            outcome_success = False
            try:
                if self.demo_mode:
                    outcome_success = await self._place_demo_call(call, call_uuid, name)
                else:
                    outcome_success = await self._place_real_call(call, call_uuid, name, phone, trunk)
            except Exception as e:
                logger.exception("Call error for %s (%s)", name, call_uuid)
                await self.db_pool.execute(
                    """UPDATE agent_calls
                          SET status = 'Failed', error_message = $1,
                              ended_at = $2, updated_at = $2,
                              retry_count = retry_count + 1
                        WHERE id = $3""",
                    str(e)[:500], self.now_ist(), call_uuid,
                )
                outcome_success = False
            finally:
                await _release_trunk_to_db(self.db_pool, trunk, success=outcome_success)
                await self._bump("successful" if outcome_success else "failed")
                await self._bump("completed")
                # Emit terminal lifecycle event so the UI card transitions
                # to its final state (green check / red cross) + vanishes.
                _emit("calls", {
                    "type": "call_state",
                    "status": "completed" if outcome_success else "failed",
                    "call_id": str(call_uuid),
                    "batch_id": call.get("batch_id"),
                    "bank_id": call.get("bank_id"),
                    "customer_name": name,
                    "outcome_success": outcome_success,
                })

    # ─── Per-call placement (real or demo) ───────────────────────────────────

    async def _place_demo_call(self, call: dict, call_uuid, name: str) -> bool:
        """Simulated call for DEMO_MODE. Same writes as the old loop."""
        call_start = self.now_ist()
        await self.db_pool.execute(
            """UPDATE agent_calls
                  SET status = 'Calling', started_at = $1, updated_at = $1
                WHERE id = $2""",
            call_start, call_uuid,
        )

        room_name = f"demo_{secrets.token_hex(6)}_{int(time.time())}"
        await self.db_pool.execute(
            "UPDATE agent_calls SET room_name = $1 WHERE id = $2",
            room_name, call_uuid,
        )
        await asyncio.sleep(3)

        import random as rng
        interested = rng.choice([True, True, False])
        loan_type = rng.choice(["personal", "business", "education"])
        status = "Called - Interested" if interested else "Called - Not Interested"
        lead_quality = "hot" if interested else "cold"

        from datetime import datetime
        now_str = call_start.strftime("%b %d, %Y %I:%M %p")
        demo_transcript = [
            {"role": "agent", "text": f"Hello, am I speaking with {name}?", "timestamp": now_str},
            {"role": "user", "text": "Yes, speaking.", "timestamp": now_str},
        ]
        call_end = self.now_ist()
        duration_seconds = int((call_end - call_start).total_seconds())
        category = "Very Interested - Form Sent" if interested else "Not Interested - No Need Currently"

        await self.db_pool.execute(
            """UPDATE agent_calls SET
                transcript = $1, status = $2, call_duration = $3,
                ended_at = $4, updated_at = $4,
                interested = $5, loan_type = $6,
                category = $7,
                call_analysis = $8,
                collected_data = $9
               WHERE id = $10""",
            json.dumps(demo_transcript),
            status,
            duration_seconds,
            call_end,
            interested,
            loan_type if interested else None,
            category,
            json.dumps({"lead_quality": lead_quality, "follow_up_needed": "Yes" if interested else "No"}),
            json.dumps({"loan_type": loan_type}) if interested else None,
            call_uuid,
        )
        return True  # demo always "succeeds"

    async def _place_real_call(self, call: dict, call_uuid, name: str, phone: str, trunk: dict) -> bool:
        """Real LiveKit + SIP call. Same writes as the old loop."""
        call_start = self.now_ist()
        await self.db_pool.execute(
            """UPDATE agent_calls
                  SET status = 'Calling', started_at = $1, updated_at = $1
                WHERE id = $2""",
            call_start, call_uuid,
        )

        room_name = f"los_{secrets.token_hex(6)}_{int(time.time())}"
        lk = api.LiveKitAPI(url=self.livekit_url, api_key=self.livekit_api_key,
                            api_secret=self.livekit_api_secret)

        # Customer gender (stored in collected_data at upload time)
        cd = call.get("collected_data") or {}
        if isinstance(cd, str):
            try: cd = json.loads(cd)
            except Exception: cd = {}
        customer_gender = (cd.get("gender") if isinstance(cd, dict) else None) or "male"
        agent_purpose = call.get("agent_type", "loan_enquiry")
        bank_name_for_agent = ("Union Bank of India" if agent_purpose == "account_opening"
                               else "ABC Bank")

        try:
            # M5: wrap each LiveKit op with circuit breaker + timeout.
            # Three separate breaker names so e.g. SIP trouble doesn't trip
            # the breaker that guards room creation.
            await protect(
                "livekit",
                lk.room.create_room,
                api.CreateRoomRequest(
                    name=room_name, empty_timeout=300, max_participants=3,
                    metadata=json.dumps({
                        "customer_name": name,
                        "phone": phone,
                        "call_id": str(call_uuid),
                        "bank_id": call.get("bank_id", ""),
                        "language": call.get("language", "hindi"),
                        "gender": customer_gender,
                        "agent_purpose": agent_purpose,
                        "bank_name": bank_name_for_agent,
                    }),
                ),
                timeout_s=15,
            )
            await self.db_pool.execute(
                "UPDATE agent_calls SET room_name = $1 WHERE id = $2",
                room_name, call_uuid,
            )

            # Dispatch agent FIRST so it joins before SIP leg (Samavesh pattern;
            # otherwise customer hears silence on connect)
            agent_for_call = (self.agent_name_union if agent_purpose == "account_opening"
                              else self.agent_name_pusad)
            await protect(
                "livekit",
                lk.agent_dispatch.create_dispatch,
                api.CreateAgentDispatchRequest(room=room_name, agent_name=agent_for_call),
                timeout_s=15,
            )
            sip_phone = _to_e164(phone)
            # Force the From / caller-ID to the operator's selected phone.
            # Without sip_number, LiveKit falls back to the trunk's `numbers`
            # field — and if multiple outbound trunks share an account or the
            # field is misaligned with our phone_numbers table, the From leaks
            # to whichever number LiveKit picks (commonly the Viva India one
            # even when the operator picked the Twilio US row in /ops/batch).
            # Setting sip_number explicitly makes the From bullet-proof.
            sip_req_kwargs = dict(
                room_name=room_name,
                sip_trunk_id=trunk["trunk_id"],
                sip_call_to=sip_phone,
                participant_identity=f"customer_{name.replace(' ', '_').replace('/', '_')}",
                participant_name=name,
                play_ringtone=True,
            )
            if trunk.get("phone_number"):
                sip_req_kwargs["sip_number"] = trunk["phone_number"]
                logger.info(
                    "Dispatching call %s | trunk=%s | from=%s | to=%s",
                    call_uuid, trunk["trunk_id"], trunk["phone_number"], sip_phone,
                )
            else:
                # env-fallback trunk — no per-row From number; LiveKit uses
                # the trunk's default. Log it so an unexpected fallback is
                # visible during the dispatcher cutover.
                logger.info(
                    "Dispatching call %s | trunk=%s (env fallback, no sip_number) | to=%s",
                    call_uuid, trunk["trunk_id"], sip_phone,
                )
            await protect(
                "livekit_sip",
                lk.sip.create_sip_participant,
                api.CreateSIPParticipantRequest(**sip_req_kwargs),
                timeout_s=30,
            )
        finally:
            await lk.aclose()

        # Poll until LiveKit reports the call complete (or timeout)
        result = await self.wait_for_call_completion(str(call_uuid), room_name)
        if result:
            fs = result.get("status", "Unknown")
            # Callback statuses mean the agent ran schedule_callback() during this
            # conversation — treat as soft success (trunk released without cooldown,
            # counted as successful, SSE shows "completed" not "failed").
            if fs in ("Scheduled", "Called - Callback Requested"):
                return True
            return fs in ("Called", "Completed", "Called - Interested", "Called - Not Interested")
        return False


# ============================================================================
# DispatcherManager — singleton, tracks active dispatchers for stop_all()
# ============================================================================

class DispatcherManager:
    """Singleton on app.state. Holds active dispatchers so emergency_stop /
    shutdown can signal them to stop accepting new work."""

    def __init__(self) -> None:
        self._active: dict[str, Dispatcher] = {}
        self._lock = asyncio.Lock()

    def register(self, batch_id: str, dispatcher: Dispatcher) -> None:
        # Synchronous register (called inside async context; no contention
        # because each batch_id is unique per process_batch_run invocation).
        self._active[batch_id] = dispatcher

    def unregister(self, batch_id: str) -> None:
        self._active.pop(batch_id, None)

    def stop_all(self) -> int:
        """Signal every active dispatcher to stop. Returns count signaled."""
        n = 0
        for d in list(self._active.values()):
            d.stop()
            n += 1
        return n

    def stop_bank(self, bank_id: str) -> int:
        """Signal only the dispatchers belonging to one bank. Returns the count.

        A bank raising its own emergency stop must not kill another tenant's
        in-flight calls, which is what stop_all() did.
        """
        want = str(bank_id)
        n = 0
        for d in list(self._active.values()):
            if getattr(d, "bank_id", None) == want:
                d.stop()
                n += 1
        return n

    def stop_one(self, batch_id: str) -> bool:
        """Signal a single active dispatcher (by batch_id) to stop. Returns True
        if a dispatcher was registered for that batch, else False (the batch is
        queued but not actively dialing — stopping it is a DB-only operation)."""
        d = self._active.get(batch_id)
        if d is not None:
            d.stop()
            return True
        return False

    def active_count(self) -> int:
        return len(self._active)


# Module-level singleton — accessed from agent/batch.py.
manager = DispatcherManager()
