# Vaani LOS — Technical Documentation

**System:** Multi-tenant Loan Origination System (LOS) with autonomous outbound voice-AI agents
**Repo:** `vaani_los_form` · **Last updated:** 2026-06-18

> This document describes the full architecture, structure, end-to-end flows, and the specific technical decisions of the platform. It is written for an engineer with no prior context on the codebase.

---

## 1. What the system does

The platform automates the **top of a loan funnel** for banks/NBFCs using AI voice agents:

1. An operator uploads a list of leads (CSV/Excel).
2. A dispatcher places **outbound phone calls** via SIP trunks; an AI voice agent (Hindi/Marathi/English) talks to each customer, qualifies them, and (if interested) sends a WhatsApp **application-form link**.
3. The customer fills a multi-step **loan application form** (OTP-secured).
4. For personal loans **above ₹1 lakh**, a separate AI agent calls the customer's **guarantor** to record consent.
5. Bank **officers** and **supervisors** review/approve applications; approved loans can be assigned to **vendors** (NBFC partners) for disbursement.
6. Everything is observable in real time via an **Ops console** (live calls, funnel, analytics, errors, phone-pool health).

It is **multi-tenant**: a single deployment serves multiple banks, each seeing only its own data.

---

## 2. Technology stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14 (App Router, React, TypeScript), Server Components, SSE for realtime |
| **Backend** | Python 3.12, FastAPI, `asyncpg` (raw SQL, no ORM), APScheduler |
| **Voice agents** | `livekit-agents` 1.3.11 (Python), self-hosted LiveKit |
| **STT / LLM / TTS** | Deepgram `nova-3` / Gemini `2.5-flash` + Groq fallback / Sarvam `bulbul:v3` · Silero VAD |
| **Database** | PostgreSQL (Dockerized) |
| **Telephony** | LiveKit SIP + outbound SIP trunks (Twilio, Vobiz) |
| **Recording** | LiveKit Egress (OGG audio) |
| **Messaging** | WhatsApp via AiSensy campaigns |
| **Infra** | Docker / Docker Compose, systemd, Nginx, GitHub Actions CI/CD |
| **Observability** | Server-Sent Events bus, Sentry/GlitchTip (optional), structured JSON logs |

---

## 3. Infrastructure & deployment topology

All services run on a single GPU host (`root@164.52.217.236`), repo at `/root/vaani_los_form`, branch `master`. Public entry: `finix.vgipl.com` via Nginx.

```
                              Internet (finix.vgipl.com via Nginx)
                                   │            │
                          /api → :8200     / → :3001
                                   │            │
   ┌───────────────────────────────────────────────────────────────────────┐
   │ HOST 164.52.217.236                                                     │
   │                                                                         │
   │  systemd: los-backend (FastAPI :8200)   los-frontend (Next.js :3001)    │
   │  systemd voice agents (livekit-agents):                                 │
   │     los-agent-pusad     (loan_enquiry,     HTTP :8082)                  │
   │     los-agent-union     (account_opening,  HTTP :8081)                  │
   │     los-agent-guarantor (guarantor_consent,HTTP :8083)                  │
   │                                                                         │
   │  DOCKER:                                                                │
   │     vaani-los-postgres  (PostgreSQL, db=los_form, user=los_admin :5434) │
   │     livekit-server (:7880)  livekit-sip  livekit-egress  livekit-redis  │
   └───────────────────────────────────────────────────────────────────────┘
                                   │ SIP (UDP)
                          Outbound SIP trunks → PSTN
                          (Twilio: +1…,  Vobiz: +91…)
```

- **Backend** and **agents** share the same PostgreSQL instance.
- **Agents** connect to LiveKit at `ws://127.0.0.1:7880` and register by `agent_name`.
- Recordings are written by LiveKit Egress to `/recordings/<room>.ogg`.

---

## 4. Repository structure

```
vaani_los_form/
├── backend/                      # FastAPI application
│   ├── main.py                   # App entry: forms, OTP, auth, admin, autosave, submit, mock seeder
│   ├── agent_routes.py           # APIRouter(prefix="/api/agent") — aggregates the agent sub-routers
│   ├── db_migrations.py          # Migration application helper
│   ├── agent/                    # Outbound-calling domain
│   │   ├── state.py              #   global db_pool, calling-hours, emergency-stop, RECORDING_BASE_URL, helpers
│   │   ├── batch.py              #   APScheduler setup, upload-excel, batch-call, process_batch_run, wait_for_call_completion
│   │   ├── transcript.py         #   POST /api/agent/transcript  (voice-agent webhook → updates agent_calls)
│   │   ├── calls.py              #   call list / detail / stats endpoints
│   │   ├── callbacks.py          #   scheduled-callback endpoints
│   │   ├── analytics.py          #   transcript categorization cron sweep
│   │   └── whatsapp.py           #   AiSensy form-link send + loan_application creation from a call
│   ├── services/
│   │   ├── dispatcher.py         #   Dispatcher class + trunk acquire/release + _to_e164 + SIP dialing
│   │   ├── job_worker.py         #   durable job queue (call_processing_jobs) + worker pool
│   │   └── job_handlers.py       #   handler registry (transcript_analyze, …)
│   ├── routers/
│   │   ├── ops.py                #   /ops REST APIs (dashboards)
│   │   ├── realtime.py           #   SSE stream (/events) for live ops
│   │   ├── internal.py           #   HMAC-signed internal endpoints (error ingest, etc.)
│   │   └── vendors.py            #   vendor (NBFC) portal APIs
│   ├── guarantor/                # Guarantor consent-call subsystem (isolated)
│   │   ├── trigger.py            #   enqueue a consent call on form submit
│   │   ├── dispatch.py           #   one consent call: claim → trunk → SIP → wait → release
│   │   ├── runner.py             #   cron lane: reclaim → retry-promote → dispatch
│   │   └── routes.py             #   /api/guarantor/consent + /transcript webhooks
│   └── lib/
│       ├── event_bus.py          #   in-process pub/sub → SSE
│       ├── notifier.py           #   ops alerts (Telegram etc., rate-limited)
│       ├── circuit_breaker.py    #   `protect()` wrapper around flaky external calls
│       ├── retry.py              #   retry helpers
│       └── logging_config.py     #   structured JSON logging
│
├── agent/                        # Voice agents (livekit-agents)
│   ├── agent_core.py             # ALL agent logic: entrypoint(), AgentSession, pipeline, greeting, monitors
│   ├── session.py                # LoanEnquirySession: per-call state, recording, transcript POST
│   ├── tools.py                  # function tools: send_form_link, end_call, schedule_callback, collect_all_data, record_guarantor_consent
│   ├── prompts.py                # loan-enquiry prompts (Hindi/Marathi/English)
│   ├── prompts_account.py        # account-opening prompts
│   ├── prompts_guarantor.py      # guarantor-consent prompts
│   ├── config.py                 # BACKEND_URL, IST, LANG_CONFIG, GENDER_CONFIG, normalize_mobile()
│   ├── union_bank_los.py         # entry shim → AGENT_NAME=union-bank-account-opening (:8081)
│   ├── los_updated.py            # entry shim → AGENT_NAME=pusad-bank-loan-enquiry-enhanced (:8082)
│   ├── guarantor_consent.py      # entry shim → AGENT_NAME=guarantor-consent (:8083)
│   ├── los_error_reporter.py     # lifts logger.error / exceptions to backend /api/internal/errors
│   ├── ensure_trunks.py / verify_trunk.py / create_twilio_trunk.py
│   ├── add_vobiz_phone_to_db.py / sync_all_phone_trunk_ids.py   # trunk/phone provisioning utilities
│   └── loan_agent.py / los_agent.py                              # deprecated older variants
│
├── frontend/                     # Next.js 14 app (see §13)
│   └── app/…                     # /loan-form, /bank, /ops, /admin, /vendor, /form/[token]
│
├── database/
│   ├── schema.sql                # base schema
│   └── migration_v2 … v17        # incremental migrations (applied in order at deploy)
│
├── scripts/
│   ├── deploy.sh                 # full install + --update + --migrate-only
│   ├── los-agent-{pusad,union,guarantor}.service   # systemd units
│   ├── los-backend.service / los-frontend.service
│   └── los-trunk-watchdog.* / gpu-error-tailer.*
└── docs/                         # specs, plans, this document
```

---

## 5. Database layer

PostgreSQL, accessed with raw parameterized SQL via `asyncpg` (no ORM). `gen_random_uuid()` / `uuid_generate_v4()` for IDs. Schema evolves through ordered migration files (`schema.sql` first, then `migration_v2 … v17`), applied at deploy time by globbing `database/migration*.sql`.

### Core tables

**Form / application domain**
- `banks` — tenant records (`id, name, code, contact_*, status`).
- `form_tokens` — one-time tokens for the customer form link (`token, customer_name, phone, loan_id, bank_id, is_used, form_status`).
- `loan_sessions` — session-token based form sessions.
- `loan_applications` — **the central application record**. Personal/employment/KYC fields, document URLs, `status`, `current_step`, `bank_id`, `agent_call_id`, `loan_amount_requested`, `guarantor_name`, `guarantor_phone`, `guarantor_consent`, `guarantor_consent_at`, `consumer_loan_type`, timestamps.
- `status_transitions` — audit trail of every status change (`from_status, to_status, changed_by_type, changed_by_id, notes`).
- `field_sources` — provenance per field (e.g. "agent_call" vs manual) → drives "Voice Call" badges in the UI.

**Outbound calling domain**
- `agent_calls` — one row per outbound customer call: `customer_name, phone, language, agent_type` (`loan_enquiry`|`account_opening`), `status`, `room_name`, `transcript` (JSONB), `recording_url`, `collected_data` (JSONB), `call_analysis` (JSONB), `interested`, `form_sent`, `category`, `retry_count`, `scheduled_callback_at`, `callback_reason`, timestamps.
- `agent_batches` — an uploaded lead batch: `batch_id, bank_id, total_records, status` (`pending`/`running`/…), `agent_type`, `preferred_phone_id`.
- `phone_pools` — a pool of caller-ID numbers: `capacity`, `cooldown_seconds_min/max`.
- `phone_numbers` — caller-ID numbers: `phone_number`, `livekit_trunk_id`, `active_calls`, `total_calls`, `cooldown_until`, `status`, `last_failure_reason`.
- `call_processing_jobs` — durable async job queue (see §8).

**Guarantor domain (v17)**
- `guarantor_consent_calls` — isolated table for consent calls (see §11.3).

**Vendor / monitoring**
- `vendors`, vendor assignment/settlement tables (NBFC partners).
- `system_errors` — ingested errors surfaced in `/ops/errors`.

### `agent_calls.status` values
`Pending → Calling → {Called - Interested | Called - Not Interested | Called - Callback Requested | Scheduled | Not Answered | Failed | Invalid Phone}`

### `loan_applications.status` values
`draft → submitted → system_reviewed → {officer_approved | officer_rejected} → documents_submitted → {approved | supervisor_rejected}`

---

## 6. Backend layer (FastAPI)

`main.py` builds the FastAPI app and mounts routers. On startup it creates the asyncpg pool, a **dedicated job-worker pool**, starts the APScheduler jobs, and registers all routers.

### Router map
| Mount | Source | Responsibility |
|---|---|---|
| `/api/...` (root) | `main.py` | customer form, OTP, autosave, submit, auth (bank/admin), admin review |
| `/api/agent/*` | `agent_routes.py` → `agent/*` | batch upload/call, transcript webhook, calls list/detail, callbacks, whatsapp |
| `/api/guarantor/*` | `guarantor/routes.py` | consent + transcript webhooks |
| `/ops/*` | `routers/ops.py` | ops dashboard REST |
| `/events` (SSE) | `routers/realtime.py` | realtime stream |
| `/api/internal/*` | `routers/internal.py` | HMAC-signed internal (error ingest) |
| `/api/vendor*` | `routers/vendors.py` | NBFC vendor portal |

### Key conventions
- **Auth:** bank users authenticate at `POST /api/auth/bank-login` (bcrypt, username-based, JWT in localStorage). Admin at `/admin/login`. Voice-agent webhooks (`/api/agent/transcript`, `/api/guarantor/*`) are **unauthenticated** by design (internal trust) — the operator-facing `upload-excel`/`batch-call` are also operator-open.
- **DB access:** module-global pool exposed as `agent.state.db_pool`; modules do `from agent import state as _state` then `_state.db_pool`.
- **Resilience:** external calls (LiveKit, SIP) are wrapped in `lib.circuit_breaker.protect(...)` with timeouts; ops-visible failures go through `lib.notifier.notify(...)` (rate-limited).

---

## 7. Voice agent layer

### 7.1 Shared-core pattern
All three agents are the **same code** (`agent_core.entrypoint`). Three thin entry-point shims differ only by `AGENT_NAME` and HTTP port:

| Shim | AGENT_NAME | Port | Purpose |
|---|---|---|---|
| `los_updated.py` | `pusad-bank-loan-enquiry-enhanced` | 8082 | loan enquiry |
| `union_bank_los.py` | `union-bank-account-opening` | 8081 | account opening |
| `guarantor_consent.py` | `guarantor-consent` | 8083 | guarantor consent |

Each shim runs `cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME, port=…))` inside a `while True` auto-restart loop (5s backoff). Behavior is chosen **at runtime** from the LiveKit room metadata field `agent_purpose`:
- `account_opening` → `prompts_account.build_account_opening_instructions` + tools `[send_form_link, end_call, schedule_callback, collect_all_data]`
- `guarantor_consent` → `prompts_guarantor.build_guarantor_consent_instructions` + **minimal** tools `[record_guarantor_consent, end_call]`
- otherwise (default `loan_enquiry`) → `prompts.build_loan_enquiry_instructions` + full loan tools

### 7.2 Media pipeline (in `agent_core.entrypoint`)
```
STT : Deepgram nova-3 (language hi/en; Marathi uses hi STT + mr-IN TTS), interim_results=True
LLM : FallbackAdapter([ Gemini 2.5-flash (temp 0.4, thinking_budget=0, http timeout 10s),
                        Groq llama-3.3-70b-versatile, Groq llama-3.1-8b-instant ])
TTS : Sarvam bulbul:v3 (speaker shubh/pooja, pace 1.06, 22050 Hz) — wrapped for 30s WS receive timeout
VAD : Silero (min_speech 0.20, min_silence 0.03, activation_threshold 0.50)
```

### 7.3 Latency-critical `AgentSession` parameters
```python
AgentSession(
    preemptive_generation=True,        # LLM starts before user finishes — biggest latency win
    min_endpointing_delay=0.13,        # 130 ms after silence → respond
    max_endpointing_delay=2.5,
    min_interruption_duration=0.35,
    discard_audio_if_uninterruptible=True,
)
```

### 7.4 "Gold config" (validated production tuning)
The single biggest latency lever is the LLM. The validated config:
- **Gemini 2.5-flash with billing ON** (free-tier throttling caused 503s + variable 5–40 tok/s + `finish_reason: None` empties → multi-second stalls).
- `thinking_budget=0` (thinking off — mandatory for realtime voice).
- `http_options timeout=10s` (a hung Gemini fails over to Groq fast, not 30s of dead air).
- A `503 "high demand"` from Gemini is an **instant** error → FallbackAdapter switches to Groq in ~1s (no dead air).

### 7.5 Greeting (time-to-first-audio optimization)
A **hardcoded split greeting** bypasses the LLM for the opening (so the customer hears audio immediately):
- Part 1 (intro + recording disclaimer): `allow_interruptions=False`.
- 200 ms pause.
- Part 2 (identity confirm "Am I speaking with X?"): `allow_interruptions=True`.

Both `add_to_chat_ctx=True`, so the LLM sees the greeting in context — which is why each prompt contains an `OPENING:` directive telling the LLM **not** to re-introduce itself (prevents the old double-greeting bug).

### 7.6 Session lifecycle (`LoanEnquirySession` in `session.py`)
- Reads metadata (`customer_name, phone, call_id, language, gender, agent_purpose, bank_name, borrower_name, loan_amount, collected_data…`).
- `start_recording()` — async (300 ms delay) LiveKit Egress `RoomCompositeEgressRequest`, audio-only, `/recordings/<room>.ogg`.
- `add_user_message` / `add_agent_message` — build the transcript and reset `last_speech_time`.
- `_send_transcript()` — idempotent POST to the backend webhook (3 retries, 1s backoff). For `agent_purpose == "guarantor_consent"` it diverts to `/api/guarantor/transcript`; otherwise `/api/agent/transcript`.
- `save_and_disconnect()` — cancels monitors, stops ambience, flushes transcript, stops egress (5s timeout), deletes room.

### 7.7 Three per-call safety nets
1. `participant_disconnected` → customer hung up → immediate save+disconnect.
2. **Silence monitor** — polls every 3s; if `now - last_speech_time > 25s` **and** `not agent_busy` → polite farewell → end. (`agent_busy` is set from `agent_state_changed` so the agent's own long turn is never mistaken for customer silence.)
3. **Safety timeout** — force-ends any call still alive after 360s.
Plus a `shutdown_callback` that flushes the transcript even on a crashed worker.

### 7.8 Background ambience
Optional `BackgroundAudioPlayer` (OFFICE_AMBIENCE @ volume 0.15) masks dead air; stopped explicitly on disconnect.

---

## 8. Background jobs & schedulers

### Durable job queue (`services/job_worker.py` + `job_handlers.py`)
- Table `call_processing_jobs` (`job_type, payload JSONB, status, attempts, max_attempts, scheduled_at, locked_at, locked_by, last_error`).
- `enqueue_job(db_pool, job_type, payload, max_attempts=5, scheduled_at_delta_seconds=0)`.
- A pool of N workers claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`, runs the handler **outside** the transaction, marks `done` / retries with exponential backoff (capped 300s) / `dead` after max attempts (+ ops alert).
- **Orphan recovery** at startup: rows stuck `running` > 10 min are re-queued.
- Runs on a **dedicated DB pool** so jobs never starve API requests.
- Canonical handler: `transcript_analyze` (Gemini categorization of a finished call), enqueued from the transcript webhook + swept by the analytics cron.

### Schedulers (APScheduler, registered in `agent/batch.py:agent_startup`)
| Job | Trigger | Purpose |
|---|---|---|
| `batch_runner` | every 5 min, within calling hours | dispatch pending customer calls |
| `analytics_runner` | every 2 min | sweep uncategorized calls → enqueue analysis |
| `guarantor_runner` | every 3 min, within calling hours | guarantor consent dispatch lane |
| `error_cleanup` | daily 03:00 IST | prune `system_errors` |

Calling hours default `10:00–24:00 IST` (`CALL_START_HOUR`/`CALL_END_HOUR`). An **emergency stop** flag halts all dispatch.

---

## 9. Telephony / SIP

### Trunks & providers
Outbound calls go through **LiveKit SIP** to provider **SIP trunks**. The system is multi-provider: each `phone_numbers` row carries its own `livekit_trunk_id`, so different caller-IDs can route through different carriers (currently **Twilio** for the US `+1` number and **Vobiz** for the `+91` numbers).

### Phone pool & selection (`_acquire_trunk_from_db`)
- Selects the least-loaded eligible number: `status='active' AND (cooldown_until IS NULL OR <= NOW()) AND active_calls < capacity`, `ORDER BY active_calls, total_calls`, locked with `FOR UPDATE SKIP LOCKED`.
- Increments `active_calls`/`total_calls` on acquire; **decrements** + sets a random `cooldown_until` (between `cooldown_seconds_min..max`, default 180–300s) on release.
- If an operator pinned a number for the batch (`preferred_phone_id`), selection is **restricted to that number** and the env-fallback trunk is **not** used (operator pick is authoritative).
- If no pool number is eligible and no pin, it falls back to `SIP_TRUNK_ID` env trunk. If neither → call `Failed` with `"No SIP trunk configured"`.

### Number formatting — `_to_e164()` (in `dispatcher.py`, reused by guarantor)
```
'+…' present        → as-is
10 digits           → +91<d>           (Indian mobile)
11 digits, leading 0→ +91<last10>      (Indian, trunk-0)
12 digits, '91…'    → +<d>             (Indian w/ country code)
any other digits    → +<d>             (already international)
```
Uploads are read with `dtype=str` so a leading `+`/country code survives the parser.

### Operational notes (provider-side, not code)
- **Twilio trial accounts** can only call *verified* numbers (`error 32100`) — production requires an upgraded account + per-country **Geographic Permissions**.
- **Vobiz** must have **international termination enabled** for foreign destinations; domestic India works by default.
- Rapid manual retries can drain the pool into cooldown → temporary "No SIP trunk configured" until cooldowns expire.

---

## 10. Real-time & observability

- **Event bus** (`lib/event_bus.py`): in-process pub/sub with topics `batches, calls, errors, phones, workers`; replays recent history to new subscribers.
- **SSE** (`routers/realtime.py`): the Ops console subscribes via a `useEventStream` hook for live updates (no polling).
- **Errors:** agents lift `logger.error`/exceptions to `POST /api/internal/errors` (HMAC-signed); a `gpu-error-tailer` also ships docker/LiveKit/SIP errors. All surface in `/ops/errors`.
- **Metrics:** per-turn EOU delay, LLM TTFT, TTS TTFB are logged via `livekit.agents.metrics` (grep `METRIC` in agent journals).

---

## 11. End-to-end flows

### 11.1 Outbound customer call
```
Operator uploads CSV/Excel  → POST /api/agent/upload-excel
   (cols: Name, Mobile_number, Email, Customer_type, loan_type, loan_amount; read as dtype=str)
   → agent_batches (status=running)  +  agent_calls (status=Pending) per lead
   → if within calling hours, auto-dispatch (BackgroundTask process_batch_run)
batch_runner cron (every 5 min) → process_batch_run() picks the oldest running batch
   → Dispatcher.run():
        for each Pending call (concurrency ~5):
          _acquire_trunk_from_db()  → least-loaded number
          LiveKit create_room(metadata={customer_name,phone,call_id,language,gender,
                                         agent_purpose,bank_name,bank_id})
          agent_dispatch.create_dispatch(agent_name = pusad|union by agent_type)
          create_sip_participant(sip_call_to=_to_e164(phone), sip_number=caller-ID)
          wait_for_call_completion()   → poll agent_calls.status
          _release_trunk_to_db()        (finally — always)
Agent worker entrypoint(): reads metadata → builds session → hardcoded greeting →
   conversation (STT↔LLM↔TTS) → tools (collect_all_data, send_form_link, schedule_callback, end_call)
On end → session._send_transcript() → POST /api/agent/transcript
   → updates agent_calls (status, transcript, recording_url, collected_data, call_analysis)
   → enqueues transcript_analyze job (Gemini categorization)
Ops console shows it live (SSE) + in /ops/calls.
```

### 11.2 Form submission
```
Agent sends WhatsApp form link (send_form_link → AiSensy)  →  loan_applications row (draft)
Customer opens /loan-form (OTP) → multi-step form → POST /api/autosave(-session) (debounced)
Customer submits → POST /api/submit-form  OR  /api/submit-form-session
   → loan_applications.status = 'submitted', submitted_at, is_complete
   → record_transition(draft→submitted)
   → WhatsApp confirmation (AiSensy)
   → [additive] enqueue guarantor consent call if guarantor details present (§11.3)
Bank officer reviews (/bank/applications) → approve/reject → supervisor approves → vendor assignment.
```

### 11.3 Guarantor consent call (subsystem, isolated)
Personal loans **above ₹1 lakh** require a guarantor; the agent collects the guarantor's name + phone into the form. On submit, an automated call records the guarantor's consent.

```
Form submit with guarantor_name + guarantor_phone
  → guarantor.trigger.enqueue_guarantor_consent_call()
       resolves language (from linked agent_call) + bank_name; skips if phone==customer;
       UPSERT guarantor_consent_calls (status=pending, UNIQUE per application_id)
       mirrors loan_applications.guarantor_consent='pending'
guarantor_runner cron (every 3 min, calling-hours + emergency gated):
       _reclaim_stuck (calling > 10 min → failed)
       _promote_retryable (no_answer/failed, retry_count < 3, escalating backoff 5/15 min → pending)
       _mark_exhausted_unreached (retries spent → mirror 'no_answer')
       dispatch up to GUARANTOR_CONCURRENCY (2) pending rows
guarantor.dispatch.dispatch_guarantor_call():
       atomic _claim (pending→calling, retry_count++)   ← race-safe, one winner
       _acquire_trunk_from_db (shared pool)
       LiveKit room (metadata agent_purpose='guarantor_consent', borrower_name, loan_amount)
       dispatch agent_name=guarantor-consent ; create_sip_participant
       bounded wait (≤370s) for terminal status
       finally → _release_trunk_to_db (ALWAYS — prevents pool leak)
Guarantor agent: greeting → identity confirm → context ("{borrower} named you as guarantor") →
       ask consent ONCE → record_guarantor_consent("yes"|"no"|"") → end_call
record_guarantor_consent → POST /api/guarantor/consent (immediate, robust to drops)
On end → POST /api/guarantor/transcript → updates row (status completed/no_answer, consent, transcript, recording)
       → mirrors loan_applications.guarantor_consent (yes/no/no_answer)
Display: bank application detail + ops Call Detail dialog ("Guarantor consent: Yes/No/Pending/No answer").
```

**Why isolated:** the consent system has its **own table and its own dispatch cron**; it deliberately does **not** reuse `agent_calls`/the customer `Dispatcher`/the customer transcript webhook/the analytics cron — so it cannot pollute or destabilize the running customer-call system. It only **reuses low-level primitives** (`_acquire_trunk_from_db`, `_release_trunk_to_db`, `_to_e164`, LiveKit room/SIP, the shared `agent_core`).

---

## 12. Multi-tenancy

- `bank_id` threads through `agent_batches`, `agent_calls`, `loan_applications` — bank officers/supervisors see only their bank's data.
- Agent persona (`bank_name` in metadata) is set per agent type (e.g. "Union Bank of India" for account-opening, "ABC Bank" default for loan-enquiry).
- **Vendors** (NBFC partners) get their own portal and only see applications assigned to them.

---

## 13. Frontend (Next.js 14, App Router)

Portals (each route is a `page.tsx` under `frontend/app/`):

| Area | Routes | Audience |
|---|---|---|
| **Customer** | `/loan-form`, `/loan-form/application`, `/form/[token]`, `/success` | loan applicants (OTP) |
| **Ops** | `/ops`, `/ops/calls`, `/ops/live`, `/ops/batch`, `/ops/funnel`, `/ops/analytics`, `/ops/phones`, `/ops/workers`, `/ops/recordings`, `/ops/callbacks`, `/ops/exports`, `/ops/errors` | internal operators |
| **Bank** | `/bank/login`, `/bank/dashboard`, `/bank/applications`, `/bank/applications/[id]`, `/bank/calls`, `/bank/batch`, `/bank/account-form` | bank officers/supervisors |
| **Admin** | `/admin/login`, `/admin/dashboard`, `/admin/banks`, `/admin/banks/[id]`, `/admin/applications`, `/admin/applications/[id]`, `/admin/vendors` | super-admin |
| **Vendor** | `/vendor/login`, `/vendor/dashboard`, `/vendor/applications`, `/vendor/applications/[id]`, `/vendor/settlements` | NBFC partners |

- **Realtime:** Ops pages consume the SSE stream (`useEventStream`) for live call/phone/worker updates.
- **Auth:** JWT tokens in `localStorage`; role-based portals.
- **Shared components:** e.g. `components/ops/CallDetailDialog.tsx` renders a call's transcript, recording, collected fields, and the guarantor-consent badge.

---

## 14. Deployment & CI/CD

- **`scripts/deploy.sh`** modes:
  - full install (first-time): docker up, apply `schema.sql` + all `migration*.sql`, install systemd units, build frontend, enable+start all services.
  - `--update` (used by CI): `git reset --hard origin/master` → `pip install` → apply migrations → `npm run build` → install/refresh the guarantor unit → restart `los-backend los-frontend los-agent-union los-agent-pusad los-agent-guarantor` → health-gate (`/readyz` + agents active).
  - `--migrate-only`: just run migrations.
- **CI/CD:** pushing to `master` triggers a GitHub Actions workflow that SSHes to the host and runs `deploy.sh --update`.
- **Migrations** are idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) and re-applied every deploy.
- **Agent-only change:** `git reset --hard origin/master` + `systemctl restart los-agent-*` (no build needed).

---

## 15. Specific technicalities & design decisions

- **No ORM:** raw parameterized `asyncpg` everywhere (`$1, $2`), never string-interpolated values → SQL-injection safe and predictable.
- **Atomic claims for concurrency:** both the job worker and the guarantor dispatcher use `UPDATE … WHERE status='pending' RETURNING` / `FOR UPDATE SKIP LOCKED` so exactly one worker claims each unit — no double-dispatch even with overlapping cron ticks (APScheduler `max_instances=1` adds a second guard).
- **Trunk-release invariant:** every dispatch path releases its trunk in a `finally` block; a leak would silently shrink the shared pool and starve customer calls. (The guarantor lane ships with a standalone invariant test, `scripts/verify_guarantor_claim_release.py`.)
- **Retry ownership separation (guarantor):** the **webhook** owns the call *outcome* (`completed`/`no_answer`), the **dispatcher** marks `failed` only if the webhook never finalized (guarded `WHERE status='calling'`), and the **runner** owns *retry scheduling*. `retry_count` is incremented at claim time = attempts made.
- **Idempotency:** `guarantor_consent_calls` is UNIQUE per `application_id` with `ON CONFLICT DO NOTHING`; the transcript webhook is idempotent via a `transcript_sent` flag and status guards.
- **Best-effort, never block:** submit-time guarantor enqueue is wrapped in `try/except` so a failure can never break form submission.
- **Fallback everywhere:** LLM fallback chain (Gemini→Groq), trunk fallback (pool→env), and the agent worker auto-restarts on crash.
- **Observability without polling:** SSE event bus + structured JSON logs + per-turn latency metrics.

---

## 16. Known constraints & gotchas

- **Telephony, not code, is the usual blocker for failed calls:** check `agent_calls.error_message` and the provider console first (Twilio trial 32100 / Vobiz international-not-enabled / pool cooldown).
- **`+91` default:** any number stored **without** a `+` and not matching an Indian pattern is treated per `_to_e164`; always store international numbers with their `+`.
- **PostgreSQL containers:** the LOS DB is `vaani-los-postgres` (`los_admin`/`los_form`); an unrelated `pi_test_postgres` exists on the same host — don't confuse them.
- **Agent start latency:** the customer must hear the greeting within a few seconds; if the agent is slow to start speaking, callers hang up. The "gold config" (§7.4) exists to keep this at 1–2s.
- **Cooldown vs rapid retries:** numbers cool down 3–5 min after each call; rapid manual test retries on a single pinned number can exhaust availability.

---

*End of document.*
