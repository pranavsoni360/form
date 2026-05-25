# LLM-Detected Callback Scheduling — Design Spec
**Date:** 2026-05-25  
**Status:** Approved  

---

## Problem

When a customer says "call me back tomorrow at 10AM", the voice agent may call `schedule_callback()` during the live call (primary path). But if the agent misses this — due to conversation flow or LLM omission — the call ends with status `"Called - Not Interested"` and the callback is silently dropped.

Additionally, the status column in the calls table only shows "Interested" or "Not Interested". Operators have no distinct signal that a call ended as a scheduled callback.

---

## Goals

1. Add `"Called - Callback Requested"` as a first-class status visible in the calls table (orange/amber pill).
2. Post-call LLM analysis detects callback intent from the transcript and auto-schedules if the live agent missed it.
3. No existing call flows break — purely additive changes.

---

## Non-Goals

- Replacing the live `schedule_callback()` agent tool (stays as primary path).
- Preserving original call transcript after callback completes (callback transcript overwrites — Option A).
- Adding a separate DB row per callback round (single record, reused).

---

## Architecture

### Two Scheduling Paths (Defense in Depth)

```
CALL ENDS
    │
    ├─► Path 1 (Primary): Agent called schedule_callback() during live call
    │       └─ callbacks.py already set status="Called - Callback Requested"
    │              + scheduled_callback_at (fixed in previous session)
    │
    └─► Path 2 (Safety Net): Agent missed the tool call
            └─ transcript.py sets status="Called - Not Interested"
                   └─ transcript_analyze job runs (Gemini)
                          └─ detects callback_requested=true
                                 └─ extracts callback_datetime_iso from transcript
                                        └─ schedules → status="Called - Callback Requested"
                                               + scheduled_callback_at set
```

### When Callback Actually Fires

```
Cron (every 5 min) → finds "Called - Callback Requested" with scheduled_callback_at ≤ NOW()
    → Dispatcher dials → status="Calling"
    → Voice agent runs callback call
    → Transcript webhook fires → status="Called - Interested" or "Called - Not Interested"
    → Analytics runs on final outcome
```

---

## File-by-File Changes

### 1. `backend/agent/state.py`

Add `"Called - Callback Requested"` to `STATUS_OPTIONS`. Keep `"Scheduled"` for backward compatibility with existing rows.

```python
STATUS_OPTIONS = [
    "Pending", "Calling", "Called", "Called - Interested", "Called - Not Interested",
    "Called - Callback Requested",          # NEW
    "Not Answered", "Call Not Connected", "Failed", "Scheduled", "Invalid Phone",
]
```

---

### 2. `backend/agent/callbacks.py` — `POST /api/agent/schedule-callback`

Change the DB UPDATE to use the new status name.

**Before:**
```python
SET status = 'Scheduled',
```

**After:**
```python
SET status = 'Called - Callback Requested',
```

---

### 3. `backend/agent/transcript.py`

Update the preserve-check to handle both old (`"Scheduled"`) and new (`"Called - Callback Requested"`) status names, so a backend restart with old DB rows doesn't break.

**Before:**
```python
if existing_status == "Scheduled":
    status = "Scheduled"
```

**After:**
```python
CALLBACK_STATUSES = {"Scheduled", "Called - Callback Requested"}
if existing_status in CALLBACK_STATUSES:
    status = existing_status   # preserve whichever variant is in the DB
```

Same treatment for the `category` preserve-check.

---

### 4. `backend/agent/analytics.py` — Extended LLM Prompt

Extend `analyze_transcript_with_llm_async` to output two new fields.

**Prompt addition:**

> Also detect if the customer requested a callback:
> - `callback_requested`: true if customer said they are busy / asked to be called back at a specific time; false otherwise.
> - `callback_datetime_iso`: ISO 8601 IST datetime string for when the customer wants the callback (e.g. "2026-05-26T10:00:00+05:30"). Extract from what the customer said, using `{call_date}` as today's reference date. Return null if callback_requested is false or no time was mentioned.

The call's `started_at` date (formatted as YYYY-MM-DD) is injected as `{call_date}` in the prompt so relative references ("tomorrow", "Monday") resolve correctly.

**Updated JSON schema:**
```json
{
  "category": "...",
  "reminder_date": "YYYY-MM-DD or null",
  "follow_up_needed": "Yes or No",
  "how_to_follow_up": "...",
  "when_to_follow_up": "...",
  "lead_quality": "hot/warm/cold",
  "loan_type": "...",
  "callback_requested": true,
  "callback_datetime_iso": "2026-05-26T10:00:00+05:30"
}
```

Default (when GEMINI unavailable): `callback_requested: false, callback_datetime_iso: null`.

---

### 5. `backend/services/job_handlers.py` — `transcript_analyze`

After receiving LLM analysis results, add the safety-net scheduling block:

```python
# Safety net: if LLM detected a callback but the agent never called
# schedule_callback() during the live call (scheduled_callback_at is NULL),
# schedule it now from the extracted datetime.
if analysis.get("callback_requested") and not call.get("scheduled_callback_at"):
    cb_iso = analysis.get("callback_datetime_iso")
    if cb_iso:
        # Reuse the same clamping + batch-reactivation logic from callbacks.py
        await _schedule_callback_from_analysis(db_pool, call_uuid, cb_iso, call)
```

`_schedule_callback_from_analysis` is a new thin helper (in `job_handlers.py`) that:
1. Parses + clamps `cb_iso` to calling hours (same logic as `callbacks.py`)
2. Updates `agent_calls` SET `status='Called - Callback Requested'`, `scheduled_callback_at`, `callback_reason='user_busy_llm_detected'`
3. Reactivates the parent batch (same SQL as `callbacks.py`)

The idempotency guard already at the top of `transcript_analyze` (`current_category != 'Uncategorized'`) prevents double-scheduling if the job runs twice.

**Analytics sweep inclusion:** Add `"Called - Callback Requested"` to the sweep's status filter so calls where the agent set the status live (Path 1) also get their `category` and `lead_quality` populated:

```python
AND status IN ('Called', 'Completed', 'Called - Interested', 'Called - Not Interested',
               'Called - Callback Requested')   # NEW: categorize initial callback calls too
```

---

### 6. `backend/services/dispatcher.py` — `run()` query

Support both status names so old `"Scheduled"` rows continue working during rollout.

**Before:**
```sql
OR (status = 'Scheduled' AND (scheduled_callback_at IS NULL OR scheduled_callback_at <= NOW()))
```

**After:**
```sql
OR (status IN ('Scheduled', 'Called - Callback Requested')
    AND (scheduled_callback_at IS NULL OR scheduled_callback_at <= NOW()))
```

Also update `_place_real_call` return check:
```python
if fs in ("Scheduled", "Called - Callback Requested"):
    return True   # soft-success; trunk cooldown applies
```

---

### 7. `backend/agent/batch.py` — Remaining-calls check

```python
"SELECT COUNT(*) FROM agent_calls WHERE batch_id = $1"
"AND status IN ('Pending', 'Scheduled', 'Called - Callback Requested')"
```

---

### 8. Frontend — Calls Table Badge

File: `frontend/app/ops/calls/page.tsx` (or shared `StatusBadge` component).

Add badge variant for `"Called - Callback Requested"`:
- Color: amber/orange (`bg-amber-500/15 text-amber-400 border-amber-500/30`)
- Label: "Callback Scheduled"
- Sub-label: show `scheduled_callback_at` formatted as "Mon 26 May, 10:00 AM" when present

The `/ops/callbacks` page already lists these — no changes needed there.

---

## Data Flow: Safety-Net Path (End-to-End)

```
1. Customer says: "abhi busy hoon, kal subah 10 baje call karo"
2. Agent does NOT call schedule_callback() — misses the tool
3. Agent calls end_call("user_busy")
4. transcript.py saves transcript → status = "Called - Not Interested" (customer_interested=False)
5. transcript.py enqueues transcript_analyze job
6. Job worker picks it up → calls Gemini with transcript + call_date="2026-05-25"
7. Gemini returns: {callback_requested: true, callback_datetime_iso: "2026-05-26T10:00:00+05:30"}
8. Handler: scheduled_callback_at is NULL → calls _schedule_callback_from_analysis()
9. DB: status="Called - Callback Requested", scheduled_callback_at="2026-05-26T10:00:00+05:30"
10. Batch reactivated → status="running"
11. Next day, cron fires → dispatcher picks up the row → dials callback
12. Callback completes → transcript overwrites → status="Called - Interested" / "Not Interested"
```

---

## Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| Existing `status='Scheduled'` rows in DB | Dispatcher still picks them up (both statuses in query) |
| `transcript.py` sees old `status='Scheduled'` | Preserved (updated check covers both) |
| Calls already marked `"Called - Not Interested"` with no transcript | Analytics sweep won't re-analyze (no transcript) |
| Analytics job runs twice on same call | Idempotency guard (`category != 'Uncategorized'`) blocks second scheduling |

---

## Verification

1. **Live agent path**: Do a test call where customer says "kal 10 baje call karo" → agent calls `schedule_callback()` → DB immediately shows `status='Called - Callback Requested'` with `scheduled_callback_at` set → `/ops/callbacks` shows the row with amber pill.
2. **Safety-net path**: Manually insert a call with status `'Called - Not Interested'` and a transcript containing callback intent → trigger analytics job → confirm status flips to `'Called - Callback Requested'` with correct `scheduled_callback_at`.
3. **Callback fires**: Set `scheduled_callback_at` to 2 minutes from now on a test row → confirm cron picks it up and dials.
4. **Old rows**: Confirm any existing `'Scheduled'` rows are still dispatched by the cron.
5. **UI**: Calls table shows amber "Callback Scheduled" pill with time for affected rows.
