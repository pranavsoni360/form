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


logger = logging.getLogger(__name__)

# How many calls to launch in parallel. Below the dispatcher's actual ceiling
# (which is min(this, total phone pool capacity)). For 500/day on a single
# trunk, 5 is comfortable; bump to 10 if you add a second trunk.
DEFAULT_CONCURRENCY = int(os.getenv("DISPATCHER_CONCURRENCY", "5"))

# Hard cap on calls processed per batch invocation. Matches the previous
# behavior in agent/batch.py:197 — keeps each cron tick bounded.
MAX_CALLS_PER_RUN = int(os.getenv("DISPATCHER_MAX_CALLS_PER_RUN", "50"))


# ============================================================================
# Trunk acquisition helpers
# ============================================================================

async def _acquire_trunk_from_db(db_pool) -> Optional[dict]:
    """Try to claim the least-loaded available trunk from phone_numbers.

    Returns a dict with id/trunk_id/cooldown bounds, or None if no row is
    eligible. Uses FOR UPDATE SKIP LOCKED so two parallel callers never race
    on the same row.

    The selection order is:
      1. status='active'
      2. cooldown_until passed (or NULL)
      3. active_calls < pool.capacity (room to take another call)
      4. Sort by least-loaded then least-used then id (deterministic tiebreak)
    """
    async with db_pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """SELECT pn.id, pn.phone_number, pn.livekit_trunk_id,
                          pp.cooldown_seconds_min, pp.cooldown_seconds_max
                     FROM phone_numbers pn
                     JOIN phone_pools pp ON pp.id = pn.pool_id
                    WHERE pn.status = 'active'
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
    return {
        "id": str(row["id"]),
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

        self.semaphore = asyncio.Semaphore(concurrency)
        self._stopped = False
        self.counts = {"completed": 0, "successful": 0, "failed": 0}
        self._counts_lock = asyncio.Lock()

    def stop(self) -> None:
        """Signal: stop picking up new work. In-flight tasks finish naturally."""
        self._stopped = True

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
                    OR (status = 'Scheduled' AND (scheduled_callback_at IS NULL OR scheduled_callback_at <= NOW()))
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

        # Launch one task per call; semaphore inside _dispatch_one bounds peak.
        tasks = [asyncio.create_task(self._dispatch_one(c), name=f"call-{c['id']}")
                 for c in pending]
        await asyncio.gather(*tasks, return_exceptions=True)

        logger.info(
            "Dispatcher batch=%s done | %s",
            self.batch_id_uuid, self.counts,
        )

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

            call_uuid = uuid.UUID(call["id"])
            name = call.get("customer_name") or "Customer"
            phone = call.get("phone") or ""

            # Validate phone (same as old loop)
            if not phone or len(phone) < 10:
                await self.db_pool.execute(
                    """UPDATE agent_calls
                          SET status = 'Invalid Phone',
                              retry_count = $1, updated_at = $2
                        WHERE id = $3""",
                    self.max_retries + 1, self.now_ist(), call_uuid,
                )
                await self._bump("failed")
                await self._bump("completed")
                return

            # Acquire a trunk: DB first, env fallback otherwise
            trunk = await _acquire_trunk_from_db(self.db_pool)
            if trunk is None:
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
                               else "Pusad Urban Bank")

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
            sip_phone = phone if phone.startswith("+") else f"+91{phone[-10:]}"
            await protect(
                "livekit_sip",
                lk.sip.create_sip_participant,
                api.CreateSIPParticipantRequest(
                    room_name=room_name,
                    sip_trunk_id=trunk["trunk_id"],
                    sip_call_to=sip_phone,
                    participant_identity=f"customer_{name.replace(' ', '_').replace('/', '_')}",
                    participant_name=name,
                    play_ringtone=True,
                ),
                timeout_s=30,
            )
        finally:
            await lk.aclose()

        # Poll until LiveKit reports the call complete (or timeout)
        result = await self.wait_for_call_completion(str(call_uuid), room_name)
        if result:
            fs = result.get("status", "Unknown")
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

    def active_count(self) -> int:
        return len(self._active)


# Module-level singleton — accessed from agent/batch.py.
manager = DispatcherManager()
