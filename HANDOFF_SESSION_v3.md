# LOS — Session v3 Handoff (2026-05-22)

**Branch:** `feature/m6-realtime-backbone`  ·  **Latest commit:** `dd9528e`  ·  **Last session: 11 commits, all pushed**

---

## 1. What this project is

Loan Origination System for **Pusad Urban Bank**, designed to scale to **multiple banks** as multi-tenant SaaS. Three surfaces + ops console:

- `/admin` — super-admin (Vaani team): manages banks, vendors, partnerships, system-wide views
- `/bank` — bank staff (officer / supervisor): reviews applications, runs batches, assigns vendors
- `/vendor` — NBFC partner: receives bank-approved loans, accepts/rejects, disburses, settlements
- `/ops` — operations console: live calls, errors, phone pool, workers, batch, callbacks (admin-gated)

Stack: **Next.js 14 (prod build) :3001**, **FastAPI :8200**, **Postgres :5435** (Docker container `los-postgres-dev`), self-hosted **LiveKit** on GPU box at `164.52.217.236`.

---

## 2. What this session shipped (11 commits)

| # | Commit | Theme | What |
|---|---|---|---|
| 1 | `eb29740` | **Phase G Step 2** | Backend vendor portal — 18 endpoints (admin CRUD, partnerships M:N, bank-side assign/withdraw, vendor self-serve accept/reject/disburse, settlements). Atomic disburse-+-settlement transaction. State machine enforced. |
| 2 | `a3e0121` | **Phase G Steps 3-4** | Vendor portal frontend (7 routes) + `/admin/vendors` (CRUD + side drawer with users & partnerships) + bank-side `AssignVendorPanel` on app detail page. |
| 3 | `59578ba` | Polish | Nav entry points (admin dashboard "Vendors" button, root `/` has 3 portal links), `useSearchParams` Suspense fix for `/vendor/login`, removed SSR auth-gate flash. |
| 4 | `372967d` | **2 SSE bugs** | (a) STREAM stuck `DISCONNECTED` after login → `setAccessToken` now dispatches `los-auth-changed` DOM event; `RealtimeProvider` listens + reconnects. (b) Errors multiplied on reload (8 → 16 → 24) → `errorsReducer` dedups by `(correlation_id, ts)`. |
| 5 | `8c6e814` | `/ops/errors` UX | (a) Filter auto-widens (5m → 1h → today → all) until something is in view (pins on first user click). (b) Dedup fallback for `correlation_id = "-"` events (uses source + exc_type + ts + message). |
| 6 | `6efa578` | **Browser error capture** | New endpoint `POST /api/internal/frontend-error` (JWT-gated, no HMAC needed). New `lib/browser-error-reporter.ts` installs `window.error` + `unhandledrejection` listeners; fires through `app/providers.tsx`. Now every browser JS crash flows to `/ops/errors` automatically. |
| 7 | `7c97243` | Legacy bug | `/api/agent/stale-cleanup` required `bank_user` JWT but `/ops/batch` is admin context → silent fail. Dropped the dep (function body already says "operator, no bank scoping"). |
| 8 | `9b3a09d` | **Multi-bank P1** | (a) Migration v12: `banks.vendor_limit INTEGER NOT NULL DEFAULT 10`. (b) `POST /api/admin/partnerships` enforces cap with FOR UPDATE row lock. (c) `GET /api/admin/partnerships` returns `bank_caps` for UI. (d) Admin/vendors form shows "5/10 vendors", disables banks at cap. (e) NEW `/admin/applications` list (system-wide search/filter). (f) NEW `/bank/applications` list (bank-scoped). |
| 9 | `e4ae56e` | **Error persistence** | Migration v13: `system_errors` table with indexes. `event_bus.publish("errors", ...)` now async-INSERTs to DB. New `GET /api/ops/errors?limit=N&source=&since_ts=` for page hydration. `useEventStream` extended with optional `seed` callback. Page survives backend restarts. |
| 10 | `86f3c59` | Auto-cleanup | APScheduler daily job at 03:00 IST: `DELETE FROM system_errors WHERE ts < (now - LOS_ERROR_RETENTION_DAYS)`. Default 1 day. Manual trigger: `POST /api/ops/errors/cleanup?days=N`. |
| 11 | `dd9528e` | Defense-in-depth | `/ops/errors` page now has 3 independent layers: SSE live + REST seed on mount + 15s REST poll fallback. `mergedRecent` dedups (correlation_id, ts) across all three. Reads `NEXT_PUBLIC_API_URL` directly (no dynamic import bailout). `cache: "no-store"`. Console logs on every state. **Page is now impossible to leave empty if DB has rows.** |

### Database migrations applied this session
- `migration_v12_vendor_limit.sql` — `banks.vendor_limit`
- `migration_v13_system_errors.sql` — durable error log

---

## 3. Test users (for the new session to log in)

```
ADMIN:    admin@bank.com / admin123
VENDOR:   bfl_e2e / vendor123pass   (vendor "Bajaj Finance E2E")
BANK:     create fresh via POST /api/admin/banks/{id}/users (returns generated_password once)
```

Existing test data in DB:
- 1 bank (Pusad Urban Bank E2E, `vendor_limit=10`)
- 3 vendors (Bajaj Finance E2E, OverCap test leftovers, Unpartnered Co)
- 2 active partnerships
- 5 loan applications
- 4 vendor assignments
- 1 settlement (₹4,95,000 disbursed, ₹49,500 commission)
- 11+ errors in `system_errors` covering all 7 sources

---

## 4. Current architecture (post-session)

### Error pipeline (final, durable)

```
   error happens anywhere
            │
   event_bus.publish("errors", payload)
            │
   ┌────────┼────────┐
   ▼        ▼        ▼
 SSE      system    Sentry
 ring     _errors   (long
(in-mem)   (DB)     archive)
   │        │
   └────┬───┘
        ▼
  /ops/errors page
   - SSE live   ─┐
   - REST seed   ├─ mergedRecent (dedup)
   - 15s poll   ─┘
        ▼
  03:00 IST APScheduler
  DELETE WHERE ts < (now - retention_days)
  default retention: 1 day
```

### Sources captured (all flow to /ops/errors)

| Source | Capture path | Status |
|---|---|---|
| backend | global exception handler | ✅ auto |
| browser | window.error + unhandledrejection → POST /api/internal/frontend-error (JWT) | ✅ auto |
| agent | POST /api/internal/errors (HMAC) | ⚠ needs `LOSWebhookHandler` in agent.py |
| livekit / sip / docker | gpu-error-tailer.sh on GPU box → webhook | ⚠ script ready, not deployed |
| postgres | log tailer (planned) | ⚠ optional |

### Vendor portal flow

```
1. super-admin (/admin/vendors) → New vendor (Bajaj Finance)
2. super-admin → drawer → Add User (vendor login creds)
3. super-admin → drawer → Add Partnership (pick bank, commission %)
   - blocked if bank.vendor_limit reached
4. bank supervisor (/bank/applications/[id]) → AssignVendorPanel
   - shows partnered vendors with commission %
   - "Assign to vendor" creates assignment (pending)
5. vendor (/vendor/login → /vendor/dashboard) → see new assignment
   - Accept → status=accepted
   - Reject (with reason) → status=vendor_rejected, app free to reassign
   - Disburse (amount + ref) → atomic: assignment=disbursed +
     vendor_settlements row created with commission snapshot +
     loan_applications.disbursed_at stamped
6. vendor (/vendor/settlements) → see commission + bank payout
```

---

## 5. Current state — verified up + healthy

```
postgres   :  Up 29h healthy        Docker container "los-postgres-dev" on :5435
backend    :  uvicorn :8200         4/4 workers alive, APScheduler running
                                    (batch_runner, analytics_runner, error_cleanup)
frontend   :  next start :3001      production build, ~120MB RAM
                                    chunk hash page-4cd82c9b10ff5fa8.js
/ops/errors:  11+ events in DB, 7 sources, daily cleanup at 03:00 IST
```

Manual processes I touch:
- `taskkill //IM uvicorn.exe //F && cd backend && nohup ./venv/Scripts/uvicorn.exe main:app --host 0.0.0.0 --port 8200 > /tmp/backend.log 2>&1 &`
- `cd frontend && rm -rf .next && npx next build && nohup npx next start -p 3001 > /tmp/frontend.log 2>&1 &`

---

## 6. Open items for the next session

### Pending user actions (NOT my code work)
1. **Deploy `scripts/gpu-error-tailer.sh` + `.service`** on GPU box `164.52.217.236` — turns on livekit/sip/docker auto-capture
2. **Drop `LOSWebhookHandler` snippet** into voice agent `agent.py` — turns on real-time agent crash reporting
3. **Create new Sentry projects** for frontend + voice-agent per `SENTRY_SETUP.md`

### Could be next code work (P2 multi-bank)
- **Per-bank branding** — read `banks.logo_url` / `banks.name` on `/bank/login` chrome (subdomain or `?bank=PUSAD` query param)
- **`/bank/settings`** — bank-admin can manage their own users (reduce support load)
- **`/admin/settings`** — system-wide config (default commission, notification settings)
- **Subdomain routing** — `pusad.virtualvaani.com` → bank PUSAD context
- **Re-style `/admin/dashboard`** with portal-ui aesthetic (currently uses older Tailwind layout)

### Could be next session work (anything from the user)
- More vendor reporting / financial reconciliation features
- Bank-side analytics dashboards
- Voice agent improvements
- LiveKit deployment work on the GPU box

---

## 7. Critical rules for the next session

These were learned during this session (often the hard way):

1. **DO NOT run `next build` while `next dev` is running** — corrupts `.next/` chunks → dynamic routes 500. Kill dev first.
2. **DO NOT use `set -H` (default in some bash)** when handling generated passwords — `!` triggers history expansion. Always `set +H`.
3. **Postgres `INSERT ... RETURNING id` in heredoc** prints `id\nINSERT 0 1` — strip the count line: `... | grep -E '^[0-9a-f-]{36}$' | head -1`
4. **Backend restarts wipe in-memory ring buffer** — that's why we added `system_errors` DB persistence + cleanup job.
5. **Switch to `next start` (production) over `next dev`** for daily use — drops RAM from 1.1 GB → 120 MB and pages load in <100ms instead of multi-second compile-on-route.
6. **User wants minimal surgical changes** — don't restructure when adding features. Add files, edit minimally.
7. **`pg_backup.sh` + `restore_test.sh` exist** in `scripts/` — M8 backups, don't reinvent.
8. **Test users persist** in DB across sessions — re-use `admin@bank.com/admin123` and `bfl_e2e/vendor123pass` (don't recreate).
9. **`x-correlation-id` middleware** stamps every response — useful for grepping logs.
10. **All commits in this session ended with `Co-Authored-By: Claude Opus 4.7 (1M context)`** — follow the same convention.

---

## 8. M1-M8 status (all verified live)

| M | What | Last verified |
|---|---|---|
| M1 | Observability — JSON logs, correlation IDs, Sentry, Telegram notifier | ✅ this session |
| M2 | DB foundation — migrations runner, phone_pools, jobs, metrics tables | ✅ |
| M3 | Async job queue — 4 workers polling `call_processing_jobs`, handlers registered | ✅ (enqueued test job, status went pending→dead with error stamped) |
| M4-lite | Concurrent batch dispatcher (asyncio.gather replacing sequential loop) | ✅ |
| M5 | Error handling — `/healthz`, `/readyz`, circuit breakers, retry, global handler→SSE | ✅ |
| M6 Chunk A | Frontend foundation — shadcn, portal-ui, Sentry SDK | ✅ |
| M6 Chunk B/C | Realtime backbone — event_bus, SSE, ring buffer + DB persistence | ✅ (this session added DB persistence) |
| M8-lite | Nightly pg_dump backups + restore drill + DB pool tuning | ✅ scripts present |

---

## 9. Files added/changed reference (this session)

```
NEW:
  database/migration_v12_vendor_limit.sql
  database/migration_v13_system_errors.sql
  backend/routers/vendors.py
  frontend/app/vendor/{layout,page,login,dashboard,applications,applications/[id],settlements}.tsx
  frontend/app/admin/{vendors,applications}/page.tsx
  frontend/app/bank/applications/page.tsx
  frontend/components/{vendor/{VendorShell,StatusBadge},bank/AssignVendorPanel}.tsx
  frontend/lib/browser-error-reporter.ts

MODIFIED (additive):
  backend/main.py — mount vendor router
  backend/lib/event_bus.py — DB persistence helper
  backend/routers/internal.py — /frontend-error endpoint
  backend/routers/ops.py — /api/ops/errors GET + /cleanup POST
  backend/routers/vendors.py — vendor_limit enforcement
  backend/agent/batch.py — _scheduled_error_cleanup
  backend/agent/calls.py — stale-cleanup auth fix
  frontend/lib/auth/index.ts — dispatch los-auth-changed event
  frontend/lib/realtime/RealtimeProvider.tsx — listen for auth-changed
  frontend/lib/realtime/reducers.ts — dedup logic
  frontend/lib/realtime/useEventStream.ts — optional seed callback
  frontend/lib/api/{index,vendor}.ts — vendor API client
  frontend/app/providers.tsx — install browser-error-reporter
  frontend/app/admin/{dashboard,vendors}/page.tsx — nav entries + vendor_limit UI
  frontend/app/bank/{dashboard,applications/[id]}/page.tsx — view-all link + AssignVendorPanel
  frontend/app/page.tsx — staff portal footer links
  frontend/components/shared/Sidebar.tsx — Vendors link
  frontend/app/ops/errors/page.tsx — seed + fallback poll + mergedRecent
  frontend/app/vendor/login/page.tsx — Suspense boundary
  frontend/app/vendor/layout.tsx — short-circuit isLogin
```

---

## 10. Quick sanity check for the new session

Run this to verify everything's healthy before starting work:

```bash
# Infra
curl -sS http://localhost:8200/healthz                  # → {"status":"ok"}
curl -sS http://localhost:8200/readyz                   # → checks: db ok, workers alive=4/4
curl -sS -o /dev/null -w "%{http_code}" http://localhost:3001/   # → 200

# Errors page has data
curl -sS "http://localhost:8200/api/ops/errors?limit=5" | python -c "import sys,json;print(len(json.load(sys.stdin)['errors']))"
# → ≥1

# Auth tokens
curl -sS -X POST http://localhost:8200/api/admin/login -H 'Content-Type: application/json' -d '{"email":"admin@bank.com","password":"admin123"}'
# → returns 251-char token

# Browser path
# http://localhost:3001/admin/login → admin@bank.com/admin123 → "Ops Console" → /ops/errors → see ≥11 events with colored badges
```
