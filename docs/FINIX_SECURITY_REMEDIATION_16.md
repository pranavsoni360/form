# Finix — #16 Security Remediation Plan (close unauth endpoints + lock down network)

**Status: IN PROGRESS.** This is the release blocker for selling Finix. Ordered
least-risk-first; every step is independently testable and reversible.

### Progress log
- **2026-08-13 — A.1 SHIPPED to QA (commit 181acd4, verified).** The 3 broken-
  access-control admin endpoints (`/api/admin/applications`, `/api/admin/applications/{id}`,
  `/api/admin/review`) now use `Depends(get_current_admin)`. Verified: a valid
  bank_user token gets **403** (previously **200** with all-bank data). Admin panel
  unaffected (already sends admin token). **QA only — prod still vulnerable until promoted.**
- Finding: QA JWT secret is a real 62-char value in `backend/.env.qa` (not the
  `your-jwt-secret-key` code default) — good. Confirm prod's `.env` likewise; the
  code default must never be what's live (token-forgery risk, ties to #13).
- **2026-08-14 — Ops-console token wiring SHIPPED to QA (commit 1a05f4e, verified built).**
  The `/ops/*` pages now send the admin Bearer token on every API call via new
  `opsFetch` (lib/ops-fetch.ts) + `authHeader` (lib/auth). 22 sites across 11 pages.
  Purely additive — backend still permissive, so no behavior change yet — but this
  is the prerequisite for making the agent router strict without breaking the ops
  console. Typechecks clean; built bundle confirmed to contain the wiring.
- **NEXT (the strict flip):** harden `get_current_bank_user` (state.py:375) so
  no-token → 401 and admin-token → operator scope; then add `Depends(get_current_bank_user)`
  to the 23 A.2 agent endpoints. Verify each: curl no-token → 401, admin-token → 200.
  ⚠️ Both the bank portal AND ops console now send tokens, but confirm the ops
  console UI end-to-end (real login) right after the flip — curl proves the backend,
  not the browser session.
- Remaining after that: A.4 LRS (bank-scoping), A.5, Stage 0 network bind, prod promotion.

---

## The core vulnerability

`get_current_bank_user` (`backend/agent/state.py:375`) uses
`HTTPBearer(auto_error=False)` and, when **no token** is presented, returns:

```python
{"user_id": "operator", "role": "operator", "bank_id": None, "user_type": "operator"}
```

`_bank_filter` (`state.py:410`) then sees `bank_id=None` and emits `"TRUE"` — i.e.
**no tenant filter**. Net effect: any endpoint depending on `get_current_bank_user`,
called **without a token**, returns/mutates **every bank's data**.

Because the backend also binds `0.0.0.0:8200` (prod) / `:8300` (QA) with **no
firewall** (see `[[project_los_network_exposure]]`), those endpoints are reachable
**anonymously from the internet**, not just through nginx.

This is a cross-tenant data breach in a product we intend to sell to multiple banks.

### Why it wasn't just made "strict" already
"Operator mode" (see all banks) is **intentional** for VGIPL's internal ops
console. The bug is that it's granted by the *absence* of a token instead of by a
*real operator credential*. The fix must preserve operator mode via authentication.

### Key enabler (makes this tractable, not a rewrite)
The admin login **already issues** JWTs with `user_type="admin"`
(`backend/main.py:1504`). Operators already authenticate and already hold a valid
token. So the fix is to *accept that existing token* for operator scope and reject
no-token — not to build a new auth system.

---

## Endpoint inventory (the problem set)

> Finalized from a full route sweep. Grouped by severity. Columns: method+path ·
> file:line · current auth · exposure.

**A. WEAK (no-token ⇒ operator ⇒ all-bank data) — fix first**
- The agent router endpoints depending on `get_current_bank_user`
  (`backend/agent/calls.py`, `batch.py`) — call lists, call detail, transcripts,
  analytics, batch data. _(exact list appended from the sweep.)_

**B. NONE (no auth dependency at all)**
- `GET /export/all-calls` (`agent/calls.py:~680`) and
  `GET /export/daily-report` (`agent/calls.py:~623`) — full call-data CSV exports,
  no auth. The frontend triggers them via `window.location.href`, which **cannot
  send an Authorization header** — so they were left open. Fix needs a
  download-friendly auth (short-lived signed token in the query string, or a
  cookie set at login), not a Bearer header.

**C. PUBLIC-BY-DESIGN (leave open, but confirm each)**
- Form submission, OTP, upload-by-token, health (`/healthz` `/readyz`), agent/SIP
  webhooks (already loopback-gated by `restrict_internal_paths`, `main.py:164`).

_(The complete enumerated table is maintained in the appendix at the bottom.)_

---

## Remediation — staged

### Stage 0 — Network lockdown (fast, high-value, low-risk)
Bind the app servers to loopback so only nginx can reach them.
- `scripts/deploy.sh:399` (and the QA unit): `--host 0.0.0.0` → `--host 127.0.0.1`.
- Verify nginx upstreams are already `127.0.0.1:8200/8300` (they are).
- **Test:** from another host, `curl https://<server>:8200/...` must fail to
  connect; the public nginx URL (`:443` / `:8445`) must still work.
- **Rollback:** revert the one line, redeploy.
- This alone removes anonymous internet reachability even before the auth fix.

### Stage 1 — Fix the auth dependency (the core fix)
Rewrite `get_current_bank_user` (`state.py:375`):
- **No credentials → `raise HTTPException(401)`** (remove the operator fallback).
- **Token `user_type="admin"` → operator mode** (`bank_id=None`, sees all) — this
  is how VGIPL ops keeps cross-bank access, now credentialed.
- **Token `user_type="bank_user"` → bank scoping** (unchanged).
- Keep a single helper so operator-vs-bank scoping stays in one place.
- **Test (from the #12 pattern):** table-driven — no token ⇒ 401; admin token ⇒
  all banks; bank_user token ⇒ only that bank; another bank's token ⇒ cannot read
  the first bank's rows. Add these to `backend/tests/`.

### Stage 2 — Fix the unauthenticated exports
`/export/all-calls`, `/export/daily-report`:
- Add auth. Since these are browser downloads (no header), issue a **short-lived
  signed download token** (HMAC, ~60s, scoped to the export + bank) that the
  frontend appends as `?t=…`; the endpoint verifies it. Alternative: an
  auth cookie set at login and checked here.
- Enforce **bank scoping** in the query (operators unrestricted, bank users
  filtered) — same rule as Stage 1.
- **Test:** no/expired token ⇒ 401; bank user's export contains only their rows.

### Stage 1b — Agent router (A.2/A.3, 23 endpoints) — DESIGN (from ops-console auth mapping)

**Consumers & their current auth:**
- **Bank portal** (`app/bank/*`) — already sends `Authorization: Bearer <bank token>`. ✅ No change.
- **Ops console** (`app/ops/*`) — authenticated (layout gates on `los_admin_token` via
  `ensureValidToken("admin")`, redirects to `/admin/login`), BUT page fetches use
  `credentials: "include"` (httpOnly *refresh* cookie, which API routes don't validate) —
  they do **not** send the admin token as a Bearer header. The token exists in
  localStorage; it's just not attached. One-off exception: `app/ops/batch/page.tsx:126`
  already sends it.

**Fix:**
1. Backend — harden `get_current_bank_user` (`agent/state.py:375`): no token → 401;
   `user_type=="admin"` → operator (all banks); `user_type=="bank_user"` → bank-scoped.
   Add `Depends(get_current_bank_user)` to the 23 A.2 endpoints (no dep today); A.3's 4
   already have it.
2. Frontend ops — attach `Authorization: Bearer <los_admin_token>` to every `app/ops/*`
   backend call. Best via a single shared `opsFetch`/`opsPost` helper (wrap
   `ensureValidToken("admin")` + header) replacing the ad-hoc `credentials:"include"`
   fetches and the local `postJson` (batch:946). ~7 pages.
3. Exports via `window.location.href` (can't send headers) → fetch+blob with the header
   (ops/exports already does a blob download), or a signed one-time download token.

**⚠️ DEPLOY ORDERING (critical — reverse order breaks the ops console):**
1. Ship the **frontend** token-sending FIRST. Backend still accepts no-token, so nothing
   breaks; ops console now sends Bearer on every call. Verify ops console fully works.
2. THEN ship the **backend** strictness. Ops sends tokens → works; anonymous → 401.
3. Verify: anon `curl /api/agent/calls` → 401; bank token → only that bank; admin token → all.

### Stage 3 — Sweep the remaining NONE/WEAK endpoints
For every row in the appendix table:
- Data-reading or mutating ⇒ add the Stage-1 dependency + bank scoping.
- Internal-only (webhooks, cleanup) ⇒ ensure it's in `_LOCAL_ONLY_PATHS`
  (`main.py:151`) so the loopback middleware covers it.
- Anything truly public ⇒ document *why* in a comment so it's an explicit decision.

### Stage 4 — Defense in depth
- Confirm the ops console frontend sends its admin token on the now-strict agent
  endpoints (it logs in as admin, so it has one — verify the fetch calls attach it).
- Consider a firewall (ufw) allowing only 80/443/8445 + SSH as a backstop, even
  with loopback binding.
- Add a CI test that fails if any `get_current_bank_user` route is reachable
  without a token (regression guard).

---

## Suggested execution order (post-demo)
1. **Stage 0** (network bind) — minutes, removes the anonymous door immediately.
2. **Stage 1** (auth dependency) + its tests — the core fix.
3. Verify the ops console still works end-to-end with its admin token (Stage 4a).
4. **Stage 2** (exports), **Stage 3** (sweep), **Stage 4** (firewall + CI guard).

Each stage deploys and verifies on QA first (finix.vgipl.com:8445), then promotes
to prod via the same merge flow used for the multi-bank rollout.

---

## Appendix — full endpoint enumeration (40 problem endpoints)

### A.1 — Broken access control: "admin" endpoints with NO role check (MOST SEVERE)
`Depends(security)` + manual `jwt.decode` but never check `user_type=='admin'` — so **any** valid JWT (incl. a bank officer's) works:
- `GET /api/admin/applications` (main.py:1926) — all loan apps across all banks (PII)
- `GET /api/admin/applications/{app_id}` (main.py:1960) — full app incl. **decrypted Aadhaar** (1971-1972)
- `POST /api/admin/review` (main.py:3020) — **approves/rejects any loan** + WhatsApps customer
- Fix: `Depends(get_current_admin)`. ⚠️ VERIFY who calls /api/admin/review — bank officers may use it; they should use `/api/bank/applications/{id}/officer-approve` instead.

### A.2 — Fully unauthenticated agent router (NONE) — `/api/agent/*`
Call data / exports / **mass-calling control**:
calls: /calls (calls.py:113), /call/{id} (70), /call/{id}/transcript (92), PUT /calls/{id}/categorize (273), /dashboard-stats (437), /funnel (504), /analytics (588), **/export/daily-report (622)**, **/export/all-calls (679)**, POST /stale-cleanup (849).
batch: **POST /upload-excel (batch.py:570)**, **POST /batch-call (796)**, /batch-status (865), POST /batch-retry (943), **POST /emergency-stop (1019)**, POST /resume-calling (1089), POST /stop-batch (1099), /uploads (1205), /upload/{id} (1233), **/upload/{id}/download (1258)**, /recent_calls (1320).
callbacks: **POST /schedule-callback-manual (callbacks.py:64)** (NOT in _LOCAL_ONLY_PATHS), /scheduled-callbacks (134).

### A.3 — WEAK-BANK (state.py bypass → no token = operator sees all banks)
- /calls/{id} (calls.py:208), /calls/{id}/transcript (226), **/calls/{id}/recording (250)**, /live-status (806)

### A.4 — LRS credit scoring (NONE) — `/api/lrs/*`
- GET /score/{id} (lrs/routes.py:34), POST /rescore/{id} (51), POST /rescore-pending (77), GET /config (110), **PUT /config (119)** ← anyone rewrites the live scorecard

### A.5 — Ops + misc (NONE)
- GET /api/ops/in-flight-calls (ops.py:226), GET /api/ops/errors (307), GET /api/ops/phone-pools (138)
- **POST /api/generate-form-links (main.py:2324)** — creates form_tokens w/ customer PII, returns links, no auth
- GET /api/code-list/{id} (main.py:3419) — low sensitivity

### Fix dependencies available (no new auth system needed)
- `get_current_admin` (main.py:1183, STRICT) — for A.1, A.4 PUT config, admin-grade actions
- STRICT `get_current_bank_user` already exists in main.py:1198 (the good one); the WEAK one is state.py:375
- `restrict_internal_paths` middleware (main.py:164) + `_LOCAL_ONLY_PATHS` (main.py:151) — add internal-only routes here (e.g. schedule-callback-manual)

### Public-by-design (leave open — confirmed): auth endpoints, customer form/OTP/token flow, loopback webhooks, health probes, HMAC-signed ingest, SSE token-scoped.

