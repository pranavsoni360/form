# LOS Voice-Agent System — Engineering Handoff

**Project**: Loan Origination System (LOS) for Pusad Urban Bank
**Repo**: `github.com/pranavsoni360/form` — branch `feature-scheduled-callbacks` (latest commit `ea43717`)
**Working directory**: `C:\Users\adil.sheikh\Desktop\form\form`
**Author of this doc**: drop-in handoff for the next engineer

---

## 1. What this system does

End-to-end outbound voice-agent pipeline for loan enquiry:

```
CSV upload (bank operator)
     │
     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Backend (FastAPI)                                                   │
│  /api/agent/upload-excel  →  agent_batches + agent_calls (Pending)   │
│  process_batch_run() (cron + auto-trigger)                           │
└──────────────────────────────────────────────────────────────────────┘
     │
     ▼ (sequential, one at a time, 10 AM – midnight IST)
┌──────────────────────────────────────────────────────────────────────┐
│  LiveKit room creation → agent dispatch → SIP outbound dial          │
│  (Self-hosted LiveKit at ws://164.52.217.236:7880)                   │
└──────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Voice Agent (los_updated.py worker)                                 │
│  STT: Deepgram nova-3   LLM: Gemini 2.5-flash   TTS: Sarvam bulbul:v3│
│  Tools: collect_data, send_form_link, schedule_callback, end_call    │
└──────────────────────────────────────────────────────────────────────┘
     │
     ├─► Mid-call: send_form_link tool   ─►  /api/agent/send-whatsapp-form
     │                                       ├─ INSERT loan_applications (status=draft, prefilled)
     │                                       ├─ Save field_sources for "Voice Call" badges
     │                                       └─ AiSensy WhatsApp: "Tap to fill form"
     │
     ├─► Mid-call: schedule_callback tool ─► /api/agent/schedule-callback
     │                                       ├─ Clamp to working hours
     │                                       └─ status='Scheduled' + scheduled_callback_at
     │
     └─► End-of-call: _send_transcript     ─► /api/agent/transcript
                                              ├─ Save transcript JSONB
                                              ├─ Save recording_url
                                              ├─ Backfill loan_application
                                              └─ status = "Called - Interested" / etc.
     │
     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Customer taps WhatsApp link → http://localhost:3001/?phone=…        │
│  Auto-OTP → form prefilled with collected_data → submit              │
└──────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Bank Officer  →  /bank/applications/{id}  →  officer-approve        │
│  Bank Supervisor → supervisor-approve  →  status='approved'          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Tech stack

| Layer | Tech | Where it lives |
|-------|------|----------------|
| Frontend | Next.js 14 (App Router) | `frontend/`, port **3001** |
| Static dashboard | Plain HTML/JS | `frontend/public/agent-dashboard.html` |
| Backend | FastAPI + asyncpg + APScheduler | `backend/`, port **8200** |
| Database | PostgreSQL 16 (Docker container `los-postgres-dev`) | `database/`, port **5435** |
| Voice agent worker | livekit-agents 1.3.11 | `agent/los_updated.py` |
| Voice infra | Self-hosted LiveKit + SIP trunk | `ws://164.52.217.236:7880` |
| Speech | Deepgram nova-3 (STT), Sarvam bulbul:v3 (TTS), Gemini 2.5-flash (LLM) | configured in `los_updated.py` |
| WhatsApp | AiSensy Cloud API | env var `AISENSY_API_KEY` |

**Critical**: schema is **raw SQL** (asyncpg). No Alembic / SQLAlchemy. Migrations are `database/migration_*.sql` files applied manually.

---

## 3. How to start everything (cold boot)

```bash
# 1. Postgres (already restart=unless-stopped, but in case)
docker start los-postgres-dev

# 2. Backend
cd C:/Users/adil.sheikh/Desktop/form/form/backend
./venv/Scripts/uvicorn main:app --host 0.0.0.0 --port 8200

# 3. Frontend
cd C:/Users/adil.sheikh/Desktop/form/form/frontend
npx next dev -p 3001

# 4. Agent (LiveKit voice worker — must register with LiveKit before any call)
cd C:/Users/adil.sheikh/Desktop/form/form/agent
./venv/Scripts/python los_updated.py dev
```

Wait until each one logs:
- Backend → `Application startup complete`
- Frontend → `Ready in …`
- Agent → `livekit.agents | registered worker`

### URLs
- Bank ops dashboard: http://localhost:3001/agent-dashboard.html
- Bank login: http://localhost:3001/bank/login
- Customer OTP / form: http://localhost:3001/
- API docs: http://localhost:8200/docs

---

## 4. Database schema highlights

17 tables. Key ones for the call flow:

- **`agent_batches`** — CSV upload batches (`status: pending|running|completed`)
- **`agent_calls`** — every dial. Important columns:
  - `status` — `Pending`, `Scheduled`, `Calling`, `Called - Interested`, `Called - Not Interested`, `Not Answered`, `Failed`, `Invalid Phone`
  - `transcript` JSONB, `collected_data` JSONB, `call_analysis` JSONB
  - `recording_url`, `form_sent`, `form_link`
  - `retry_count` (incremented on every failure including initial)
  - `application_id` → linked `loan_applications.id` after form is sent
  - **`scheduled_callback_at` TIMESTAMPTZ** — set by `schedule_callback` tool
  - **`callback_reason` TEXT** — `user_busy`, `in_meeting`, etc.
- **`loan_applications`** — multi-step form, `status` flow: `draft → submitted → officer_approved → approved`
- **`form_tokens`** — email-link flow (separate from voice flow)
- **`field_sources`** — JSONB column on `loan_applications` (NOT a separate table) for "Voice Call" / "PAN" / "Aadhaar" badges
- **`status_transitions`** — audit log of approvals
- **`agent_system_config`** — `emergency_stop`, `batch_lock` keys

---

## 5. Backend API surface (`/api/agent/...`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/upload-excel?language=hindi&gender=male` | Upload CSV/xlsx; **auto-starts batch** if within calling hours |
| POST | `/batch-call` | Manually start most-recent pending batch |
| POST | `/batch-retry` | Retry failed calls (max 2 retries per call) |
| POST | `/emergency-stop` / `/resume-calling` | Pause / resume batches |
| POST | `/stale-cleanup` | Fix stuck "Calling" rows |
| POST | `/transcript` | **Webhook** — agent posts transcript here |
| POST | `/send-whatsapp-form` | **Webhook** — agent's send_form_link tool |
| POST | `/schedule-callback` | **Webhook** — agent's schedule_callback tool |
| GET | `/calls?page=…&status=…` | Paginated call list with filters |
| GET | `/recent_calls?limit=10` | Returns both `calls` and `recent_calls` (Samavesh-shaped) |
| GET | `/scheduled-callbacks` | Upcoming scheduled callbacks ordered by callback time |
| GET | `/uploads` | Upload history (returns `uploaded_at` + `record_count` aliases) |
| GET | `/calls/{id}/transcript` | Full transcript |
| GET | `/calls/{id}/recording` | Recording URL |
| GET | `/dashboard-stats`, `/analytics`, `/live-status` | Dashboard widgets |
| GET | `/export/daily-report?date=YYYY-MM-DD` | xlsx |
| GET | `/export/all-calls` | xlsx with all 23 columns |

**Batch dispatcher** (cron, every 5 min) at `agent_routes.py:_scheduled_batch_run`. Cron hour expression is **derived from env** (`CALL_START_HOUR`/`CALL_END_HOUR`).

**Analytics worker** (cron, every 2 min) at `agent_routes.py:process_analytics_batch`. Filters on `category = 'Uncategorized'` (NOT `call_analysis IS NULL` — that's the bug we fixed; the transcript handler always populates `call_analysis`, so the old filter never matched).

---

## 6. Voice agent (`agent/los_updated.py`) — design

**Entry point**: `entrypoint(ctx)` is the LiveKit agent worker function.

**Per-call flow**:
1. Read room metadata → `LoanEnquirySession` (customer name, phone, call_id, language, gender)
2. Register `ctx.add_shutdown_callback(_flush_transcript_on_shutdown)` — guarantees transcript flush even if user hangs up mid-call
3. Wait for SIP participant to join
4. Hook `participant_disconnected` — schedules `save_and_disconnect(delay=0)` and the framework awaits the shutdown callback
5. Build `AgentSession` (Deepgram + Gemini + Sarvam + silero VAD)
6. Speak split greeting (intro non-interruptible + identity check interruptible)
7. Run conversation. Tools: `collect_data`, `send_form_link`, `schedule_callback`, `end_call`, `collect_all_data` (legacy fallback)
8. On end: `_send_transcript` (idempotent via `transcript_sent` flag) → stop egress → delete room → `shutdown_event.set()`

### Session-level safety nets
- **Silence monitor** (`silence_monitor()`) — 20 s of no speech → polite goodbye + disconnect
- **Safety timeout** — 120 s max call length → force-end
- **`shutdown_event`** — main entrypoint awaits this in `finally` so transcript HTTP completes before worker exit

### Tools

```python
collect_data(field, value)              # silently saves one detail per turn
collect_all_data(...)                   # batch save (kept for fallback only)
send_form_link(loan_type, amount)       # POSTs to /api/agent/send-whatsapp-form
schedule_callback(callback_iso, reason) # NEW — POSTs to /api/agent/schedule-callback
end_call(reason)                        # graceful disconnect with farewell
```

### Prompt (`build_loan_enquiry_instructions`)

Two variants — EXISTING customer (loan offer first) and NEW customer (bank intro + eligibility first). Both share `COMMON_RULES` with 12 numbered rules:

- **0**: Customer-gender pronoun awareness — verb forms (करते vs करती), Sir vs Ma'am
- **1**: 1 short sentence per reply, ≤12 words
- **2**: One question at a time; minimal acknowledgments
- **3**: Per-turn `collect_data` (NOT batched — keeps latency steady)
- **4**: Auto-infer sector from designation (never ask)
- **5–8**: Polite goodbye / no debate / no emojis / RAG memory respect
- **10**: Off-topic deflection (weather, account balance, "are you AI?") → 1 polite redirect
- **11**: Time-waster detection — calmly ask if they're genuinely interested, no threatening "should I end the call?"
- **12**: Busy / callback handling — ask "कब call करूँ?", resolve to ISO, call `schedule_callback`, polite confirm + `end_call("user_busy")`

8 questions per call: age → designation+employer combined → qualifications → experience → existing EMI → loan purpose → loan amount → "is this WhatsApp number?".

### Latency tuning (post-default)

```python
AgentSession(
    preemptive_generation=True,        # LLM starts before VAD finishes
    min_endpointing_delay=0.2,         # was 0.5 default
    max_endpointing_delay=2.5,
    min_interruption_duration=0.3,     # short word interrupts agent
    discard_audio_if_uninterruptible=True,
)
```

Typical turn: STT ~250 ms + endpoint 200 ms + LLM ~700 ms + TTS first byte ~450 ms ≈ **1.5–1.8 s**.

---

## 7. Frontend

### Next.js (`frontend/`)
- `/` — phone+OTP entry. Reads `?phone=` query param and **auto-fires OTP** for 10-digit values
- `/loan-form/application` — multi-step prefilled form (uses `loan_session` token in sessionStorage)
- `/bank/login`, `/bank/dashboard` — bank user JWT flow
- `/bank/applications/{id}` — review screen with officer/supervisor actions
- `/bank/calls` — call log (now recognizes `Scheduled` status)
- `/bank/batch` — CSV upload + agent **language/voice selectors** (Hindi/Marathi/English × Male/Female)

### Static dashboard (`frontend/public/agent-dashboard.html`)
- Recent Calls / Calls list with filters (now includes 📅 Scheduled)
- **📅 Upcoming Callbacks card** — pulled from `/api/agent/scheduled-callbacks`
- Manual batch buttons (Start / Retry / Cleanup / Emergency Stop / Resume)
- Daily Report + All Calls xlsx exports
- Language + Voice selectors at upload time

---

## 8. Critical configuration

### `backend/.env` (gitignored)

```
DATABASE_URL=postgresql://los_admin:password@localhost:5435/los_form
JWT_SECRET=<32+ char>
ENCRYPTION_KEY=<32+ char>

LIVEKIT_URL=ws://164.52.217.236:7880
LIVEKIT_API_KEY=APIz4wNJoLzxewZ
LIVEKIT_API_SECRET=<...>
SIP_TRUNK_ID=ST_7AXVHfHRbCwP
AGENT_NAME=pusad-bank-loan-enquiry-enhanced

CALL_START_HOUR=10
CALL_END_HOUR=24
MAX_CALL_RETRIES=2

RECORDING_BASE_URL=http://164.52.217.236:7000   # serves /recordings/{room}.ogg

AISENSY_API_KEY=<JWT>
AISENSY_CAMPAIGN_NAME=otp_verification
AISENSY_USERNAME=Virtual Galaxy WABA
AISENSY_FORM_CAMPAIGN=LRS_TESTING

GEMINI_API_KEY=<...>
OPENAI_API_KEY=<...>
FORM_BASE_URL=http://localhost:3001
```

### `agent/.env.local` (gitignored)

```
LIVEKIT_URL=ws://164.52.217.236:7880      # MUST match backend
LIVEKIT_API_KEY=…
LIVEKIT_API_SECRET=…
BACKEND_URL=http://localhost:8200          # for transcript / form / callback POSTs
DEEPGRAM_API_KEY=…
SARVAM_API_KEY=…
GEMINI_API_KEY=…
AISENSY_API_KEY=…                          # fallback if backend WhatsApp fails
```

---

## 9. Calling-hours + retry contract

- **Working hours**: `CALL_START_HOUR=10` → `CALL_END_HOUR=24` (10 AM – midnight IST). Both the **APScheduler cron** and the **`is_within_calling_hours()`** check use these env vars. Cron expression is dynamically built (e.g. `hour="10-23"`).
- **Retry policy**:
  - `MAX_CALL_RETRIES=2` — exactly 2 retries after the initial attempt (3 total dials max)
  - SQL: `retry_count <= MAX_RETRIES` (the `<` was the off-by-one bug — fixed)
  - Eligible statuses for retry: `Not Answered`, `Failed`, `Call Not Connected`
  - Rows above max are permanently parked
- **Scheduled callbacks**: Dispatcher `WHERE status='Scheduled' AND (scheduled_callback_at IS NULL OR scheduled_callback_at <= NOW())`. Backend clamps any user-given time into working hours and snaps past times to next valid window.

---

## 10. WhatsApp + form-prefill flow

1. Agent calls `send_form_link(loan_type, amount)`
2. Backend `/api/agent/send-whatsapp-form`:
   - Looks up `agent_calls` by `call_id`
   - INSERTs `loan_applications` (status='draft', `agent_call_id=<call uuid>`, prefilled with `collected_data`)
   - Saves `field_sources` JSONB so the form shows "Voice Call" badge per field
   - POSTs AiSensy with `form_url = {FORM_BASE_URL}/?phone={bare_10digit}`
3. Customer receives WhatsApp with link → taps → lands at `/?phone=…`
4. `frontend/app/page.tsx:26-31` reads phone, auto-fires `POST /api/request-otp`
5. OTP delivered via AiSensy → user enters → `POST /api/verify-otp-session` returns `session_token`
6. Frontend `/loan-form/application` calls `GET /api/get-application?session_token=…`
7. Form renders prefilled with employer / loan_amount / etc., with "Voice Call" badges

**The "/loan-form?phone=…" URL was the historical break** — that route is just `redirect('/')`, which drops query params. Fixed by sending `/?phone=…` from the agent.

---

## 11. Everything that was changed in this session

### Voice agent
1. **Transcript-on-hangup fix** — `ctx.add_shutdown_callback` + `transcript_sent` idempotency flag
2. **Latency tuning** — `min_endpointing_delay=0.2`, `min_interruption_duration=0.3`, preemptive generation
3. **Prompt rewrite** — short directive style, 12-word rule, per-turn `collect_data` (was batched, made the LLM verbose)
4. **8 questions** with combined work+company question + WhatsApp number question
5. **Off-topic + nonsense-talker detection** (RULE 10 + 11) with respectful exit
6. **Customer-gender pronoun awareness** (RULE 0)
7. **Scheduled callback flow** — new `schedule_callback` tool + RULE 12
8. **Safety timeout 180→120 s, silence 30→20 s**
9. **Disconnect handler delay 1 s → 0** (no point waiting once user hangs up)

### Backend
10. **Auto-start batch on upload** when within calling hours
11. **Agent dispatch BEFORE SIP participant** (Samavesh order — fixes "no audio when customer picks up")
12. **Working-hours cron driven from env** (was hardcoded `hour="10-23"`)
13. **MAX_RETRIES off-by-one fix**: `retry_count <= MAX_RETRIES` (was `<`)
14. **Scheduled-callbacks**: new column `scheduled_callback_at`, new column `callback_reason`, dispatcher gates Scheduled rows by time, new `/schedule-callback` POST + `/scheduled-callbacks` GET
15. **`recent_calls` returns both `calls` and `recent_calls`** (dashboard naming drift)
16. **Serializer adds aliases**: `call_start_time`, `call_end_time`, `uploaded_at`, IST-formatted `scheduled_callback_at`
17. **Exports fixed**: daily-report (JSONB string parse), all-calls (pandas `len(NaN)` guard)
18. **Analytics filter**: `category = 'Uncategorized'` (was `call_analysis IS NULL` — never matched)
19. **Analytics merges instead of overwrites** call_analysis (preserves agent's `lead_quality`)
20. **Customer gender propagation** — pulled out of `collected_data` JSONB into LiveKit room metadata so the agent picks the right voice
21. **Form prefill URL fix**: `/?phone=…` instead of `/loan-form?phone=…`
22. **`RECORDING_BASE_URL`** populated in env (was empty, leaving `recording_url` always NULL)
23. **`openpyxl` installed** in backend venv (was missing → xlsx upload 500'd)
24. **`AISENSY_API_KEY`** copied from `agent/.env.local` to `backend/.env` (was empty in backend → WhatsApp silently no-op'd)

### Frontend
25. **`/bank/batch`** — added language + voice selectors, sent as query params
26. **`/bank/calls`** — `Scheduled` status added to STATUS_MAP with purple badge
27. **Static dashboard** — 📅 Scheduled in status filter, 📅 Upcoming Callbacks card with dedicated loader

### DB
28. **`agent_calls.scheduled_callback_at TIMESTAMPTZ`**
29. **`agent_calls.callback_reason TEXT`**
30. **`idx_agent_calls_callback`** partial index for the dispatcher

---

## 12. Known limitations / things to watch

- **`uvicorn` is not started with `--reload`** — every backend code change requires a manual restart
- **`agent/.env.local` and `backend/.env` have duplicate config** — check both when changing API keys
- **AiSensy template** for the form WhatsApp is `LRS_TESTING` — coordinate with marketing before rotating
- **Recordings**: egress writes to `/recordings/{room}.ogg` on the **LiveKit server**'s filesystem; backend constructs URL with `RECORDING_BASE_URL` prefix. If recordings stop appearing, check the LiveKit VPS HTTP server on port 7000
- **`gender_customer` CSV column** is parsed but currently only flows into `collected_data` — agent uses customer NAME for pronoun inference, not this field. Could be wired more directly later
- **Analytics LLM call is synchronous** in cron — if Gemini stalls, analytics worker stalls (acquired lock, will release in finally). Consider a per-call timeout
- **Shutdown callback contract** is per livekit-agents 1.3.11 — version-pin `requirements.txt` if upgrading

---

## 13. How to test end-to-end (5 min)

1. Boot all 4 services (section 3)
2. Open `localhost:3001/agent-dashboard.html`
3. Upload `dummy.xlsx` (or any CSV with `Name`, `Mobile_number`)
4. Pick agent language + voice in the upload card
5. Click upload → response should say `"auto_calling": true`
6. Phone rings → answer; agent introduces itself in 1 line, asks 8 questions
7. Mid-call, say "अभी busy हूँ, शाम 6 बजे call करना" → agent confirms, schedules, hangs up
8. Refresh dashboard → row appears in **📅 Upcoming Callbacks** with IST time
9. After 6 PM, the cron picks it up and re-dials automatically
10. Complete a normal call → WhatsApp with `?phone=` link arrives → tap → form prefilled

---

## 14. Repo state

- **Branch on origin**: `feature-scheduled-callbacks`
- **Last commit**: `ea43717` — "feat: scheduled callbacks, agent latency + reliability fixes" (11 files, +2469 / −95)
- **PR-create link**: https://github.com/pranavsoni360/form/pull/new/feature-scheduled-callbacks (not opened yet — pranavsoni360 to merge or request PR)

`.gitignore` excludes: `.env` files, venvs, `node_modules`, `.next`, `*.log`, `uploads/`, `.claude/`, dummy fixtures.

---

## 15. Glossary of file paths the next engineer will touch most

| Concern | File |
|---|---|
| Agent prompt + tools | `agent/los_updated.py` (lines 365–700 mostly) |
| Backend dispatcher | `backend/agent_routes.py:601` (`process_batch_run`) |
| Backend transcript handler | `backend/agent_routes.py:1512` |
| Backend WhatsApp form | `backend/agent_routes.py:1766` (`send_whatsapp_form`) |
| Backend schedule callback | `backend/agent_routes.py:1700` (`schedule_callback`) |
| OTP / form prefill | `backend/main.py:2629–2725` |
| Form prefilled UI | `frontend/app/loan-form/application/page.tsx` |
| Bank dashboard table | `frontend/app/bank/calls/page.tsx` |
| Static ops dashboard | `frontend/public/agent-dashboard.html` |
| Schema source of truth | `database/schema.sql` + `database/migration_*.sql` |

Good luck. Everything that's been done is in this doc + the commit message of `ea43717`. Local DB is empty, ready for fresh runs.
