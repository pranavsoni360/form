# Voice Agent — Latency Tuning, Bug Fixes & Modular Structure
**Date:** 2026-05-05
**Branch:** feature-scheduled-callbacks
**Author:** Design session with Claude

---

## Goal

1. Reduce agent turn latency to ~1.0–1.1s (Retell/Vapi territory) without changing LLM provider
2. Fix 5 critical bugs that cause data loss, incorrect retry counts, or broken language support
3. Split the 852-line `agent/los_updated.py` and 2429-line `backend/agent_routes.py` into focused modules — Option B from design session
4. **Zero disruption**: all existing API URLs, DB schema, LiveKit flow, frontend, and WhatsApp integration remain identical

---

## Constraints

- `collect_all_data` tool is NOT changed — batched end-of-call data collection stays as-is (latency optimization)
- LLM stays: Gemini 2.5-flash primary → Groq llama-3.3-70b fallback → Groq llama-3.1-8b last resort
- PostgreSQL schema: no migrations required
- All backend API routes keep exact same paths and response shapes
- Frontend unchanged
- LiveKit dispatch order (agent first, SIP second) unchanged

---

## Track 1 — Latency Tuning

All changes are in `AgentSession` constructor and `build_loan_enquiry_instructions()`.

### AgentSession parameter changes

| Parameter | From | To | Reason |
|-----------|------|----|--------|
| `min_endpointing_delay` | 0.20s | 0.13s | -70ms per turn; 0.13s still avoids cutting off natural pauses |
| `min_interruption_duration` | 0.50s | 0.35s | agent reacts faster to short "haan", "theek hai" |
| `discard_audio_if_uninterruptible` | True | True | keep — prevents stale audio queuing |
| `preemptive_generation` | True | True | keep — already saves ~200ms |

### VAD parameter changes

| Parameter | From | To | Reason |
|-----------|------|----|--------|
| `activation_threshold` | 0.45 | 0.50 | fewer false positives from phone line noise restarting the STT pipeline |
| `min_silence_duration` | 0.05s | 0.03s | tighter silence detection |
| `min_speech_duration` | 0.20s | 0.20s | unchanged — prevents spurious triggers |

### TTS changes

| Parameter | From | To | Reason |
|-----------|------|----|--------|
| `pace` | 1.01 | 1.06 | slightly faster delivery; tested as natural-sounding |
| `speech_sample_rate` | 22050 | 22050 | unchanged |
| `enable_preprocessing` | True | True | unchanged |

### Timeout changes

| Setting | From | To | Reason |
|---------|------|----|--------|
| Safety timeout | 150s | 360s | 8-question interview easily takes 4-6 min; 150s was cutting calls short |
| Silence monitor threshold | 25s | 20s | tighter idle detection |
| Silence monitor check interval | 5s | 3s | finer granularity |

### Language-aware system prompt

`build_loan_enquiry_instructions()` currently returns a single Hindi prompt regardless of `session.language`. This causes English/Marathi calls to receive Hindi instructions.

**Fix:** branch the function by language:
- `hindi` → current Hindi prompt (unchanged)
- `marathi` → Marathi language prompt (same 8 questions, same flow, Marathi script)
- `english` → English language prompt (same 8 questions, same flow, English)

The prompt structure (FLOW, RULES, tool call order) is identical across all three — only the natural language of the instructions changes.

---

## Track 2 — Bug Fixes

### Bug 1 — Analytics blocks event loop (CRITICAL)
**File:** `backend/agent_routes.py:879`
**Problem:** `analyze_transcript_with_llm()` is a synchronous function using `genai.Client.models.generate_content()`. Called directly inside `async def process_analytics_batch()`. Blocks the entire FastAPI event loop for 2-3s per call × up to 20 calls = up to 60s of frozen server.
**Fix:** `analysis = await asyncio.to_thread(analyze_transcript_with_llm, transcript)`

### Bug 2 — Restart burns retry slots (CRITICAL)
**File:** `backend/agent_routes.py:261`
**Problem:** `cleanup_stuck_calls()` does `retry_count = retry_count + 1` on calls stuck at 'Calling' during a server crash. These calls were never retried — they were interrupted. With MAX_RETRIES=2, a crash-interrupted call now has retry_count=1 and gets only 1 real retry instead of 2.
**Fix:** Remove `retry_count = retry_count + 1` from the UPDATE in `cleanup_stuck_calls()`. Set status='Failed' and error_message only.

### Bug 3 — Invalid phone consumes retry budget (HIGH)
**File:** `backend/agent_routes.py:700`
**Problem:** Invalid phones (len < 10) get `retry_count = retry_count + 1` and status='Invalid Phone'. The batch-retry endpoint at line 1170 filters `retry_count <= MAX_RETRIES`, so these invalid records land at retry_count=1 and are eligible for retry. Retry attempts call an invalid number again uselessly.
**Fix:** Set `retry_count = MAX_RETRIES + 1` for invalid phones. This excludes them from all future retry queries.

### Bug 4 — Safety timeout too short (HIGH)
**File:** `agent/los_updated.py:795`
**Problem:** `await asyncio.sleep(150)` — 2.5 minutes force-kills the call. An 8-question interview with a normal Indian customer takes 4-6 minutes.
**Fix:** `await asyncio.sleep(360)` — 6 minutes.

### Bug 5 — System prompt Hindi-only for all languages (HIGH)
**File:** `agent/los_updated.py:507`
**Problem:** `build_loan_enquiry_instructions()` returns Hindi instructions for all three language settings. English/Marathi calls get a Hindi LLM prompt even though TTS/STT are set to English/Marathi.
**Fix:** Language-branching in `build_loan_enquiry_instructions()` as described in Track 1.

---

## Track 3 — Modular Structure (Option B)

### Agent split

Current: `agent/los_updated.py` (852 lines, one file)

Target:
```
agent/
├── config.py       # LANG_CONFIG, GENDER_CONFIG, BACKEND_URL, IST, normalize_mobile()
├── session.py      # LoanEnquirySession class + CustomerType
├── tools.py        # send_form_link, end_call, schedule_callback, collect_all_data
├── prompts.py      # build_loan_enquiry_instructions() — Hindi/Marathi/English variants
├── agent_core.py   # LoanEnquiryAgent class + entrypoint() function
├── los_updated.py  # ENTRY POINT — thin: imports from above modules, runs cli.run_app()
└── .env.local      # unchanged
```

**`los_updated.py` keeps its filename** — startup command `./venv/Scripts/python los_updated.py dev` (HANDOFF.md:100) continues to work unchanged. The file becomes ~20 lines: imports from the four modules and calls `cli.run_app(WorkerOptions(...))`.

**Import chain:** `los_updated.py` → `agent_core.py` → `tools.py`, `prompts.py`, `session.py`, `config.py`. No circular imports.

The `AGENT_NAME` env var and worker registration are unchanged. The `requirements.txt` is unchanged.

### Backend split

Current: `backend/agent_routes.py` (2429 lines, one file)

Target:
```
backend/
├── main.py                      # unchanged
├── agent_routes.py              # router only: imports sub-routers, mounts them, exports agent_startup/agent_shutdown
└── agent/
    ├── __init__.py              # empty
    ├── state.py                 # db_pool ref, set_db_pool(), lock functions, system state helpers, _serialize_call()
    ├── batch.py                 # upload_excel, process_batch_run, wait_for_call_completion, batch endpoints
    ├── transcript.py            # POST /transcript webhook
    ├── whatsapp.py              # POST /send-whatsapp-form
    ├── callbacks.py             # POST /schedule-callback, GET /scheduled-callbacks
    ├── analytics.py             # process_analytics_batch, analyze_transcript_with_llm (now async-safe)
    └── calls.py                 # GET /calls, GET /calls/{id}, PUT categorize, GET recording, exports, dashboard-stats
```

`agent_routes.py` becomes a thin router that:
1. Creates the `/api/agent` APIRouter
2. Includes sub-routers from each module
3. Exports `agent_startup()` and `agent_shutdown()` (called by `main.py`)

**All existing route paths are preserved exactly.** `main.py` continues to call `from agent_routes import router as agent_router, set_db_pool, agent_startup`.

---

## What Does NOT Change

- `backend/main.py` — no changes
- `frontend/` — no changes
- `database/` — no migrations, no schema changes
- All API route paths and response shapes
- LiveKit call dispatch order
- AiSensy WhatsApp integration
- `collect_all_data` tool behavior
- `requirements.txt` for both agent and backend
- `.env.example` files
- `docker-compose.yml`
- `run.sh`

---

## Testing Plan

After implementation:

1. **Unit: agent modules** — `python -c "from agent.agent import entrypoint; print('OK')"` — verifies all imports resolve
2. **Unit: backend modules** — `python -c "from agent_routes import router, agent_startup; print('OK')"` — verifies router mounts correctly
3. **Integration: backend startup** — start uvicorn, hit `GET /api/agent/calls` → 200
4. **Integration: batch upload** — POST a CSV to `/api/agent/upload-excel` → calls created in DB
5. **Integration: analytics** — confirm analytics worker no longer blocks (check response time during analytics run)
6. **Call flow: demo mode** — set `AGENT_DEMO_MODE=true`, trigger batch, verify full flow: Pending→Calling→Called-Interested, transcript saved, analytics runs
7. **Language: English call** — set language=english in upload, confirm agent responds in English
8. **Latency: manual timing** — place a real call, measure time from end of customer speech to agent first word

---

## Delivery Order

1. Backend bug fixes (analytics async, retry_count fixes) — smallest blast radius, highest criticality
2. Agent bug fixes (safety timeout, language prompt) + latency tuning — agent.py only
3. Agent modular split — pure refactor, behavior unchanged
4. Backend modular split — largest change, last
