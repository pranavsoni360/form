# Finix — deep system audit, 2026-08-21

Scope: full backend (166 routes, 69 files), frontend, database (QA + prod),
docker/voice infra, external integrations. Verified against the running system
where reachable, and against source everywhere.

**Handle this file as confidential.** It describes live, unpatched weaknesses.

---

## 1. Verdict

The `main.py` / `bank_admin.py` / `vendors.py` layer is genuinely well built:
every decision endpoint pins `WHERE id = $1 AND bank_id = $2`, every state
change pins `status = ANY(...)` with an affected-row check, the customer OTP
flow has no IDOR, money columns are all `numeric`, JWTs are HS256-pinned, and
`restrict_internal_paths` fails closed against `X-Forwarded-For` spoofing.

The problem is that a second, weaker trust model grew up beside it. `agent/*`,
`lrs/*` and `routers/ops.py` import a different `get_current_bank_user` that
read scope from the JWT instead of the DB, and their handlers resolved rows by
id while ignoring the caller's bank. That divergence is the source of almost
every finding below.

| Area | State |
|---|---|
| Calling / voice pipeline | healthy; error reporting was dead, now fixed |
| Infra (services, DB, docker, scheduler) | healthy |
| Loan decision path (`main.py`) | sound |
| Agent / LRS / ops routes | **was** cross-tenant; fixed in `30cd25b` |
| Document upload | **was** arbitrary root file write; fixed in `30cd25b` |
| Network exposure | **open — needs a decision (§5.1)** |
| Prod schema vs code | **drifted — vendor onboarding is dead in prod (§5.2)** |
| Rate limiting | **absent (§5.3)** |

---

## 2. Fixed and verified

### 2.1 Calling / agent errors never reached the pipeline — `0cc4de8`

Three independent defects, all confirmed on the box:

1. `los_error_reporter.install()` runs at module import (agent_core imports it
   before the LiveKit worker loop exists) and resolved the loop with
   `asyncio.get_event_loop()`. On Python 3.12 that returns a **brand-new loop
   that never runs**; every report was queued onto it and lost, leaving only a
   `coroutine ... was never awaited` warning. The loop is now captured lazily on
   first report, and a closed/idle loop is replaced rather than reused.
2. The backend serves TLS on loopback with a cert issued for its public
   hostname, so `https://127.0.0.1:<port>` fails hostname verification and the
   POST died inside `_post()`'s debug-level catch. `LOS_REPORT_TLS_VERIFY=0`
   now disables verification for that hop only (never leaves the box, and the
   body is HMAC-signed regardless).
3. The worker health-check HTTP ports (8081–8086) were on `0.0.0.0` because
   that is `WorkerOptions`' default. Nothing dials in — the worker dials out to
   LiveKit — so the only traffic was internet scanners, each malformed request
   logging an aiohttp traceback. Bound to loopback via `AGENT_HTTP_HOST`.

Also stopped the tailer forwarding scanner noise: **232 of the 253 rows in
production `system_errors` were SIP "Read error" on `transport<TCP>`** (port
5060 is internet-facing) plus the aiohttp probe tracebacks above. That noise
buried real failures and would have flooded the notification bell.

Verified end to end on QA: a `logger.error` inside a real agent process →
`system_errors` row (source=agent) → `security_events` notification
"Calling system error". Tests: `agent/tests/test_los_error_reporter.py`, 19 pass
on the new build, 11 fail against the old one.

### 2.2 Arbitrary root-owned file write + stored XSS — `30cd25b`

`/api/upload-document` and `/api/upload-document-session` built the on-disk
filename from two browser-controlled values with no filtering:

```python
ext = file.filename.split('.')[-1] if '.' in file.filename else 'bin'
filename = f"{document_type}_{int(now_utc().timestamp())}.{ext}"
filepath = loan_dir / filename          # <- traversal sink
```

* `document_type="../../../../etc/profile.d/x"` walks straight out of
  `UPLOAD_DIR`. The process runs as root. Reproduced: the old formula resolves
  to `/etc/...`, outside the upload root.
* The type check inspects only the client-supplied `Content-Type`, while the
  stored extension comes from the client-supplied filename — `payload.html`
  declared as `image/png` was stored as `.html` and served from the public
  `/uploads` mount as HTML. Stored XSS on our own origin.

Both now go through `safe_upload_filename()`: label reduced to
`[A-Za-z0-9_-]{,40}`, extension restricted to `jpg/jpeg/png/pdf` (anything else
becomes `.bin`). Sanitising rather than rejecting, so every label the frontend
actually sends (`doc.key.replace('_url','')`, `quotation`) is unchanged — the
`loan_applications` URL column keeps updating. 42 tests.

### 2.3 Auth on the ~34 routes behind `agent/state.py` — `30cd25b`

* **Refresh tokens worked as access tokens.** A refresh token carries the same
  claims and differs only by `"type"`, which nothing checked — so it was a valid
  bearer credential for its full 9 hours *and survived logout*, since logout
  deletes the `refresh_tokens` row but the JWT still verifies. Now denied
  explicitly (deny `type == "refresh"` rather than require `type == "access"`,
  so legacy tokens minted without the claim keep working).
* **Scope, role and active-status now come from the DB row.** Reading them from
  the token meant deactivating a user applied on `/api/bank/*` but silently did
  not apply to any of these routes until the token expired, and a stale
  `bank_id`/`role` claim was trusted verbatim. `branch_id` is now returned too.
* A non-UUID `user_id` claim reached `uuid.UUID()` unguarded → 500. Now 401.
* **`agent/state.py` had its own `JWT_SECRET` with a silent dev fallback**
  (`"your-jwt-secret-key"`). `main.py` refuses to boot in prod/staging with the
  placeholder; this copy would have happily verified tokens signed with the
  public literal. Same guard applied.

21 tests, including "a stale bank_id claim is ignored" and "a deactivated user
is rejected".

### 2.4 Cross-tenant access — `30cd25b`

Every one of these had the caller's `bank_id` resolved by the dependency and
then ignored by the handler. A platform operator (admin token, `bank_id` NULL)
stays deliberately cross-bank in all of them.

| Endpoint | What one bank officer could do |
|---|---|
| `GET /api/lrs/score/{id}` | read any bank's credit file incl. `raw_provider_data` (raw bureau/KYC) |
| `POST /api/lrs/rescore/{id}` | overwrite another bank's `system_score`/`system_suggestion`, re-fire paid bureau lookups |
| `POST /api/lrs/rescore-pending` | queue 500 forced rescores **across every tenant** — no predicate at all |
| `POST /api/agent/batch-call` | start another bank's batch; with no id, whatever batch was newest platform-wide |
| `POST /api/agent/batch-retry` | re-dial another bank's failed calls, on their money |
| `POST /api/agent/stop-batch` | kill another bank's live rooms |
| `GET /api/agent/batch-status` | platform-wide call counters |
| `phone_number_id` (upload-excel, batch-call) | dial a whole campaign **from another bank's caller ID** |
| `POST /api/agent/stale-cleanup` | hard-DELETE in-flight rows and fail live calls for every tenant |
| `GET /api/agent/scheduled-callbacks` | up to 200 of every bank's leads per request, with aadhar/pan/income/employer/address flattened to the top level — no id to guess |
| `GET /api/ops/phone-pools` | every tenant's numbers and trunk ids (query had no `WHERE` at all) |
| `GET /api/ops/in-flight-calls` | other banks' live customer names and phones |
| `GET /api/ops/errors` | the platform-wide exception stream with traces |

`/api/ops/phone-pools` is read by the **bank** batch screen for its caller-ID
dropdown, so it stays available to bank users — scoped, not forbidden.
`/api/ops/errors` has no tenancy column to scope by and is now operator-only.

`lrs_scores` carries no `bank_id`, so ownership is checked against the parent
`loan_applications` row; missing and out-of-scope return the same 404 so it is
not an existence oracle. 32 tests.

### 2.5 Privilege gates — `30cd25b`

* `PUT /api/lrs/config` accepted `bank_officer` — the bank's most junior role —
  for publishing the live scorecard that decides every subsequent credit
  decision. Restricted to `bank_admin`; `GET` stays open so the editor loads.
* `disburse` and `supervisor-reject` were missing the maker-checker test that
  `supervisor-approve` has. **Correction to the audit finding:** this was *not*
  an exploitable bypass — the v38 `chk_maker_ne_checker` CHECK does block the
  write. It surfaced as an unhandled `CheckViolationError` → HTTP 500. Now the
  same clear 403.
* Legacy `POST /api/admin/login` (superseded by `/api/auth/admin-login`, and no
  longer called by the frontend — only a doc example) was missing **both** the
  account lockout and the failed-attempt counter, so choosing that URL bypassed
  lockout entirely and allowed unlimited guessing against super-admin accounts.
  It also minted a **7-day** token with no `refresh_tokens` row that no logout
  could revoke. Now the same controls and the same 30-minute token as the
  primary path. Recommended follow-up: delete the route.

---

## 3. Test position

`226 passed, 6 skipped` — up from 138. New suites:

| Suite | Tests | Pins |
|---|---|---|
| `tests/test_upload_filename_safety.py` | 42 | traversal, dangerous extensions, real labels unchanged |
| `agent/tests/test_bank_user_auth.py` | 21 | refresh denial, DB-sourced scope, deactivation |
| `agent/tests/test_batch_tenancy.py` | 16 | batch + phone + ops predicates |
| `lrs/tests/test_routes_tenancy.py` | 16 | credit-file scope, bulk rescore, scorecard gate |
| `agent/tests/test_los_error_reporter.py` | 19 | the error-pipeline regressions |

**A note on the existing LRS suite:** running it with `.env.qa` sourced makes
`test_rigorous` and `test_service` fail — because the real VG Docverify provider
is then selected and a fake PAN has no bureau record. Not a product bug, but two
things worth knowing: the suite makes **live outbound calls to the vendor API**
when the env is present (it should force `VG_MOCK_MODE`), and when the bureau
has no record the `credit_bureau` pillar (30% weight) is dropped and the score is
re-weighted across the remaining 70%. That is a **credit-policy** question: a
thin-file applicant is scored on 70% of the scorecard and can come out looking
like a good one.

---

## 4. Corrections to the audit's own findings

Recorded so they are not "fixed" into regressions:

* **`phone_numbers` does have `bank_id`** (added in v26). One report claimed
  ownership was only reachable via `phone_pools`. The scoping fix uses
  `phone_numbers.bank_id` directly, and treats NULL as a shared/platform number
  (the v27 backfill leaves NULLs) so shared numbers keep working.
* **The maker-checker "bypass" is not a bypass** — see §2.5.
* **`agent/tests/test_bank_user_auth.py` was not silently dead.** It was
  reported as erroring on every run; on the server's Python 3.12 those tests
  passed (`get_event_loop()` only warns). They would error on 3.11. Rewritten
  to `asyncio.run` either way.
* `/api/agent/form-data/{call_id}` and `/api/agent/submit-form/{call_id}` are
  **not** forgotten auth — they back the customer account-opening form
  (`frontend/app/bank/account-form/page.tsx`), reached by a WhatsApp link
  carrying the `call_id`. See §5.4: they are a capability-URL design with real
  weaknesses, but "add auth" would break the customer flow.

---

## 5. Open — needs your decision

### 5.1 Network exposure (highest remaining risk)

`ufw` is **inactive**, iptables INPUT policy is **ACCEPT**, and ~30 ports are
bound to `0.0.0.0`/`*` on a box that also runs production:

```
22 80 443 1167 3001 3002 5000 5060 5062 5173 5180 5181 5678 5681 5682
7880 7881 7890 7891 8001 8010 8081-8086 8443 8444 8445 8446 9090 9091 10050
```

* `5060`/`5062` — SIP, open to the internet. Source of the 232 scanner errors,
  and the standard toll-fraud vector unless the trunk is IP-restricted.
* `8446` — the QA DB web console (pgweb).
* `8081`–`8086` — agent health ports (now loopback on QA after the fix; prod
  still `0.0.0.0` until it is deployed).
* `7880`/`7881` — Finix LiveKit; `7890`/`7891` — Vaani LiveKit.

I have deliberately **not** touched the firewall: getting a rule wrong on this
box locks out SSH and stops live calls. This needs a planned allowlist (SSH from
known IPs, SIP restricted to the Vobiz trunk IPs, everything internal on
loopback) applied with a timed rollback.

### 5.2 Prod schema has drifted from prod code

From the database audit (server currently unreachable, so **re-verify before
acting**):

* **`POST /api/admin/vendors` is broken in production right now.** The insert
  writes `gstin`/`pan_number`, which prod's `vendors` table lacks, and omits
  `bank_id`, which is `NOT NULL` there. `SELECT count(*) FROM vendors` on prod
  returns 0 — no vendor has ever been created. QA cannot catch it because QA's
  table has the columns.
* **`_migrations` cannot be trusted on prod.** `migration_v11_vendors.sql` is
  recorded as applied but its columns never landed: a divergent `vendors` table
  already existed, `CREATE TABLE IF NOT EXISTS` matched the name, did nothing,
  and the file was recorded as done. Both databases claim identical history
  through v39 while having different tables. Diff `information_schema`, not the
  tracker.
* **`deploy.sh` still applies migrations with `psql < $f 2>/dev/null || true`**
  in three places — errors discarded, and shell glob order puts v10 before v2.
  This is the mechanism that produced the above. The tracked runner
  (`db_migrations.py`) exists and does it correctly; the prod script does not
  use it.
* Prod is missing **v40/v41/v42**. Safe today (prod code has no
  `services/permissions.py`), but the next `qa`→`master` merge without
  migrating first turns every `require_permission` call into a 500 — which
  gates officer-approve, supervisor-approve, request-documents, disburse and
  cancel. **Migrate first, then ship code. Never the reverse.**
* Startup migration failure is caught and execution continues, so the app boots
  onto a schema it knows is wrong.

### 5.3 No rate limiting anywhere

No limiter middleware exists. The only throttles are three bespoke DB counters
(OTP send, login lockout keyed on username, PAN attempts). Unlimited:
Aadhaar verify/link/documents/download (each a **paid** third-party call — cost
amplification), all the CSV/report export endpoints, and
`/api/internal/frontend-error` (which also accepts anonymous posts and injects
straight into the operator error console). Note the lockout has no IP
dimension, so knowing usernames lets an attacker lock out every bank user.

### 5.4 Unauthenticated static mounts and capability URLs

* `app.mount("/uploads", ...)` and `app.mount("/api/recordings", ...)` have no
  auth and no tenant scoping. `/api/recordings/*` falls through nginx's
  `location /api/`. The DigiLocker Aadhaar PDF path is fully deterministic:
  `/uploads/{loan_id}/aadhaar_digilocker.pdf`. Fetching a recording this way
  also bypasses the `record_sensitive_access` audit entirely.
* `/api/agent/form-data/{call_id}` returns the applicant's KYC to anyone with
  the `call_id`; `/api/agent/submit-form/{call_id}` lets them overwrite
  `collected_data` and set `otp_verified` to any value. The UUID is the only
  secret, it never expires, and it is not single-use.

Both need a design decision, not a one-line patch — an authenticated,
bank-scoped file handler, and a short-lived single-use token for the form.

### 5.5 Smaller, still real

* **Billing is two autocommit writes.** `usage_records` and `credit_ledger` are
  separate `pool.execute` calls in `agent/transcript.py`. If the second fails,
  the bank is never debited — and the idempotency guard then blocks any retry,
  so the debit is permanently lost with the wallet overstated. Wrap both in one
  `conn.transaction()`.
* **`smtplib` runs inside the event loop** (`bank_admin.py` invite/resend,
  `timeout=15`). One unreachable SMTP host freezes the entire single-process
  backend — every tenant, the dispatcher and the job workers — for 15s+.
* **Emergency stop is global.** `/emergency-stop` and `/resume-calling` act
  platform-wide by design while being gated on any bank user, so one officer can
  halt or resume every tenant's calling. I did **not** change this: the state is
  a single global flag and making it per-bank is a schema plus dispatcher
  change. Deliberately left for sign-off.
* `is_emergency_stop_active()` fails **open** (swallows the DB error and returns
  a stale module global) — a kill switch should fail closed.
* `_audit_page` runs an unbounded `SELECT count(*)` on append-only audit tables
  on every page load, with no `created_at` bound. Fine at today's row counts;
  multi-second full scans later.
* `audit_logs` — the sensitive-access trail, the one with a `phone` column — has
  **no `bank_id`/`branch_id`**, so it cannot be scoped or exported per tenant.
  A compliance gap once a second bank is live.
* Branch isolation is enforced only by the audit endpoints. A branch-scoped
  officer still sees the whole bank's pipeline, calls, recordings and exports.
* Frontend: `npm run lint` is a **silent no-op** (no `.eslintrc*`, so `next lint`
  drops into its setup wizard and exits 0). Every hooks-deps bug is unguarded.
  Separately: `/apply/dashboard`'s primary CTA pushes to `/apply`, which does not
  exist — a 404 on the customer portal's main action.

---

## 6. Recommended order

1. Firewall allowlist (§5.1) — planned, with rollback.
2. Re-verify and fix the prod `vendors` drift; replace `deploy.sh`'s migration
   loops with the tracked runner (§5.2).
3. Deploy `0cc4de8` + `30cd25b` to QA, exercise all four roles, then prod.
4. Rate limiting (§5.3).
5. Authenticated file handler + form-token redesign (§5.4).
6. Billing transaction, SMTP off the loop, ESLint config (§5.5).
7. Emergency-stop tenancy and branch isolation — product decisions.
