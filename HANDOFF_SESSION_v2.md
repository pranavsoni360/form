# 🤝 Project Handoff — form/form LOS (continuing from prior session)

Hello Claude. I'm **Adil Sheikh** continuing work on `form/form`. Previous session ran out of context. **READ THIS ENTIRE DOC BEFORE DOING ANYTHING.**

**Working directory:** `C:\Users\adil.sheikh\Desktop\form\form`
**OS:** Windows (use Git Bash for shell tools)

---

## ⛔ DO NOT (these will break things)

1. **DO NOT** `git stash` / `git checkout .` / `git reset --hard` — 18 files of uncommitted work will vanish
2. **DO NOT** redirect `/agent` → `/ops` yet (blocked by Phase 9 smoke test)
3. **DO NOT** delete `frontend/public/agent-dashboard.html` yet (Phase 10 only)
4. **DO NOT** add Prometheus / Grafana / Redis / multi-process uvicorn — explicitly out of scope for 500 calls/day
5. **DO NOT** auto-commit my work — I review before commit
6. **DO NOT** run `npm install` or `pip install` — environment is already set up
7. **DO NOT** touch `backend/agent/state.py` auth flow — operator mode is intentional
8. **DO NOT** "improve" adjacent code, comments, or formatting unless asked (Rule R9 surgical)

---

## 0. YOUR PERSONA & OPERATING MODE (from my global CLAUDE.md)

You are an **elite-tier AI development partner** with the expertise of a **Principal Engineer** across the full stack. You don't just write code — you architect solutions, anticipate edge cases, enforce production-grade standards, and think three steps ahead.

**Behavioral rules (NON-NEGOTIABLE):**

1. **Production-first mindset** — every line shippable. No TODOs, no placeholders.
2. **Think before code** — briefly reason, name alternatives, pick best with WHY. If unclear, STOP and ask. Never assume.
3. **Defensive programming** — always handle errors, edges, null/undefined, races.
4. **DRY + SOLID** — extract reusables, composition over inheritance.
5. **Type safety** — TypeScript for JS, Pydantic for Python.
6. **Security by default** — never hardcode secrets, parameterize queries, OWASP top 10.
7. **Karpathy simplicity** — minimum code that solves the problem. If 200 lines could be 50, rewrite.

**My 10 mandatory operating rules (auto-enforced):**

- **R1 Pre-verify** DB schema before backend changes — read migrations + models, list mismatches, fix migrations FIRST.
- **R2 Post-edit verify** — run relevant tests / curl the feature.
- **R3 Schema consistency** — check pgvector / migrations / extensions before assuming.
- **R4 Multi-role testing** — test admin AND bank_user AND operator paths.
- **R5 Checkpoint large outputs** — save incrementally, never wait-till-end.
- **R6 Env verification** before features — check Docker, DB, API keys actually work.
- **R7 Never claim inability without trying** — always attempt first.
- **R8 Save intermediate** — `_checkpoint_<task>.md` for multi-step work.
- **R9 SURGICAL changes** — touch only what request needs. No "improvements" to adjacent code. Match existing style. Every diff line must trace to my ask.
- **R10 Goal-driven** — convert vague tasks to verifiable goals. State plan upfront.

**Communication style I want:**
- **Hinglish** (Hindi-English mix) — natural and decisive
- **Mentor tone** — give recommendations, not just options. Pick the best one with rationale.
- **Concise** — show code, don't over-explain.
- **Flag risks proactively** with severity.

**Specialist commands I have available** (you can suggest invoking these):
- `/fullstack-architect` `/api-designer` `/frontend-expert` `/backend-expert` `/database-architect`
- `/devops-engineer` `/ai-ml-engineer` `/security-auditor` `/qa-tester` `/performance-optimizer`
- `/code-reviewer` `/debugger` `/doc-writer` `/refactoring-expert` `/project-planner`

**Operational skills available:**
- `/preflight` — pre-flight infra validation (Docker, DB, auth, env)
- `/fix-loop` — autonomous test-run-fix loop
- `/test-roles` — RBAC matrix test across all user roles
- `/commit` — lint → typecheck → test → security → commit
- `/checkpoint` — save work incrementally

**My memory context (from prior sessions — read these auto-memory files):**
- `project_los_overview.md` — full system overview
- `project_los_deep_technical.md` — code-level: agent internals, LLM fallback chain, 4 tools, transcript flush, batch dispatcher, WhatsApp wiring, DB flow
- I'm a builder/operator launching an **AI Outbound Agency** with my sister (booked calls for B2B marketing agencies — full plan at `Desktop/AI_Outbound_Business_Plan.md`)
- I have my own **self-hosted LiveKit** stack at `164.52.217.236` (LK + SIP + Egress + Redis via Docker, Viva PSTN trunk)
- I study **SalkAI's production patterns** (multi-tenant, dispatcher heap, form schemas, status triggers — refs at `~/Documents/My Received Files/CBS-Tanvi/`)
- `form/form` is the **fastest-latency voice agent** I've built (Deepgram + Gemini + Sarvam, preemptive_generation, 130ms endpointing, split greeting)

---

## 0.5. Git state at handoff time ⚠️ CRITICAL

**Branch:** `feature/m6-realtime-backbone` (NOT master)
**Status:** ALL Phase 1–8 work is **UNCOMMITTED** — sitting in working tree.

**Modified (10):**
```
DEPLOYMENT.md
backend/agent/batch.py
backend/main.py
frontend/app/admin/login/page.tsx
frontend/app/agent/page.tsx
frontend/app/bank/batch/page.tsx
frontend/app/ops/layout.tsx
frontend/app/ops/page.tsx
frontend/app/providers.tsx
frontend/components/shared/Sidebar.tsx
```

**Untracked (8 new):**
```
HANDOFF.md                                      (architecture notes from prior session)
HANDOFF_SESSION_v2.md                           (THIS FILE)
frontend/app/ops/{analytics,batch,callbacks,calls,exports}/
frontend/components/ops/CallDetailDialog.tsx
frontend/components/ui/dialog.tsx
```

**DO NOT commit until Phase 9 smoke test passes.** If you find a bug during Phase 9, fix-then-commit-as-one-unit. Final commit message draft is in §7 Phase 10 step 4.

---

## 1. Project at a glance

- **What it is:** AI voice-agent LOS for **Pusad Urban Bank**. Calls customers in Hindi/Marathi/English, qualifies leads, sends WhatsApp loan-application forms, tracks the funnel end-to-end.
- **Stack:**
  - Frontend: Next.js 14 App Router @ port **3001** (TypeScript, Tailwind, shadcn/ui, TanStack Query v5, sonner)
  - Backend: FastAPI @ port **8200** (asyncpg, APScheduler)
  - DB: PostgreSQL 16 (Docker `los-postgres-dev` @ port **5435**, user `los_admin`, pwd `los_dev_pass`, db `los_form`)
  - Voice: self-hosted LiveKit @ `164.52.217.236` + Deepgram (ASR) + Gemini (LLM) + Sarvam (TTS) + Viva PSTN
  - WhatsApp: AiSensy
- **Target scale: 500 calls/day** (scoped down from original 5000/day plan — do NOT over-engineer)

## 2. Admin login (DEV)

```
URL:      http://localhost:3001/admin/login
Email:    admin@bank.com
Password: admin123
```

If locked out:
```bash
docker exec -i los-postgres-dev psql -U los_admin -d los_form -c "DELETE FROM login_attempts WHERE username = 'admin@bank.com';"
```

## 3. M1–M8 upgrade status — ALL DONE & live-tested ✅

| # | Milestone | Location |
|---|---|---|
| M1 | Observability (Sentry + Discord/Telegram + JSON logs + BACKEND_URL 8002→8200 fix) | `backend/lib/logging_config.py`, `notifier.py`; `backend/main.py:38-91`; `agent/config.py` |
| M2 | Migrations runner + v6–v10 schemas | `backend/db_migrations.py`; `database/migration_v6_*` to `v10_*` |
| M3 | Async job queue + workers (4 alive) | `backend/services/job_worker.py`, `job_handlers.py` |
| M4 | Dispatcher rewrite (phone pool min-heap) | `backend/services/dispatcher.py`; `backend/agent/batch.py:207-230` |
| M5 | Health/ready + circuit breakers + retry | `backend/routers/ops.py`; `backend/lib/circuit_breaker.py`, `retry.py` |
| M6 | SSE realtime + dashboards | `backend/lib/event_bus.py`, `backend/routers/realtime.py`; `frontend/lib/realtime/*` |
| M7 | Errors / Funnel / Recordings pages | `frontend/app/ops/errors`, `/ops/funnel`, `/ops/recordings` |
| M8 | Backups + tuning | `scripts/pg_backup.sh`, `restore_test.sh`; `DEPLOYMENT.md §3` |

**Intentionally SKIPPED (overkill at 500/day):** Prometheus + Grafana stack, Redis, multi-process uvicorn. Documented in plan.

## 4. Frontend unification — Phases 1–8 DONE

We ported the OLD operator dashboard (`frontend/public/agent-dashboard.html` — 1897 lines, served at `/agent` via iframe) into `/ops/*` with VirtualVaani design. **Old `/agent` still available as backup until Phase 9 smoke test confirms zero regressions.**

### New pages created
| Page | File | Purpose |
|---|---|---|
| `/ops` (enhanced) | `app/ops/page.tsx` | KPIs + activity chart + InterestCategoriesRow + RecentCallsCard |
| `/ops/calls` | `app/ops/calls/page.tsx` | Full table — filters (status/category/lead/form/date), search, pagination 20/page |
| `/ops/analytics` | `app/ops/analytics/page.tsx` | KPIs + outcome bar + lead-quality + loan-type breakdown |
| `/ops/exports` | `app/ops/exports/page.tsx` | Daily Excel / comprehensive / today's-one-click / JSON dump |
| `/ops/callbacks` | `app/ops/callbacks/page.tsx` | Scheduled callbacks with relative-time pills |
| `/ops/batch` | `app/ops/batch/page.tsx` | Operator batch: upload, start, retry, resume, emergency-stop (confirm), cleanup-stuck |

### Shared infra
- `frontend/components/ui/dialog.tsx` — minimal portal Dialog (~130 LOC, no Radix dep)
- `frontend/components/ops/CallDetailDialog.tsx` — shared dialog: status chips + facts + collected data + inline audio + inline transcript + Open-WhatsApp-form. Exports `maskPhone`, `fmtDuration`, `statusVariant`.

### Other edits
- `frontend/app/ops/layout.tsx` — admin auth gate, passes `?redirect=` to login
- `frontend/app/admin/login/page.tsx` — Suspense + safe-list redirect (allows /ops, /admin/*). Default → `/ops`.
- `frontend/components/shared/Sidebar.tsx` — 4+1 grouped nav (Overview / Calls / Operate / System / Administration) + Transitional Legacy link to `/agent` + wired logout
- `frontend/app/providers.tsx` — `ReactQueryDevtools` removed (I disliked the floating logo)
- `frontend/app/bank/batch/page.tsx` — SSE migration (killed 5s polling)
- `frontend/app/agent/page.tsx` — kept as iframe to legacy HTML. **DO NOT redirect to /ops yet.**

## 5. Bug-fix pass — 8 verified fixes

| File:line | Fix |
|---|---|
| `backend/main.py:417, 538` | Added `from zoneinfo import ZoneInfo` + `IST_TZ`; `datetime.now()` → `datetime.now(IST_TZ)` for PDF timestamps |
| `backend/agent/batch.py:147` | Silent `except: pass` → `logger.warning` with call_uuid |
| `backend/agent/batch.py:284` | CSV decode → logs UTF-8 failure + raises clean `HTTPException(400)` on dual-decode failure |
| `frontend/app/ops/batch/page.tsx` (5 mutations) | Cache-bombing `invalidateQueries()` → `refreshBatchViews()` targeting `["batch-status"]` + `["uploads"]` |
| `frontend/app/ops/batch/page.tsx` postJson | Content-type detection so non-JSON errors show real text |
| `frontend/app/ops/batch/page.tsx` BatchDetailDialog | Row key index fallback |
| `frontend/app/ops/page.tsx` RecentCallsCard | Row key index fallback |
| `DEPLOYMENT.md` | All `localhost:5434` → `localhost:5435` |

**Verified false-positives (do NOT "fix"):** `.env` files ARE gitignored ✓; `acquire_batch_lock()` is asyncio-atomic ✓; `DISPATCHER_CONCURRENCY` already in `.env.example` ✓; JWT decode passes `algorithms=["HS256"]` ✓; Blob URL DOES revoke in exports ✓.

## 6. Live test snapshot (last verified state)

```
/healthz  → 200                                 (213 ms)
/readyz   → 200 db:ok | circuits:none_registered | job_workers:alive=4/4
/version  → 200 uptime=24585s
SSE       → token mint + stream events confirmed end-to-end

Phone pool: 5 numbers, 1 quarantined, cooldowns engaged
agent_calls: 15 (4 Interested, 5 Not Interested, 3 Cancelled, 2 NA, 1 Failed)
```

## 7. Pending work

### Phase 9 — Zero-regression smoke test (NEXT)
Walk through a feature checklist comparing `/agent` (iframe to legacy HTML) ↔ `/ops/*` side-by-side. Block Phase 10 until 100% green.

**How to generate the checklist:** read `frontend/public/agent-dashboard.html` top-to-bottom, list every visible feature (KPI cards, tables, filters, buttons, modals, exports, batch controls). Then for each, confirm equivalent works in the corresponding `/ops/*` page. ~30 items expected. Walk it with me one row at a time — don't dump all 30 at once.

### Phase 10 — Final cutover (BLOCKED by Phase 9)
1. Replace `app/agent/page.tsx` iframe with `redirect("/ops")`
2. Delete `frontend/public/agent-dashboard.html`
3. Remove Transitional / Legacy section from Sidebar
4. Commit: `feat(ops): unify VirtualVaani dashboard — deprecate /agent`

## 8. Auth model (important)

Backend `get_current_bank_user` uses `auto_error=False`:
- **No token** → returns `"operator"` mode (sees everything, no bank scoping). This is what old `/agent` and new `/ops/*` both use.
- **Bank user token** → scoped to that bank.
- **Admin token** → gates `/ops/*` UI only (via layout). Not accepted by `get_current_bank_user`.

`/ops/*` pages fetch `/api/agent/*` WITHOUT Authorization header → operator mode. **Zero auth drift from old /agent.**

## 9. Backend endpoint contract (for /ops pages)

All under `/api/agent/*` (★ = no auth required — operator mode aliases):

```
GET    /api/agent/dashboard-stats           ★    KPIs for /ops home
GET    /api/agent/recent_calls?limit=10     ★    Recent calls card
GET    /api/agent/scheduled-callbacks?limit=50 ★ /ops/callbacks
GET    /api/agent/calls?page=&page_size=20&status=&category=&lead_quality=&form_sent=&date=  ★
GET    /api/agent/call/{id}                 ★    CallDetailDialog
GET    /api/agent/analytics                 ★    /ops/analytics
GET    /api/agent/funnel?date_from=&date_to= ★   /ops/funnel
GET    /api/agent/batch-status              ★    /ops/batch live banner
POST   /api/agent/upload-excel?language=&gender=&agent_type= (multipart)  ★
POST   /api/agent/batch-call                ★    start dispatcher
POST   /api/agent/batch-retry               ★    reset failed → Pending
POST   /api/agent/emergency-stop            ★    kill active call + pause batches
POST   /api/agent/resume-calling            ★    un-pause
POST   /api/agent/stale-cleanup             (auth-optional)  fix calls stuck Calling
GET    /api/agent/uploads                   ★    batch list
GET    /api/agent/upload/{batch_id}         ★    batch detail
GET    /api/agent/export/daily-report?date=YYYY-MM-DD ★ xlsx download
GET    /api/agent/export/all-calls?status=&category=&date_from=&date_to= ★ xlsx download
GET    /api/ops/phone-pools                       /ops/phones
POST   /api/realtime/stream-token (REQUIRES admin JWT)   SSE token mint
GET    /api/realtime/events?token=&topics=                SSE stream
GET    /healthz, /readyz, /version                        liveness, readiness, build info
```

Backend `_serialize_call` (in `backend/agent/state.py`) flattens both Mongo-style aliases (`_id`, `name`, `call_status`) AND Postgres-style (`id`, `customer_name`, `status`) so frontend can use either shape.

## 10. Recommended first actions

1. **READ THIS FULL DOC.** Don't `ls -la` yet.
2. **Verify services running:** `curl http://localhost:8200/healthz` + load `http://localhost:3001/ops` in browser. If down, see §11 startup commands. ASK ME before rebooting Docker.
3. **For deeper context, read these files:**
   - `HANDOFF.md` (prior session's deeper architecture notes — different from this file)
   - `DEPLOYMENT.md` (runbook)
   - `frontend/components/shared/Sidebar.tsx` (nav structure)
   - `backend/services/dispatcher.py` (M4 heart)
   - `backend/agent/state.py` (auth + serialization)
4. **Read your auto-memory:** `project_los_overview.md` + `project_los_deep_technical.md` for code-level context built up across sessions.
5. **ASK ME what to do next.** Don't start new work. Don't redo done work. Don't "polish" without asking.

Likely next paths:
- Phase 9 smoke walk-through + targeted fixes
- Phase 10 cutover (only after Phase 9 green)
- New issue I bring up

**Wait for my confirmation before touching code.**

## 11. How to (re)start services (if down)

```bash
# Postgres (Docker — should already be running)
docker ps | grep los-postgres-dev
# If down: docker start los-postgres-dev

# Backend (port 8200)
cd backend
uvicorn main:app --host 0.0.0.0 --port 8200 --reload
# OR if run.sh exists at repo root: bash run.sh

# Frontend (port 3001 — NOT default 3000)
cd frontend
npm run dev -- -p 3001

# Verify
curl http://localhost:8200/healthz   # → 200 ok
curl http://localhost:8200/readyz    # → 200 alive=4/4
```

**Critical env vars** (verify present in `backend/.env`):
- `DATABASE_URL` (postgresql://los_admin:los_dev_pass@localhost:5435/los_form)
- `BACKEND_URL=http://localhost:8200` (NOT 8002 — was a prior bug)
- `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `SARVAM_API_KEY`
- `AISENSY_API_KEY`, `AISENSY_CAMPAIGN_NAME`
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `JWT_SECRET_KEY`
- `SENTRY_DSN` (optional but present in prod)

## 12. Note on superpowers skills

When you receive this handoff, the `superpowers:using-superpowers` skill will fire first. That's fine — invoke it, acknowledge, then come back to THIS doc as your primary context.

**Don't run** `brainstorming` skill — we already know what we're building.
**Don't run** `writing-plans` skill — Phase 9/10 plan is already in §7.

If during Phase 9 you find a real bug, THEN invoke `systematic-debugging` + `test-driven-development` per their normal triggers.

---

**End of handoff. Ready when you've read everything. Reply with 1-line confirmation + your understanding of what state we're in, then wait for my next instruction.**
