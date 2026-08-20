# Finix — Tiered Audit & Security-Logging Design

**Status:** built & verified on QA (prod held for sign-off). This is the canonical
design for the multi-tier audit system. Money-lending / RBI-due-diligence grade.

---

## 1. Principles

1. **Tiered by org hierarchy.** Three scopes — **Super Admin (VGIPL)**, **Bank
   Admin**, **Branch** — each sees exactly its own slice, enforced server-side.
2. **Every event carries a full who/where envelope**: timestamp, actor
   (id/type/role), client IP, **machine IP**, **machine name**, user-agent,
   **geolocation**, session id, request id.
3. **Append-only / tamper-evident.** Evidence stores block UPDATE/DELETE via DB
   triggers; the security store blocks DELETE and freezes all but the
   acknowledgement columns.
4. **Best-effort, never blocking.** A logging failure never breaks a login, a
   loan decision, or a customer action.
5. **Offline geolocation.** IP→geo resolved locally (DB-IP `.mmdb`); no client IP
   ever leaves the box (DPDP-safe).
6. **Detection on top of evidence.** Raw logs are the record; a security layer
   turns them into anomalies + alerts.

---

## 2. The three tiers (RBAC / visibility matrix)

| | **Tier 1 — Super Admin** (`admin`) | **Tier 2 — Bank Admin** (`bank_admin`) | **Tier 3 — Branch** (`bank_supervisor` / `bank_officer`) |
|---|---|---|---|
| **Scope** | Everything, all banks + platform | Own bank only (all its branches) | Own branch only |
| **Filter** | none (global) | `bank_id` | `bank_id` + `branch_id` |
| **Cannot see** | — | other banks; platform actions | other branches; bank-admin actions |
| **API** | `/api/admin/audit/*` (`get_current_admin`) | `/api/bank/audit` (auto bank-scoped) | `/api/bank/audit` (auto branch-scoped) |
| **Dashboard** | `/ops/audit` (6 streams) | `/bank/admin/audit` | `/bank/audit` |

Scoping is **enforced at the API**, not the UI: `get_current_admin` rejects bank
users; `/api/bank/audit` derives `bank_id`/`branch_id` from the caller's own
token (a branch officer physically cannot request another branch's rows).

---

## 3. Log stores (mapped to tiers)

| Store | Tier | What it records | Integrity |
|---|---|---|---|
| `platform_audit_log` | 1 | bank onboarding/suspend, vendor & partnership, scorecard publish, platform-user mgmt — **with before→after diffs** | append-only |
| `bank_activity_log` | 2 | user/role/permission/branch mgmt, invites, bank config | — |
| `officer_action_log` | 3 | loan decisions: approve/reject/request-docs/disburse/cancel — **LRS-score-at-decision, decided amount/tenure/ROI** | append-only |
| `application_status_log` | 1/2/3 | every loan status transition (from→to) | append-only |
| `application_field_history` | 1/2/3 | per-field old→new on an application (PAN masked) | append-only |
| `audit_logs` | 1/2/3 | **sensitive reads**: Aadhaar view, recording playback, exports, disbursement, guarantor consent | append-only |
| `login_audit` | all | login success / **failure** / logout + device fingerprint | append-only |
| `activity_log` | all | HTTP envelope for every mutating request (middleware) | append-only |
| `security_events` | all (tier-scoped) | detected anomalies + alerts (see §5) | DELETE blocked; only ack mutable |

Every store carries `ip_address, machine_ip, machine_name, user_agent,
location(jsonb)` (or `geolocation` for `audit_logs`), plus actor + `bank_id` /
`branch_id` for tier scoping.

---

## 4. Event envelope (captured on every event)

- **When**: `created_at` (tz-aware).
- **Who**: `actor_type` (platform_admin / bank_user / vendor_user / customer /
  system / agent), `actor_id`, `actor_username`, `actor_role`.
- **Where**: `ip_address` (real client IP via X-Real-IP / last XFF hop, since the
  app is behind nginx), `location` (country/region/city/lat/lon, offline),
  `machine_ip` + `machine_name` (from `X-Machine-IP` / `X-Machine-Name` headers —
  a desktop client / kiosk / gateway supplies them; NULL for plain browsers).
- **Context**: `session_id`, `request_id`, `user_agent`, device fingerprint
  (login), plus store-specific business fields (before/after, decided terms, …).

---

## 5. Security layer (detect → store → alert)

Detectors sit on top of the evidence stores and write `security_events`
(tier-scoped, severity-graded). High/critical also log-warn into the existing
Sentry/Telegram pipeline.

| Detector | Trigger | Severity |
|---|---|---|
| `new_device_login` | login from a device fingerprint not seen before for that user | medium |
| `new_location_login` | login from a city not seen before for that user | medium |
| `off_hours_login` | login outside business hours (06:00–21:00 IST, configurable) | low |
| `failed_login_burst` | repeated failed logins → lockout | high |
| `privilege_change` | a user's role is changed | high |
| `blocked_internal_path` | a loopback-only internal path hit from outside | high |
| `mass_sensitive_access` | a user crosses the sensitive-read burst threshold (25 / 10 min, configurable) | high |

Each tier sees its own security events (super admin: all; bank admin: their bank;
branch: their branch) and can **acknowledge** them (recorded with who/when; the
event body stays immutable).

Config knobs (env): `SECURITY_BUSINESS_START_HOUR`, `SECURITY_BUSINESS_END_HOUR`,
`SECURITY_MASS_ACCESS_THRESHOLD`, `SECURITY_MASS_ACCESS_WINDOW_MIN`.

---

## 6. Retention & lifecycle

Per-bank retention (`bank_retention_config`, plan §42): a daily job redacts call
recordings/transcripts and purges documents past the bank's configured window.
Audit-evidence retention is deliberately long; only recordings/PII age out.
DRY-RUN by default (`RETENTION_PURGE_LIVE=true` to enable deletion).

---

## 7. What's built (verified on QA)

- All 9 stores wired and populated; **40/40** endpoint checks + **7/7** security
  detectors + **8/8** branch/gap checks passed against the live API.
- Real-client-IP + offline geo + machine IP/name captured on every path.
- Platform dashboard (6 streams incl. Security + acknowledge); bank-admin and
  branch dashboards reading the auto-scoped API.
- Append-only triggers on every evidence store + the security-events guard.

## 8. Deliberately out of scope (for now)

- **Hash-chaining** of audit rows (cryptographic tamper-proof) — evaluated;
  currently relying on append-only triggers. Can be added later without schema
  change to the evidence.
- **Branch data** only fills as users/loans get assigned to branches (a user
  gets a `branch_id`; a loan is stamped to the deciding officer's branch on first
  touch). The plumbing is complete and auto-populates.
- **External alert delivery** (email/SMS to bank admins) beyond the current
  Sentry/Telegram hook for high/critical.
- **Prod cutover**: needs `maxminddb` + the geo `.mmdb` at `GEOIP_DB_PATH` +
  nginx `X-Real-IP`; migration v42 applies via the tracked runner. Prod is held
  pending sign-off.
