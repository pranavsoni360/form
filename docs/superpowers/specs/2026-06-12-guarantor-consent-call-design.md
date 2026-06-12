# Guarantor Consent Call System — Design Spec

**Date:** 2026-06-12
**Status:** Approved (design)
**Author:** Adil + Claude

## Goal

Jab customer apna loan form **submit** kare aur usme **guarantor ka naam + phone** ho, to ek automated outbound voice call guarantor ko lage jo Hindi/English/Marathi mein identity confirm kare, batae ki borrower ne unhe guarantor banaya hai, aur **consent (yes/no)** record kare. Result `loan_applications` pe mirror ho aur bank portal + ops mein dikhe.

**Hard constraint:** Existing running system (customer call dispatcher, batches, transcript webhook, analytics cron, dono existing agents) ko **kuch nahi todna**. Sirf additive changes.

## Architecture — Approach B (isolated lane + reuse primitives)

Guarantor calls ka apna table aur apna dispatch cron. Low-level calling primitives (`_acquire_trunk_from_db`, `_release_trunk_to_db`, LiveKit room create, agent dispatch, SIP) aur shared `agent_core` reuse. Existing `Dispatcher` class, `agent_calls`, `agent_batches`, `/api/agent/transcript` — untouched.

```
Customer form submit (guarantor_name + guarantor_phone present)
   └─> submit endpoint: upsert guarantor_consent_calls row (status='pending')      [backend, additive]
        └─> guarantor_runner cron (every 3 min, calling-hours + emergency-stop gated)
             └─> atomic claim (pending → calling)
                  └─> acquire trunk (shared pool)  ── try ──┐
                       ├─ LiveKit room (metadata: agent_purpose='guarantor_consent', borrower_name, ...)
                       ├─ dispatch agent_name=GUARANTOR_AGENT_NAME
                       ├─ SIP call → guarantor phone
                       └─ bounded wait (poll status, max ~370s)
                  ── finally ── release trunk (decrement active_calls)  ← CRITICAL
        Agent (3rd worker): greeting → identity confirm → loan context → consent? yes/no
             ├─ record_guarantor_consent(consent, note)  → POST /api/guarantor/consent  (immediate)
             └─ end_call → session flush → POST /api/guarantor/transcript (transcript + recording)
        Backend: update guarantor_consent_calls + mirror loan_applications.guarantor_consent
        Frontend: bank app detail + ops call-detail badge
```

## Data model

### New table `guarantor_consent_calls` (migration_v17)

| column | type | notes |
|---|---|---|
| `id` | UUID PK | also used as agent `call_id` in metadata |
| `application_id` | UUID FK loan_applications(id) **UNIQUE** | one consent call per application (idempotent) |
| `bank_id` | UUID | for trunk/reporting |
| `bank_name` | TEXT | resolved from banks at creation, for greeting |
| `guarantor_name` | VARCHAR(255) | whom we call (= metadata.customer_name) |
| `guarantor_phone` | VARCHAR(20) | dial target |
| `borrower_name` | VARCHAR(255) | who named them (= metadata.borrower_name, for script) |
| `loan_amount` | NUMERIC | script context (optional) |
| `language` | VARCHAR(30) DEFAULT 'hindi' | resolved at creation |
| `status` | VARCHAR(30) DEFAULT 'pending' | `pending` / `calling` / `completed` / `no_answer` / `failed` |
| `consent` | VARCHAR(10) | `yes` / `no` / NULL (unclear/unreached) |
| `consent_note` | TEXT | agent-provided reason/clarification |
| `room_name` | VARCHAR(255) | LiveKit room |
| `recording_url` | TEXT | egress recording |
| `transcript` | JSONB DEFAULT '[]' | full transcript |
| `retry_count` | INT DEFAULT 0 | dial attempts |
| `scheduled_at` | TIMESTAMPTZ DEFAULT NOW() | next-eligible dial time (backoff) |
| `started_at`, `ended_at` | TIMESTAMPTZ | call timing |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

Indexes: `(status, scheduled_at)` for the runner pickup; UNIQUE `(application_id)`.

### `loan_applications` — 2 additive columns (migration_v17)

- `guarantor_consent` VARCHAR(10) — mirror: `yes` / `no` / `pending` / NULL
- `guarantor_consent_at` TIMESTAMPTZ — when consent captured

No other `loan_applications` change. `guarantor_name`/`guarantor_phone` already exist (v16).

## Trigger (form submit)

Both endpoints: `POST /api/submit-form` (main.py ~2443-2471) and `POST /api/submit-form-session` (main.py ~3142-3191). **After** status → `submitted` is committed, additive block:

1. Skip if `guarantor_name` empty OR `guarantor_phone` empty.
2. Skip + log if `guarantor_phone` == customer `phone` (don't dial the borrower).
3. Resolve `language`: via `loan_applications.agent_call_id` → `agent_calls.language`; default `hindi` if no linked call.
4. Resolve `bank_name` from `banks` by `bank_id`; default `ABC Bank`.
5. **Upsert** into `guarantor_consent_calls` keyed by `application_id`:
   - No row → INSERT (status `pending`, retry_count 0, scheduled_at NOW()).
   - Row exists & status IN (`pending`,`no_answer`,`failed`) & `guarantor_phone` changed → UPDATE phone + reset to `pending`, retry_count 0 (re-call decision).
   - Row exists & status = `completed` → leave (don't re-call).
6. Wrap in try/except — a guarantor-enqueue failure must **never** break form submission (log + continue).

Trigger is best-effort additive; the runner cron is the source of truth for dialing.

## Dispatch lane (new)

**Module:** `backend/guarantor/runner.py` (+ `dispatch.py`).

**Cron:** registered in `backend/agent/batch.py` `agent_startup()` alongside existing jobs:
`add_job(process_guarantor_run, CronTrigger(minute="*/3", hour=<calling-hours expr>), id="guarantor_runner")`.

`process_guarantor_run()`:
1. Gate: `is_within_calling_hours()` and `not is_emergency_stop_active()` — else return. (Reuse existing fns.)
2. Acquire a lane lock (advisory/lock row) so overlapping ticks don't double-run; OR rely solely on the per-row atomic claim (below). Use per-row claim as the primary guard.
3. Fetch eligible rows: `status='pending' AND scheduled_at <= NOW() AND retry_count < MAX_RETRIES(=3)` ORDER BY scheduled_at LIMIT (concurrency cap).
4. Concurrency cap **2** (semaphore). For each row, `dispatch_guarantor_call(row)`.

`dispatch_guarantor_call(row)`:
1. **Atomic claim:** `UPDATE guarantor_consent_calls SET status='calling', started_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`. If no row returned → another tick took it, skip.
2. `trunk = await _acquire_trunk_from_db(db_pool)` (shared pool, reused).
3. `try:`
   - Generate `room_name`.
   - LiveKit `create_room` with metadata:
     `{customer_name: guarantor_name, phone: guarantor_phone, call_id: row.id, bank_id, language, gender: "male", agent_purpose: "guarantor_consent", bank_name, borrower_name, loan_amount}`.
   - `agent_dispatch.create_dispatch(room=room_name, agent_name=GUARANTOR_AGENT_NAME)`.
   - `create_sip_participant(...)` (same formatting as dispatcher: `+91` prefix if needed).
   - Store `room_name` on row.
   - **Bounded wait:** poll `guarantor_consent_calls.status` until terminal (`completed`/`no_answer`/`failed`) OR timeout ~370s.
   - If timeout/no participant → mark `no_answer`.
4. `except` → mark attempt failed.
5. **`finally:`** `await _release_trunk_to_db(db_pool, trunk, success=<terminal completed>)` — **always**, even on exception. (Prevents trunk `active_calls` leak that would throttle customer calls.)
6. Dispatch does NOT do retry. `_claim` increments `retry_count` (= attempts made). The call outcome is set by the webhook (`completed`/`no_answer`); dispatch only marks `failed` when the webhook never finalized, guarded by `WHERE status='calling'` so a webhook-set terminal is never clobbered.

**Retry (owned by the runner, Task 4):** each tick, before dispatching fresh `pending` rows, the runner promotes retryable terminals — `status IN ('no_answer','failed') AND retry_count < MAX_ATTEMPTS(=3) AND ended_at <= NOW() - backoff(retry_count)` (backoff 5/15 min) → back to `pending`. So an unanswered call retries up to 3 total attempts. After max attempts it stays terminal (consent NULL = unreached). APScheduler `max_instances=1` + the atomic claim make overlapping ticks safe.

**State machine:**
```
pending ──claim(retry_count++)──> calling ──> completed (consent yes/no)   [terminal]
                                          ├─> no_answer (webhook, empty transcript)
                                          └─> failed    (dispatch, webhook never finalized)
   runner promotes no_answer/failed (retry_count < 3, past backoff) ──> pending
```

## Agent side

**New prompt:** `agent/prompts_guarantor.py` → `build_guarantor_consent_instructions(session)` (Hindi/English/Marathi). Flow:
1. (Greeting already done by agent_core: "Hello, this is {agent} from {bank}, recorded for quality. Am I speaking with {guarantor}?")
2. Identity confirm → if "wrong person/not me" → end_call (note: unreached).
3. Context: "{borrower_name} ne aapko {loan_amount} ke loan ke liye guarantor banaya hai."
4. Consent ask (once): "Kya aap guarantor banne ke liye sehmat hain — haan ya na?"
   - Clear yes → `record_guarantor_consent("yes")` → thank → end_call.
   - Clear no → `record_guarantor_consent("no", reason)` → acknowledge → end_call.
   - Unclear/ambiguous → rephrase once; still unclear → `record_guarantor_consent("", note)` (leave NULL) → end_call.
5. TTS rules same as existing prompts (numbers as words, no emoji, Devanagari/Roman only).

**agent_core.py** (entrypoint, lines ~309-327): add 3rd branch:
```
elif agent_purpose == "guarantor_consent":
    instructions = build_guarantor_consent_instructions(session)
    tools = [record_guarantor_consent, end_call]   # minimal — NO send_form_link/collect_all_data
```
Greeting block (346-368) unchanged (generic, reused).

**tools.py:** add `record_guarantor_consent(context, consent: str = "", note: str = "")` → sets `session.guarantor_consent` / `session.guarantor_consent_note`; optionally POST immediately to `/api/guarantor/consent` for robustness against drops. Existing tools untouched.

**session.py** (additive only):
- `__init__`: `self.borrower_name = metadata.get("borrower_name", "")`; `self.guarantor_consent = None`; `self.guarantor_consent_note = None`. (`loan_amount` already an attr; set from metadata for this purpose.)
- `_send_transcript`: branch — `if self.agent_purpose == "guarantor_consent"`: POST to `{BACKEND_URL}/api/guarantor/transcript` with payload `{room, call_id, transcript, message_count, recording_path, consent, consent_note}`. Else existing loan payload/URL unchanged. All other machinery (recording, silence monitor, shutdown flush, 3-retry) reused as-is.

**New worker:** `agent/guarantor_consent.py` entry-point shim (copy of `union_bank_los.py`, `AGENT_NAME=os.getenv("GUARANTOR_AGENT_NAME", "guarantor-consent")`), delegates to `agent_core.entrypoint`. New systemd service `los-agent-guarantor`.

## Backend endpoints (new)

- `POST /api/guarantor/consent` — `{call_id, consent, note}` → update row `consent`, `consent_note`; mirror `loan_applications.guarantor_consent` + `guarantor_consent_at`. No-JWT webhook (like transcript).
- `POST /api/guarantor/transcript` — `{room, call_id, transcript, recording_path, consent, consent_note}` → update row transcript/recording_url/status=`completed`, set ended_at; mirror consent to loan_applications if not already. Idempotent (`transcript_sent`-style guard via status).
- (display) reuse existing app-detail fetch — mirrored fields already on `loan_applications`. Optional `GET /api/guarantor/call/{application_id}` for richer ops view (only if needed).

## Frontend

- **Bank app detail** (`frontend/app/bank/applications/[id]/page.tsx`) — existing Guarantor section: add "Consent" field → ✅ Yes / ❌ No / ⏳ Pending (from `app.guarantor_consent`).
- **Ops call detail** (`frontend/components/ops/CallDetailDialog.tsx`) — add a "Guarantor Consent" badge from the mirrored field (via the linked application).
- Interfaces: add `guarantor_consent?: string` where the detail types live.

## Language & gender

- Language resolved at submit (linked agent_call → else hindi), stored on row.
- Agent **voice** gender defaults `male` (Amit/shubh) — independent of guarantor's actual gender; only affects agent self-reference verb conjugation.

## Edge cases

- No guarantor details → no row, no call.
- guarantor_phone == customer phone → skip + log.
- Duplicate submit (same number) → UNIQUE idempotent, no duplicate call.
- Re-submit with changed number, not yet completed → re-call (reset pending).
- No linked agent_call → language = hindi.
- Outside calling hours / emergency stop → row waits; runner picks when allowed.
- Guarantor doesn't answer / drops → `no_answer` → retry up to 3 → terminal, consent NULL = "unreached" (shown as Pending/Unreached).
- Ambiguous answer → consent NULL + note; transcript saved for human review.
- Agent forgets tool → consent NULL, transcript saved (future: transcript-parse backup job).

## What stays UNTOUCHED (constraint)

- `Dispatcher` class, `agent_batches`, customer `agent_calls` flow.
- `/api/agent/transcript` webhook + its payload.
- Analytics cron (operates on `agent_calls`; guarantor data is a separate table → no pollution).
- Both existing agents/workers/prompts (guarantor is a 3rd worker).
- `agent_type` CHECK constraint (guarantor doesn't use `agent_calls`).

## Config / ops

- Env: `GUARANTOR_AGENT_NAME` (backend dispatch + agent `.env.local`, same value); `GUARANTOR_MAX_RETRIES` (default 3), `GUARANTOR_CONCURRENCY` (default 2) — optional.
- systemd: new `los-agent-guarantor.service` (EnvironmentFile = agent `.env.local`).
- `scripts/deploy.sh`: add `los-agent-guarantor` to restart list + health check.
- Migration `migration_v17_guarantor_consent.sql` runs via deploy migration step.

## Out of scope (future)

- Transcript-parse backup for consent when tool not called.
- Guarantor SMS/WhatsApp consent fallback.
- Dedicated guarantor phone pool (currently shared + concurrency cap 2).
- Re-calling after a `no` to reconfirm.
