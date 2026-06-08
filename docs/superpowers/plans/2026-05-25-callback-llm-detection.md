# Callback LLM Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `"Called - Callback Requested"` as a first-class call status and extend the post-call Gemini analysis to auto-detect and schedule callbacks when the voice agent missed calling `schedule_callback()` during the live call.

**Architecture:** Two scheduling paths exist in parallel. Path 1 (primary): voice agent calls `schedule_callback()` during the live call — callbacks.py now writes `"Called - Callback Requested"` instead of `"Scheduled"`. Path 2 (safety net): the existing `transcript_analyze` Gemini job is extended to output `callback_requested` + `callback_datetime_iso`; if a callback is detected but `scheduled_callback_at` is null, the job handler schedules it automatically. The dispatcher query is widened to pick up both old `"Scheduled"` rows (backward compat) and new `"Called - Callback Requested"` rows.

**Tech Stack:** Python 3.11, FastAPI, asyncpg, Gemini 2.5 Flash (`google-genai`), Next.js 14, TypeScript, shadcn Badge.

---

## File Map

| File | Change |
|------|--------|
| `backend/agent/state.py` | Add `"Called - Callback Requested"` to `STATUS_OPTIONS` |
| `backend/agent/callbacks.py` | Write `"Called - Callback Requested"` instead of `"Scheduled"` |
| `backend/agent/transcript.py` | Preserve-check covers both status names |
| `backend/agent/analytics.py` | Extend Gemini prompt; inject call date; update analytics sweep filter |
| `backend/services/job_handlers.py` | Add `_schedule_callback_from_analysis()` helper + invoke in `transcript_analyze` |
| `backend/services/dispatcher.py` | Accept both status names in run() query; treat `"Called - Callback Requested"` as soft-success |
| `backend/agent/batch.py` | Remaining-calls check + batch_status endpoint include new status |
| `frontend/components/ops/CallDetailDialog.tsx` | `statusVariant` amber branch for new status |
| `frontend/app/ops/calls/page.tsx` | Add status to filter list; add `scheduled_callback_at` to `CallRow`; show callback time sub-label in status cell |

---

## Task 1 — Backend status constant

**Files:**
- Modify: `backend/agent/state.py:69-72`

- [ ] **Add `"Called - Callback Requested"` to `STATUS_OPTIONS`**

Open `backend/agent/state.py`. Replace the existing `STATUS_OPTIONS` list:

```python
STATUS_OPTIONS = [
    "Pending", "Calling", "Called", "Called - Interested", "Called - Not Interested",
    "Called - Callback Requested",          # customer asked to be re-dialled at a specific time
    "Not Answered", "Call Not Connected", "Failed", "Scheduled", "Invalid Phone",
]
```

(`"Scheduled"` is kept so existing DB rows don't become unrecognised values.)

- [ ] **Verify the file looks right**

```bash
grep -n "STATUS_OPTIONS\|Callback Requested\|Scheduled" backend/agent/state.py
```

Expected output includes both `"Scheduled"` and `"Called - Callback Requested"` lines.

- [ ] **Commit**

```bash
git add backend/agent/state.py
git commit -m "feat(callbacks): add 'Called - Callback Requested' to STATUS_OPTIONS"
```

---

## Task 2 — callbacks.py: write new status name

**Files:**
- Modify: `backend/agent/callbacks.py:70-74`

- [ ] **Change the status written by `POST /api/agent/schedule-callback`**

Open `backend/agent/callbacks.py`. In the `schedule_callback` route handler, find the `db_pool.execute` UPDATE and change `status = 'Scheduled'` to `status = 'Called - Callback Requested'`:

```python
    await _state.db_pool.execute(
        """UPDATE agent_calls
           SET status = 'Called - Callback Requested',
               scheduled_callback_at = $1,
               callback_reason = $2,
               error_message = NULL,
               updated_at = $3
           WHERE id = $4""",
        dt_ist, reason, now_local, call_uuid,
    )
```

- [ ] **Verify**

```bash
grep -n "Scheduled\|Callback Requested" backend/agent/callbacks.py
```

Expected: only `"Called - Callback Requested"` in the UPDATE, no bare `"Scheduled"` status write.

- [ ] **Commit**

```bash
git add backend/agent/callbacks.py
git commit -m "feat(callbacks): schedule_callback endpoint writes 'Called - Callback Requested'"
```

---

## Task 3 — transcript.py: preserve-check covers both names

**Files:**
- Modify: `backend/agent/transcript.py:47-55` (the `existing_status` block added in the previous session)

- [ ] **Update the preserve-check to handle both `"Scheduled"` (old rows) and `"Called - Callback Requested"` (new rows)**

Open `backend/agent/transcript.py`. Find the status determination block and replace it:

```python
    # Determine final status.
    # If the voice agent already set a callback status during the live call,
    # preserve it. We guard both the old name ("Scheduled" — existing DB rows)
    # and the new name ("Called - Callback Requested") so a backend restart
    # with pre-migration rows never breaks.
    _CALLBACK_STATUSES = {"Scheduled", "Called - Callback Requested"}
    existing_status = call.get("status")
    if existing_status in _CALLBACK_STATUSES:
        status = existing_status   # preserve whichever variant is in DB
    elif transcript:
        status = "Called - Interested" if data.customer_interested else "Called - Not Interested"
    else:
        status = "Not Answered"
```

Also update the `category` preserve-check just below it:

```python
    if existing_status in _CALLBACK_STATUSES:
        category = call.get("category") or "Scheduled Callback"
    elif transcript:
        category = "Uncategorized"
    else:
        category = "Call Not Connected"
```

- [ ] **Verify the file contains both status names in the guard**

```bash
grep -n "_CALLBACK_STATUSES\|Scheduled\|Callback Requested" backend/agent/transcript.py
```

Expected: one `_CALLBACK_STATUSES` set definition containing both strings, used in two `if` checks.

- [ ] **Commit**

```bash
git add backend/agent/transcript.py
git commit -m "fix(transcript): preserve-check handles both 'Scheduled' and 'Called - Callback Requested'"
```

---

## Task 4 — analytics.py: extend Gemini prompt with callback detection

**Files:**
- Modify: `backend/agent/analytics.py:34-89`

- [ ] **Add `callback_requested` + `callback_datetime_iso` to the prompt and update the async analyser**

Open `backend/agent/analytics.py`. Replace `analyze_transcript_with_llm_async`:

```python
async def analyze_transcript_with_llm_async(
    transcript: list,
    call_started_at=None,          # datetime | str | None — reference for relative times
) -> dict:
    """Async version of the analyzer. Routes the Gemini call through the
    circuit breaker so sustained Gemini outages stop burning attempts.

    Used by services/job_handlers.py::transcript_analyze (M3 job queue).
    The sync version below is kept as a thin shim for any legacy call sites.
    """
    if not GEMINI_API_KEY or not transcript:
        return {
            "category": "Uncategorized", "reminder_date": None,
            "follow_up_needed": "No",
            "callback_requested": False, "callback_datetime_iso": None,
        }

    # Derive a reference date string so the LLM can resolve "tomorrow", "Monday" etc.
    call_date_str = ""
    if call_started_at:
        try:
            from datetime import datetime as _dt
            if isinstance(call_started_at, str):
                call_started_at = _dt.fromisoformat(call_started_at)
            call_date_str = call_started_at.strftime("%Y-%m-%d")
        except Exception:
            pass
    if not call_date_str:
        call_date_str = now_ist().strftime("%Y-%m-%d")

    conversation_text = "\n".join(
        f"{msg.get('role', 'unknown')}: {msg.get('text', '')}" for msg in transcript
    )
    prompt = f"""Analyze this call transcript and categorize it.

Categories (choose one):
{chr(10).join(f'- {cat}' for cat in CATEGORY_OPTIONS)}

Determine follow-up needs and lead quality:
- "Very Interested - Form Sent" -> follow_up_needed: "Yes", lead_quality: "hot"
- "Interested - Callback Requested" -> follow_up_needed: "Yes", lead_quality: "warm"
- "Interested - Needs Time to Decide" -> follow_up_needed: "Yes", lead_quality: "warm"
- "Not Interested" categories -> follow_up_needed: "No", lead_quality: "cold"
- "Ineligible" categories -> follow_up_needed: "No", lead_quality: "cold"
- Other -> follow_up_needed: "No", lead_quality: "cold"

Also detect callback intent:
- callback_requested: true if the customer explicitly said they are busy / asked to be
  called back at a specific future time. false otherwise.
- callback_datetime_iso: ISO 8601 IST datetime string for when the customer wants to
  be called back (e.g. "2026-05-26T10:00:00+05:30"). Use "{call_date_str}" as today's
  reference date when resolving relative references like "tomorrow", "Monday morning",
  "kal subah", "udya sakali". Return null if callback_requested is false, or if no
  specific time was mentioned (e.g. customer just said "call later").

Return JSON ONLY:
{{
  "category": "chosen category",
  "reminder_date": "YYYY-MM-DD or null",
  "follow_up_needed": "Yes or No",
  "how_to_follow_up": "brief instructions",
  "when_to_follow_up": "timeframe",
  "lead_quality": "hot/warm/cold",
  "loan_type": "education/business/personal or null",
  "callback_requested": true or false,
  "callback_datetime_iso": "ISO 8601 IST string or null"
}}

Transcript:
{conversation_text}"""

    try:
        from lib.circuit_breaker import protect, CircuitOpenError
        raw = await protect(
            "gemini",
            asyncio.to_thread, _gemini_call_sync, prompt,
            timeout_s=45,
            failure_threshold=5,
            recovery_timeout=60,
        )
        result = (raw or "").strip()
        if result.startswith("```"):
            result = result.split("```")[1].replace("json", "").strip()
        parsed = json.loads(result)
        if "follow_up_needed" not in parsed:
            parsed["follow_up_needed"] = "No"
        parsed.setdefault("callback_requested", False)
        parsed.setdefault("callback_datetime_iso", None)
        return parsed
    except CircuitOpenError as e:
        logger.warning("Gemini circuit OPEN — skipping analysis: %s", e)
        return {
            "category": "Uncategorized", "reminder_date": None,
            "follow_up_needed": "No",
            "callback_requested": False, "callback_datetime_iso": None,
        }
    except (json.JSONDecodeError, ValueError) as e:
        logger.error("Gemini returned unparseable JSON: %s", e)
        return {
            "category": "Uncategorized", "reminder_date": None,
            "follow_up_needed": "No",
            "callback_requested": False, "callback_datetime_iso": None,
        }
    except Exception as e:
        logger.error("LLM analysis failed: %s", e)
        return {
            "category": "Uncategorized", "reminder_date": None,
            "follow_up_needed": "No",
            "callback_requested": False, "callback_datetime_iso": None,
        }
```

- [ ] **Update `process_analytics_batch` sweep to include `"Called - Callback Requested"`**

In the same file, find the `rows = await _state.db_pool.fetch(...)` call inside `process_analytics_batch` and update the `status IN (...)` clause:

```python
        rows = await _state.db_pool.fetch(
            """SELECT id FROM agent_calls
               WHERE COALESCE(category, 'Uncategorized') IN ('Uncategorized', '')
                 AND transcript IS NOT NULL AND transcript != '[]'::jsonb
                 AND status IN (
                     'Called', 'Completed',
                     'Called - Interested', 'Called - Not Interested',
                     'Called - Callback Requested'
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM call_processing_jobs j
                     WHERE j.job_type = 'transcript_analyze'
                       AND j.status IN ('pending', 'running', 'failed')
                       AND (j.payload->>'call_id') = agent_calls.id::text
                 )
               ORDER BY created_at ASC
               LIMIT 50"""
        )
```

- [ ] **Verify**

```bash
grep -n "callback_requested\|callback_datetime_iso\|call_date_str\|Called - Callback Requested" backend/agent/analytics.py
```

Expected: all four strings present.

- [ ] **Commit**

```bash
git add backend/agent/analytics.py
git commit -m "feat(analytics): extend Gemini prompt with callback_requested + callback_datetime_iso detection"
```

---

## Task 5 — job_handlers.py: safety-net scheduling

**Files:**
- Modify: `backend/services/job_handlers.py:37-125`

- [ ] **Add the `_schedule_callback_from_analysis` helper near the top of the module (after imports)**

Open `backend/services/job_handlers.py`. Add this helper function after the `logger` line and before `transcript_analyze`:

```python
async def _schedule_callback_from_analysis(
    db_pool,
    call_uuid,
    callback_iso: str,
    call: dict,
) -> bool:
    """Schedule a callback discovered by post-call LLM analysis (safety-net path).

    Clamps the datetime into calling hours, sets status='Called - Callback Requested',
    and reactivates the parent batch. Returns True if scheduling succeeded.

    This is intentionally a verbatim copy of the clamping logic in
    agent/callbacks.py so job_handlers stays self-contained (no circular import).
    """
    import uuid as _uuid
    from agent.state import now_ist, IST, CALL_START_HOUR, CALL_END_HOUR
    from datetime import datetime, timedelta

    try:
        if callback_iso.endswith("Z"):
            callback_iso = callback_iso[:-1] + "+00:00"
        dt = datetime.fromisoformat(callback_iso)
        if dt.tzinfo is None:
            dt = IST.localize(dt)
    except (ValueError, TypeError) as e:
        logger.warning("_schedule_callback_from_analysis: unparseable iso %r: %s", callback_iso, e)
        return False

    dt_ist = dt.astimezone(IST)
    now_local = now_ist()
    # Clamp: must be at least 1 minute in the future
    if dt_ist < now_local + timedelta(minutes=1):
        dt_ist = now_local + timedelta(minutes=2)
    # Clamp: must be within calling hours window
    if dt_ist.hour < CALL_START_HOUR or dt_ist.hour >= CALL_END_HOUR:
        next_day = (
            dt_ist.date()
            if dt_ist.hour < CALL_START_HOUR
            else (dt_ist + timedelta(days=1)).date()
        )
        dt_ist = IST.localize(
            datetime.combine(next_day, datetime.min.time())
        ).replace(hour=CALL_START_HOUR)

    await db_pool.execute(
        """UPDATE agent_calls
           SET status = 'Called - Callback Requested',
               scheduled_callback_at = $1,
               callback_reason = 'user_busy_llm_detected',
               error_message = NULL,
               updated_at = $2
           WHERE id = $3""",
        dt_ist, now_local, call_uuid,
    )

    # Reactivate the parent batch so the dispatcher cron will pick this row up.
    batch_id = call.get("batch_id")
    if batch_id:
        await db_pool.execute(
            """UPDATE agent_batches
               SET status = 'running'
               WHERE batch_id = $1
                 AND status IN ('completed', 'paused')""",
            batch_id,
        )
    logger.info(
        "_schedule_callback_from_analysis: call %s → 'Called - Callback Requested' at %s",
        call_uuid, dt_ist.isoformat(),
    )
    return True
```

- [ ] **Update `transcript_analyze` to pass `call_started_at` to the LLM and invoke the safety net**

Find the `transcript_analyze` function. Replace everything from the `# The LLM call is blocking` comment down to the `logger.info("transcript_analyze: ...")` line:

```python
    # The LLM call is blocking; run it in a thread so we don't pin the worker
    # event loop. Gemini SDK is not natively async.
    import asyncio
    from agent.analytics import analyze_transcript_with_llm_async

    # Pass the call's start time so the LLM can resolve relative references
    # like "tomorrow", "kal subah" etc. against the correct date.
    analysis: dict[str, Any] = await analyze_transcript_with_llm_async(
        transcript,
        call_started_at=call.get("started_at") or call.get("created_at"),
    )

    existing = call.get("call_analysis") or {}
    if isinstance(existing, str):
        try:
            existing = json.loads(existing)
        except json.JSONDecodeError:
            existing = {}
    merged = dict(existing) if isinstance(existing, dict) else {}

    for k, v in {
        "follow_up_needed": analysis.get("follow_up_needed", "No"),
        "reminder_date":    analysis.get("reminder_date"),
        "how_to_follow_up": analysis.get("how_to_follow_up"),
        "when_to_follow_up": analysis.get("when_to_follow_up"),
        "lead_quality":     analysis.get("lead_quality") or merged.get("lead_quality"),
        "summary":          f"Category: {analysis.get('category')} | Follow-up: {analysis.get('follow_up_needed')}",
        "callback_requested": analysis.get("callback_requested"),
        "callback_datetime_iso": analysis.get("callback_datetime_iso"),
    }.items():
        if v is not None:
            merged[k] = v

    await db_pool.execute(
        """UPDATE agent_calls
           SET category = $1,
               call_analysis = $2::jsonb,
               updated_at = $3
           WHERE id = $4""",
        analysis.get("category", "Uncategorized"),
        json.dumps(merged),
        now_ist(),
        call_uuid,
    )
    logger.info("transcript_analyze: call %s → %s", call_uuid, analysis.get("category"))

    # ── Safety-net: schedule callback if LLM detected one but agent missed it ──
    # Only fires when:
    #   1. LLM says callback_requested=True
    #   2. scheduled_callback_at is NULL in DB (agent didn't call schedule_callback()
    #      during the live call — Path 1 already handled it if this field is set)
    #   3. A specific datetime was extracted (if only "call later" with no time,
    #      callback_datetime_iso is null and we can't schedule without a time)
    if (
        analysis.get("callback_requested")
        and not call.get("scheduled_callback_at")
        and analysis.get("callback_datetime_iso")
    ):
        logger.info(
            "transcript_analyze: safety-net scheduling callback for call %s at %s",
            call_uuid, analysis.get("callback_datetime_iso"),
        )
        # Re-fetch the call so we have the latest batch_id (it may have
        # been updated between job enqueue and now).
        fresh_row = await db_pool.fetchrow(
            "SELECT batch_id, scheduled_callback_at FROM agent_calls WHERE id = $1",
            call_uuid,
        )
        if fresh_row and not fresh_row["scheduled_callback_at"]:
            fresh_call = dict(fresh_row)
            await _schedule_callback_from_analysis(
                db_pool,
                call_uuid,
                analysis["callback_datetime_iso"],
                fresh_call,
            )
```

Also fix the import at the top of `transcript_analyze` — it currently imports `analyze_transcript_with_llm` (sync). Remove that lazy import since we now import inside the function body:

```python
    # (remove the old import line)
    # from agent.analytics import analyze_transcript_with_llm   ← DELETE THIS LINE
```

The final `transcript_analyze` function should have no `from agent.analytics import ...` at the top-level of the function (the import is now inside the function body as shown above).

- [ ] **Verify**

```bash
grep -n "_schedule_callback_from_analysis\|callback_requested\|callback_datetime_iso\|call_started_at" backend/services/job_handlers.py
```

Expected: all four strings appear. `_schedule_callback_from_analysis` appears as both a definition and a call site.

- [ ] **Commit**

```bash
git add backend/services/job_handlers.py
git commit -m "feat(jobs): safety-net callback scheduling from LLM transcript analysis"
```

---

## Task 6 — dispatcher.py: accept both status names

**Files:**
- Modify: `backend/services/dispatcher.py:266-276` (run() query)
- Modify: `backend/services/dispatcher.py:631-636` (_place_real_call return)

- [ ] **Widen the dispatcher query to include `"Called - Callback Requested"`**

Open `backend/services/dispatcher.py`. In `Dispatcher.run()`, find the `pending_rows = await self.db_pool.fetch(...)` and update the `WHERE` clause:

```python
        pending_rows = await self.db_pool.fetch(
            """SELECT * FROM agent_calls
                WHERE batch_id = $1
                  AND (
                    status = 'Pending'
                    OR (
                      status IN ('Scheduled', 'Called - Callback Requested')
                      AND (scheduled_callback_at IS NULL OR scheduled_callback_at <= NOW())
                    )
                  )
                ORDER BY COALESCE(scheduled_callback_at, created_at) ASC
                LIMIT $2""",
            self.call_batch_id,
            MAX_CALLS_PER_RUN,
        )
```

- [ ] **Update `_place_real_call` to treat `"Called - Callback Requested"` as soft-success**

Find the return block at the end of `_place_real_call`:

```python
        # Poll until LiveKit reports the call complete (or timeout)
        result = await self.wait_for_call_completion(str(call_uuid), room_name)
        if result:
            fs = result.get("status", "Unknown")
            # Treat both callback-status names as soft-success: trunk cooldown
            # applies, SSE shows 'completed', no DB status overwrite.
            if fs in ("Scheduled", "Called - Callback Requested"):
                return True
            return fs in ("Called", "Completed", "Called - Interested", "Called - Not Interested")
        return False
```

- [ ] **Verify**

```bash
grep -n "Scheduled\|Called - Callback Requested" backend/services/dispatcher.py
```

Expected: the query contains `IN ('Scheduled', 'Called - Callback Requested')` and the return check contains the same pair.

- [ ] **Commit**

```bash
git add backend/services/dispatcher.py
git commit -m "feat(dispatcher): pick up 'Called - Callback Requested' rows alongside legacy 'Scheduled'"
```

---

## Task 7 — batch.py: remaining-calls + batch_status endpoint

**Files:**
- Modify: `backend/agent/batch.py:297-299` (remaining count in `process_batch_run`)
- Modify: `backend/agent/batch.py:603` (`batch_status` pending count)

- [ ] **Update the remaining-calls check in `process_batch_run`**

Open `backend/agent/batch.py`. Find the remaining count query inside the `finally:` block:

```python
            remaining = await _state.db_pool.fetchval(
                """SELECT COUNT(*) FROM agent_calls
                    WHERE batch_id = $1
                      AND status IN ('Pending', 'Scheduled', 'Called - Callback Requested')""",
                call_batch_id,
            )
```

- [ ] **Update the `batch_status` endpoint pending count**

In the same file find the `pending_count` line in `batch_status`:

```python
    pending_count = await _count(
        " AND status IN ('Pending', 'Calling', 'Scheduled', 'Called - Callback Requested')"
    )
```

- [ ] **Verify**

```bash
grep -n "Called - Callback Requested\|Scheduled" backend/agent/batch.py
```

Expected: both places now include `'Called - Callback Requested'` alongside `'Scheduled'`.

- [ ] **Commit**

```bash
git add backend/agent/batch.py
git commit -m "feat(batch): include 'Called - Callback Requested' in remaining-calls + status counts"
```

---

## Task 8 — Frontend: status badge + scheduled time sub-label

**Files:**
- Modify: `frontend/components/ops/CallDetailDialog.tsx:391-398`
- Modify: `frontend/app/ops/calls/page.tsx:49-101` (CallRow interface + STATUS_OPTIONS + status column renderer)

- [ ] **Add amber variant for `"Called - Callback Requested"` in `statusVariant`**

Open `frontend/components/ops/CallDetailDialog.tsx`. Replace the `statusVariant` function:

```typescript
export function statusVariant(s: string): "success" | "warning" | "destructive" | "secondary" | "info" | "callback" {
  if (!s) return "secondary";
  if (s === "Called - Callback Requested") return "callback";
  if (s.startsWith("Called") && s.includes("Interested")) return "success";
  if (s.startsWith("Called")) return "info";
  if (s === "Failed" || s === "Invalid Phone") return "destructive";
  if (s === "Pending" || s === "Scheduled") return "secondary";
  return "warning";
}
```

- [ ] **Wire the `"callback"` variant into the shadcn Badge component**

Open `frontend/components/ui/badge.tsx`. Find the `badgeVariants` `cva` call and add a `callback` variant inside the `variants.variant` object:

```typescript
        callback:
          "border-amber-500/30 bg-amber-500/15 text-amber-400",
```

(Add it alongside the existing `success`, `destructive`, `secondary`, `info`, `warning` entries.)

- [ ] **Add `scheduled_callback_at` to `CallRow` interface in the calls page**

Open `frontend/app/ops/calls/page.tsx`. Find the `CallRow` interface and add the field:

```typescript
interface CallRow {
  // ... existing fields ...
  scheduled_callback_at?: string | null;   // ISO string — present when status="Called - Callback Requested"
}
```

- [ ] **Add `"Called - Callback Requested"` to the `STATUS_OPTIONS` filter list**

In the same file, find `const STATUS_OPTIONS` and add the new value:

```typescript
const STATUS_OPTIONS = [
  "Pending",
  "Calling",
  "Called",
  "Called - Interested",
  "Called - Not Interested",
  "Called - Callback Requested",     // NEW
  "Not Answered",
  "Call Not Connected",
  "Failed",
  "Scheduled",
  "Invalid Phone",
] as const;
```

- [ ] **Update the status column renderer to show callback time sub-label**

In the same file, find the `status` column `render` function and replace it:

```typescript
    {
      key: "status",
      header: "Status",
      render: (r) => {
        const st = r.status || r.call_status || "";
        const isCallback = st === "Called - Callback Requested";
        return (
          <div className="space-y-0.5">
            <Badge variant={statusVariant(st)}>
              {isCallback ? "Callback Scheduled" : st || "—"}
            </Badge>
            {isCallback && r.scheduled_callback_at && (
              <div className="text-[10px] text-amber-400/80 font-mono leading-tight">
                {new Date(r.scheduled_callback_at).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: true,
                })}
              </div>
            )}
          </div>
        );
      },
    },
```

- [ ] **Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only pre-existing unrelated errors — compare with baseline).

- [ ] **Commit**

```bash
git add frontend/components/ops/CallDetailDialog.tsx \
        frontend/components/ui/badge.tsx \
        frontend/app/ops/calls/page.tsx
git commit -m "feat(ui): amber 'Callback Scheduled' badge with scheduled time in calls table"
```

---

## Task 9 — Push + end-to-end smoke test

- [ ] **Push the branch**

```bash
git push origin feature/ops-overhaul-complete
```

- [ ] **Restart the backend**

Stop and restart the FastAPI process so the changed modules reload.

- [ ] **Smoke test — Path 1 (live agent tool)**

Make a real call where the customer says "kal subah 10 baje call karo" (call me tomorrow at 10AM). After the call ends:

```bash
# Query DB for the call
python -c "
import asyncio, asyncpg
async def check():
    pool = await asyncpg.create_pool('postgresql://los_admin:los_dev_pass@localhost:5435/los_form', min_size=1, max_size=1)
    rows = await pool.fetch('''
        SELECT customer_name, status, scheduled_callback_at, callback_reason
        FROM agent_calls
        WHERE callback_reason IS NOT NULL
        ORDER BY created_at DESC LIMIT 5
    ''')
    for r in rows:
        print(dict(r))
    await pool.close()
asyncio.run(check())
"
```

Expected: latest row shows `status='Called - Callback Requested'`, `scheduled_callback_at` set to tomorrow ~10AM IST.

- [ ] **Smoke test — Path 2 (safety net)**

Manually insert a call record simulating a missed `schedule_callback()` call (status=`"Called - Not Interested"`, has transcript with "kal 10 baje", `scheduled_callback_at=NULL`), then trigger the analytics job:

```bash
python -c "
import asyncio, asyncpg, json
from datetime import datetime

async def run():
    pool = await asyncpg.create_pool('postgresql://los_admin:los_dev_pass@localhost:5435/los_form', min_size=1, max_size=1)
    # Find the most recent 'Called - Not Interested' call that has a transcript
    row = await pool.fetchrow('''
        SELECT id, batch_id, started_at FROM agent_calls
        WHERE status = 'Called - Not Interested'
          AND transcript != '[]'::jsonb
          AND scheduled_callback_at IS NULL
        ORDER BY created_at DESC LIMIT 1
    ''')
    if row:
        print(f'Found call: {row[\"id\"]}')
        # Enqueue the analytics job manually
        import uuid as _uuid
        await pool.execute('''
            INSERT INTO call_processing_jobs(id, job_type, payload, status, scheduled_at)
            VALUES ($1, $2, $3, $4, NOW())
        ''', _uuid.uuid4(), 'transcript_analyze',
            json.dumps({'call_id': str(row['id'])}), 'pending')
        print('Job enqueued — wait ~30s then check status')
    else:
        print('No eligible call found')
    await pool.close()
asyncio.run(run())
"
```

Wait ~30 seconds, then check the call status:

```bash
python -c "
import asyncio, asyncpg
async def check():
    pool = await asyncpg.create_pool('postgresql://los_admin:los_dev_pass@localhost:5435/los_form', min_size=1, max_size=1)
    rows = await pool.fetch('SELECT id, status, scheduled_callback_at, callback_reason, call_analysis::text FROM agent_calls WHERE callback_reason = $1 ORDER BY updated_at DESC LIMIT 5', 'user_busy_llm_detected')
    for r in rows:
        print(dict(r))
    await pool.close()
asyncio.run(check())
"
```

Expected: rows show `callback_reason='user_busy_llm_detected'`, `status='Called - Callback Requested'`, `scheduled_callback_at` populated.

- [ ] **Smoke test — UI badge**

Open `http://localhost:3001/ops/calls` in the browser. Any row with status `"Called - Callback Requested"` should display:
- Amber badge labelled "Callback Scheduled"
- Below it, the callback datetime in IST format (e.g. "26 May, 10:00 am")

- [ ] **Smoke test — dispatcher picks up callback when due**

```bash
python -c "
import asyncio, asyncpg
from datetime import datetime, timedelta
import pytz

async def run():
    IST = pytz.timezone('Asia/Kolkata')
    pool = await asyncpg.create_pool('postgresql://los_admin:los_dev_pass@localhost:5435/los_form', min_size=1, max_size=1)
    # Set scheduled_callback_at to 3 minutes from now on a test callback row
    row = await pool.fetchrow('''
        SELECT id, batch_id FROM agent_calls
        WHERE status = 'Called - Callback Requested'
        ORDER BY updated_at DESC LIMIT 1
    ''')
    if row:
        due_at = datetime.now(IST) + timedelta(minutes=3)
        await pool.execute('UPDATE agent_calls SET scheduled_callback_at = \$1 WHERE id = \$2', due_at, row['id'])
        # Ensure batch is running
        await pool.execute(\"UPDATE agent_batches SET status = 'running' WHERE batch_id = (SELECT batch_id FROM agent_calls WHERE id = \$1)\", row['id'])
        print(f'Set callback due at {due_at.isoformat()} — watch dispatcher logs in ~3 min')
    await pool.close()
asyncio.run(run())
"
```

Wait for the next cron tick (≤ 5 minutes). The dispatcher log should show:
```
Dispatcher batch=... starting | pending=1
```
And the call should transition: `"Called - Callback Requested"` → `"Calling"` → final status.

---

## Rollback

If anything breaks, every change is backward compatible with old `"Scheduled"` rows. The only non-reversible part is the status rename in `callbacks.py` (new callbacks write `"Called - Callback Requested"` instead of `"Scheduled"`). To fully revert: `git revert` the commits from Tasks 2–8 in reverse order.
