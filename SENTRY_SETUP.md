# 🛰️ Sentry Setup — LOS Production Observability

**Audience**: Adil Sheikh (project owner). Step-by-step guide for setting up Sentry projects for the LOS platform across **3 distinct processes** that produce errors.

**Decision matrix** (what gets its own Sentry project, what doesn't):

| Service | Own Sentry project? | Why |
|---|---|---|
| **FastAPI backend** (`backend/main.py`) | ✅ YES — already exists | Python web server, distinct error class. ✅ DONE — DSN configured, events flowing |
| **Next.js frontend** (`frontend/`) | ✅ YES — need to create | Browser + SSR errors. Source maps need upload for readable stack traces |
| **LiveKit Voice Agent** (Python on GPU) | ✅ YES — need to create | Separate Python process, separate concern. Calls/LLM/TTS errors |
| **PostgreSQL** | ❌ NO | Sentry isn't a DB log aggregator. asyncpg integration in backend (already wired) catches query-level errors. For server-level slow-queries/deadlocks → use `pg_stat_statements` + Postgres logs (cron job that tails + alerts on patterns) |
| **Docker containers** | ❌ NO | Container metrics/logs go to `docker logs` + healthchecks. Each containerized Python process has its OWN Sentry init — that's where the events come from |
| **LiveKit server (Go)** | ❌ NO | LiveKit's Go server doesn't ship with Sentry. Use its native OTLP/Prometheus metrics. For voice-call errors, those land in the Python agent's Sentry |

**TL;DR**: 3 Sentry projects total — Backend (done), Frontend (next), Voice Agent (next).

---

## 0️⃣ FIRST: confirm backend Sentry IS working

The backend Sentry IS delivering events — proven via test event ID `10f5f84adeff4d6290c3f19f0554494f`. If you don't see them, you're looking in the wrong region/project.

**Action**:

1. Go to **https://de.sentry.io** (note: `de.` prefix — EU region)
2. Log in with your Sentry account
3. Look for project with **ID `4511420831170640`** (your existing FastAPI project, probably named `los-backend` or similar)
4. Click → **Issues** tab → search for `10f5f84adeff4d6290c3f19f0554494f` OR filter by message `"LOS test event from Adil"`
5. Filter: Environment = **dev**, Time range = **Last 1 hour**

If you see it → great, backend Sentry is healthy. Move on to step 1️⃣.
If you don't see it → check Sentry org membership; share screenshot of your Sentry dashboard so I can debug.

---

## 1️⃣ Create Frontend Sentry project

### On sentry.io

1. **https://de.sentry.io** (same region as backend project)
2. Sidebar → **Projects** → **Create Project**
3. Platform → **Next.js**
4. Alert frequency → **Alert me on every new issue** (sane default for dev)
5. Team → assign to same team as backend
6. Project name: `los-frontend` (or your convention)
7. Click **Create Project**
8. Skip the "Configure SDK" wizard — we already have all SDK code wired
9. Sidebar → **Settings** → **Projects** → **los-frontend** → **Client Keys (DSN)**
10. Copy the **DSN** value. Looks like:
    ```
    https://abc123...@o4511420823764992.ingest.de.sentry.io/<project_id>
    ```

### In your local repo

1. Open `frontend/.env.local` and add these lines:
   ```bash
   NEXT_PUBLIC_SENTRY_DSN=<paste DSN from step 10 above>
   NEXT_PUBLIC_LOS_ENV=development
   NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0.1
   ```

2. (Optional, for production builds with source maps) Sentry org → **Settings** → **Auth Tokens** → **Create New Token** → scopes: `project:releases`, `project:write`, `org:read`. Then add to `.env.local`:
   ```bash
   SENTRY_ORG=<your-org-slug>          # e.g. "vgipl"
   SENTRY_PROJECT=los-frontend
   SENTRY_AUTH_TOKEN=sntrys_xxx        # the token you just created
   ```

3. Restart the frontend:
   ```bash
   pkill -f "next start"  # or kill PID from netstat
   cd frontend && npm run build && npx next start -p 3001 &
   ```

4. **Test it**: open browser console at `http://localhost:3001/ops` and run:
   ```js
   throw new Error("Sentry frontend test - " + new Date().toISOString());
   ```
   Within ~5 sec, that error should appear in your frontend Sentry project's **Issues** tab.

---

## 2️⃣ Create LiveKit Voice Agent Sentry project

Your voice agent runs on a GPU instance at `164.52.217.236` (separate from this dev box). It's a Python process making LLM calls + handling SIP audio. **Errors there are operationally critical** — call failures, LLM timeouts, TTS rejections.

### On sentry.io

1. Same Sentry org. **Create Project** → **Python** → name `los-voice-agent`
2. Copy the DSN

### On the GPU instance (164.52.217.236)

Your voice agent codebase has its own `.env` file. Add:
```bash
SENTRY_DSN_AGENT=<paste DSN>
LOS_ENV=production              # or "staging" if you have separate environments
SENTRY_TRACES_SAMPLE_RATE=0.05  # 5% sampling for cost control
```

If the agent's Python entrypoint doesn't already initialize Sentry, add this near startup:
```python
import os, sentry_sdk
_dsn = os.getenv("SENTRY_DSN_AGENT", "").strip()
if _dsn:
    sentry_sdk.init(
        dsn=_dsn,
        environment=os.getenv("LOS_ENV", "production"),
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.05")),
        send_default_pii=False,
        # Optional: integrate with whatever framework the agent uses
        # (e.g. starlette if it has an HTTP endpoint)
    )
```

Restart the agent. Test by triggering a deliberate exception in a non-critical path.

---

## 3️⃣ How Postgres / Docker / LiveKit-server errors are caught (no separate Sentry needed)

### Postgres errors

- **Query-level errors** (constraint violations, syntax errors, timeouts): Caught by the **backend's asyncpg integration** (Sentry SDK auto-wraps every asyncpg query). Already done. Look in **los-backend** project.
- **Server-level events** (slow queries, deadlocks, vacuum issues, OOM): Need a Postgres log monitor. Recommended setup:
  ```bash
  # Add to your prod box's cron, NOT Sentry:
  */5 * * * * tail -n 1000 /var/lib/postgresql/16/log/postgresql.log | \
              grep -E "ERROR|FATAL|deadlock|out of memory" | \
              # pipe to discord/telegram webhook OR your existing notifier.py
  ```
- For deeper visibility: enable `pg_stat_statements` extension + scrape with `node_exporter` → Grafana. That's not Sentry's job.

### Docker container errors

- Each containerized Python service (backend, workers) has its OWN Sentry init → errors flow from inside the container. ✅ Done.
- Container-level issues (OOM-killed, restart loops): use `docker events` + your `lib/notifier.py` Telegram alerts. Sentry has no native Docker integration.

### LiveKit Go server errors

- LiveKit server logs via stdout. Run with `--log-level info` and pipe to `journalctl` / Loki.
- For audio quality issues: LiveKit exposes Prometheus metrics on `:9090`. Scrape into Grafana.
- For SIP trunk errors (Viva PSTN issues): visible in LiveKit logs + Viva's own portal.
- **Application-level call errors** (agent crashed mid-call): captured by `los-voice-agent` Sentry project (step 2️⃣).

---

## 4️⃣ Production deployment checklist

When you deploy to prod (not just dev), update env vars on each environment:

```bash
# .env.production (or your deploy system's secret store)

# Backend
SENTRY_DSN_BACKEND=<DSN>
LOS_ENV=production
SENTRY_TRACES_SAMPLE_RATE=0.05   # 5% — adjust based on volume + Sentry quota

# Frontend
NEXT_PUBLIC_SENTRY_DSN=<frontend DSN>
NEXT_PUBLIC_LOS_ENV=production
SENTRY_AUTH_TOKEN=<source-map upload token>  # build-time only
SENTRY_ORG=<your org slug>
SENTRY_PROJECT=los-frontend

# Voice Agent (on GPU box)
SENTRY_DSN_AGENT=<agent DSN>
LOS_ENV=production
```

**Sample rates**:
- Backend (high throughput): `0.05` (5%)
- Frontend (browser, lower volume): `0.10` (10%)
- Voice agent (every call matters): `0.20` (20%) or higher

**Cost control**: monitor Sentry quota in **Settings** → **Subscription** → **Usage**. The free tier gives 5k events/month — easy to blow through. Set per-project quotas if needed.

---

## 5️⃣ When something breaks — debugging workflow

1. Error happens in user's browser → Sentry frontend project
2. Error happens in backend API → Sentry backend project
3. Error happens during voice call → Sentry voice-agent project
4. Use Sentry's **trace ID** in each event to correlate across projects (e.g. browser request → backend handler → DB query)

The trace_id is already wired into our backend logs (see `lib/logging_config.py:31` — `CorrelationFilter`). For frontend, Sentry auto-generates a `sentry-trace` header that backend honors via the FastApiIntegration.

---

## Common gotchas

| Symptom | Likely cause | Fix |
|---|---|---|
| "Sentry not showing my events" | Looking at wrong region (US vs EU) | Check DSN host: `*.de.sentry.io` = use `https://de.sentry.io` |
| "Source map not symbolicated" | `SENTRY_AUTH_TOKEN` missing at build time | Set env var, rebuild with `next build`, redeploy |
| "Quota exceeded" | Traces sample rate too high | Lower `SENTRY_TRACES_SAMPLE_RATE` from `1.0` to `0.05` |
| "PII leaking into Sentry" | `before_send` scrubber not running | Confirm `before_send=_before_send` in `sentry_sdk.init()` |
| "Frontend works in dev but not prod" | `NEXT_PUBLIC_SENTRY_DSN` only set in `.env.local`, not `.env.production` | Add to prod env / deploy system secrets |

---

## What I've already wired in the codebase

| File | Purpose | Status |
|---|---|---|
| `backend/main.py:38-97` | Backend Sentry init with PII scrub | ✅ working |
| `frontend/sentry.client.config.ts` | Browser SDK init | ✅ wired (waits for DSN) |
| `frontend/sentry.server.config.ts` | SSR Sentry init | ✅ wired (waits for DSN) |
| `frontend/sentry.edge.config.ts` | Edge runtime Sentry init | ✅ wired (waits for DSN) |
| `frontend/lib/sentry-scrub.ts` | PII redaction (mirrors backend) | ✅ working |
| `frontend/instrumentation.ts` | Next.js 14 instrumentation hook for SSR/Edge | ✅ just added |
| `frontend/next.config.js` | `withSentryConfig` wrap for source maps | ✅ just added (no-op without auth token) |
| `frontend/.env.local.example` | Template showing required env vars | ✅ just added |

**Everything is plumbed. Just paste the DSNs, restart, test.**

---

**Author**: Initial draft by Claude during integration session. Maintain as you add new env-specific overrides.
