# Multi-Bank + Branches Schema (design v2)

> **Status:** design artefact. Nothing is applied. The DDL lives at
> `database/design/multi_bank_v2.sql` and is deliberately outside the
> `migration_*.sql` glob so the startup runner can never pick it up.
>
> **Verified:** applied cleanly onto a schema-only dump of live QA in a throwaway
> database — 31 → 51 tables, 0 errors, idempotent on re-run, and 8/8 constraint
> proofs behaved as designed. The throwaway DB was dropped; `los_form` and
> `los_form_qa` were never touched.

---

## 1. Why

Today the system is **"multi-bank data model, single-tenant operations."** `banks`
and `bank_users` exist and ~13 tables carry `bank_id`, but:

- **There is no branch layer at all.** Verified greenfield — zero occurrences of
  `branch`, `branch_code`, `ifsc`, or `micr` anywhere in the repo.
- **There is no platform/super-admin layer.** `admin_users` has no role CHECK and
  **no management API whatsoever** — a super admin cannot create another super
  admin, cannot delete a bank, and cannot reset a bank user's password.
- **There is effectively no audit trail** (see §6) — in a system that moves real money.
- **Onboarding a new bank requires a code change.** Agent persona, language, voice
  and the spoken bank name are hardcoded in Python.

The single worst symptom of the last point: the agent's spoken bank name is derived
from `agent_type`, not from `banks.name`, so **every non-`account_opening` call
introduces itself as "ABC Bank" regardless of which bank it belongs to**
(`services/dispatcher.py:666-706`). Multi-bank cannot ship until that is data-driven.

## 2. Hierarchy

```
PLATFORM  (us — cross-tenant by design, no bank_id)
  platform_admins · subscription_plans · agent_templates
  platform_audit_log · platform_alerts
        │ 1:N
BANK  (tenant root)
  banks · bank_subscriptions · bank_api_keys · bank_onboarding · scoped_config
        │ 1:N
BRANCH   ◄── the new layer
  bank_branches  (owns its agentic resources; supports parent_branch_id for regions)
        │ 1:N
OPERATIONAL  (scoped by bank_id + branch_id)
  bank_users · phone_pools · phone_numbers · agent_configs
  agent_batches · agent_calls · loan_applications · guarantor_consent_calls
```

**The one invariant everything rests on**

| Column | Rule |
|---|---|
| `bank_id` | **NOT NULL** on every operational table (after backfill). Bound from the JWT. |
| `branch_id` | **NULLABLE** — `NULL` means "bank-wide shared, not owned by a branch". |

Platform admins bypass the `bank_id` filter; everyone else is confined by it.

## 3. Identity keys

Your manager's list maps to columns like this. Internal PKs stay UUID; the rest
exist for humans and for Core Banking System (CBS) integration.

### banks

| Column | Type | Meaning |
|---|---|---|
| `id` | UUID PK | internal only — never displayed, never changes |
| `code` | VARCHAR(20) | human slug (`PUSAD`, `BUCB`, `SFB`, `NRCB`) — **now format-enforced** `^[A-Z0-9_]{2,20}$` (it had no DB rule at all before) |
| `bank_mst_id` | INTEGER | **CBS master ID** — numeric reference into the core banking system |
| `bank_key` | VARCHAR(64) | **CBS integration key** — stable external handshake identifier |
| `ifsc_prefix` | VARCHAR(11) | first 4 of IFSC, for deriving branch IFSCs |

### bank_branches

| Column | Type | Meaning |
|---|---|---|
| `id` | UUID PK | internal |
| `branch_code` | VARCHAR(20) | **unique per bank**, not globally — two banks may both have `BR001` |
| `branch_mst_id` | INTEGER | CBS branch master ID (unique per bank) |
| `ifsc` | VARCHAR(11) | format-checked `^[A-Z]{4}0[A-Z0-9]{6}$` |
| `micr` | VARCHAR(9) | MICR code |
| `branch_type` | enum | `head_office · regional_office · main · branch · sub_branch · kiosk · legacy` |
| `parent_branch_id` | UUID self-FK | region → branch hierarchies |

**Why "MST" naming is right here:** the codebase already integrates an external
master-data service at `/api/code-list/{sql_mst_id}` (a proxy to the VG master API
with `sqlMstId` payloads). Using `bank_mst_id` / `branch_mst_id` keeps our vocabulary
aligned with what the bank side already speaks.

**Secrets are not identity.** Real API credentials live in `bank_api_keys`, stored
as a hash with a displayable `key_prefix`, revocable and expirable — so rotating a
key never touches the tenant row.

## 4. Branch owns the agentic layer

`agent_configs` is the new heart of this. Today its four dimensions are scattered:

| Dimension | Today | After |
|---|---|---|
| LiveKit agent | `AGENT_NAME` / `UNION_BANK_AGENT_NAME` env constants | `agent_configs.livekit_agent_name` |
| Language | upload-time query param → hardcoded `LANG_CONFIG` dict | `language` + `tts_language_code` + `stt_language` |
| Voice | hardcoded `GENDER_CONFIG` dict (`shubh`/`pooja`, `Amit`/`Priya`) | `agent_gender` + `tts_speaker` + `persona_name` |
| Spoken bank name | **derived from `agent_type`** → always "ABC Bank" | `display_bank_name`, falling back to `banks.name` |
| Caller ID | operator picks per batch | `pool_id` bound to the branch |

This is grounded in the UI you already have: the `/ops` **Batch** screen asks for
exactly *Language · Voice · Agent type · FROM NUMBER* on every upload. Those four
become **branch defaults** that a batch inherits, with the per-batch override kept
(`agent_batches.preferred_phone_id`). Every other `/ops` screen — Dashboard, Live
Calls, All Calls, Recordings, Callbacks, Analytics, Exports, Phone Pool, Workers —
then gains a branch filter for free, because the tables it reads now carry `branch_id`.

**`phone_numbers` gets `bank_id`/`branch_id` directly.** It has *no* tenant column
today — tenancy is reachable only via `pool_id → phone_pools.bank_id`, and the
dispatcher's selection query never constrains it, so **Bank A's batch can dial from
Bank B's caller ID**. Denormalising the tenant onto the row lets the hot selection
path filter with no join (`idx_phone_numbers_tenant_pick`).

**`emergency_stop` stops being global.** `agent_system_config` has PK `(key)` only,
so a per-bank value is physically impossible — tripping it halts dialling for every
tenant and the guarantor lane at once, and `POST /api/agent/batch-call` implicitly
*clears* it, meaning one bank starting a batch un-pauses everyone. Replaced by
`scoped_config` with resolution order **(bank, branch) → (bank, NULL) → (NULL, NULL)**.

## 5. Permissions — RBAC, not hardcoded roles

`bank_users.role` is a hard 2-value CHECK today (`bank_officer`, `bank_supervisor`),
so every new role needs a migration. Authority moves into data:

```
roles            (role_code, scope: platform|bank|branch, is_system, bank_id)
permissions      (permission_code e.g. 'application.approve', category, is_dangerous)
role_permissions (role_id, permission_id)
user_roles       (user_id, user_type, role_id, bank_id, branch_id, valid_until)
```

`user_roles` carries `bank_id` **and** `branch_id`, which is what lets a bank admin
grant a **branch-limited** role — impossible with the current model. Seeded with 9
system roles and 33 permissions; `v_user_effective_permissions` flattens the join to
one lookup for the auth layer.

| Actor | Scope |
|---|---|
| `super_admin` | all banks; create/suspend banks, assign plans, manage platform admins, templates, config |
| `ops_admin` / `reviewer` / `support` | read all banks; writes limited by permission code |
| `bank_admin` | everything inside their `bank_id`; create branches + users |
| `branch_manager` | everything inside their `branch_id` |
| `bank_supervisor` | officer scope + final approve/reject/disburse |
| `bank_officer` | first-level review within their branch |
| `bank_auditor` | read-only + audit log access |
| customer | own application only, via OTP session |

## 6. Audit — the compliance core

### What exists today (all verified, not assumed)

- `audit_logs` has **zero writers and zero readers**. Worse, it lives only in
  `schema.sql`, which the migration runner **never executes** — so on a
  runner-provisioned database the table may not even exist.
- `form_autosave_log` — same story, dead.
- `loan_applications.ip_address / user_agent / device_fingerprint / geolocation`
  are **declared but never written**.
- The **only** IP/user-agent stored anywhere is `otp_verifications`, and only on the
  legacy token flow.
- **No successful login is recorded** — just an overwritten `last_login_at`. And
  `login_attempts` (a per-username counter) is **`DELETE`d on success**, destroying
  the failure history.
- `status_transitions` is written **twice** per change (helper *and* trigger), so
  history is doubled and half the rows are mis-attributed to `system`.
- `changed_by_id` is passed **the application's own id** in two places, and
  `from_status` is hardcoded `'draft'` regardless of reality.
- **Money leaving is not logged**: vendor disbursement sets `disbursed_at` without
  touching `status`, so neither writer fires.
- Officer decisions sit in **single-slot columns** — a second officer overwrites the
  first, and nothing prevents `officer_id == supervisor_id` (no maker/checker).

### The five logs

| Table | Answers | Volume |
|---|---|---|
| `activity_log` | who did what, from where — every mutating action | highest |
| `login_audit` | every auth event, success **and** failure; never pruned | high |
| `application_status_log` | every state a loan passed through (single writer) | medium |
| `application_field_history` | who changed which field, from what to what | medium |
| `officer_action_log` | append-only officer/supervisor decisions | low |
| `platform_audit_log` | what *our* team did, across banks | low |

**Actor + device block** — your manager's item 5, applied consistently:

```
actor_type · actor_id · actor_username (snapshot) · actor_role
bank_id · branch_id
session_id · request_id · jti
ip_address INET · machine_ip INET · machine_name · user_agent
location JSONB {city, region, country, lat, lon, source}
before_data JSONB · after_data JSONB · changed_fields TEXT[]
remark · status_reason · result · error_message
```

Two deliberate choices worth stating:

1. **`actor_username` is denormalised.** An audit row must stay readable after the
   user is renamed, deactivated or deleted — and it removes a join from every query.
2. **All six logs are append-only**, enforced by a trigger (`fn_audit_append_only`)
   that raises on UPDATE/DELETE. Pair it with `REVOKE UPDATE, DELETE` on the app role
   in production. An audit trail you can edit is not an audit trail. *(Proven in test:
   both UPDATE and DELETE were rejected.)*

**Scale note:** `activity_log` grows fastest. Convert it to monthly `RANGE`
partitions on `created_at` (plus a BRIN index) **before** it gets large —
partitioning after the fact requires a full rewrite.

## 7. Standard column convention

Applied uniformly (your manager's item 6), rather than ad-hoc per table:

```
status · status_reason · remark
is_active   BOOLEAN NOT NULL DEFAULT TRUE
is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
deleted_at · deleted_by · delete_reason
created_at · created_by · updated_at · updated_by
```

**Soft delete only** — nothing in a lending system is hard-deleted. Unique
constraints are **partial** (`WHERE is_deleted = FALSE`) so a soft-deleted code
becomes reusable, and partial indexes keep the hot path fast. *(Proven in test:
soft-delete then reuse of `BR001` succeeded.)*

## 8. Tenant integrity enforced by the database

A `branch_id` must belong to the *same* bank as its row. A plain FK cannot express
that, so `bank_branches` carries `UNIQUE (bank_id, id)` and every child declares:

```sql
FOREIGN KEY (bank_id, branch_id) REFERENCES bank_branches (bank_id, id)
```

Cross-tenant branch assignment becomes **impossible in the database**, not merely
discouraged in application code. Applied to `bank_users`, `phone_pools`,
`phone_numbers`, `agent_configs`, `agent_calls`, `agent_batches`,
`loan_applications`, `bank_api_keys`, `scoped_config`, `user_roles`. A trigger
covers the self-referential `parent_branch_id` case. *(Both proven in test.)*

## 9. Super-admin surface + onboarding

Each step flips a flag on `bank_onboarding`, which a trigger auto-creates on bank
insert and whose `completion_percent` is recomputed on every write.

```
1. banks              → create (onboarding row auto-created)
2. bank_subscriptions → assign plan + quota
3. bank_branches      → at least one (default MAIN)
4. bank_users         → bank_admin, then officers/supervisors, each pinned to a branch
5. phone_pools/numbers→ per branch, or bank-wide
6. agent_configs      → clone from agent_templates, bind branch + pool
7. test call
8. sign-off           → is_live = TRUE, banks.status = 'active'
```

**Deletion policy:** never hard-delete a bank or branch. `DELETE` sets
`is_deleted`/`deleted_by`/`delete_reason`/`deleted_at` and soft-deactivates children.
Existing loans stay queryable — mandatory for a lending audit.

## 10. Rollout

| Migration | Contents | Risk |
|---|---|---|
| `v26_platform_layer` | §1, §2 — new tables only | none |
| `v27_bank_branches` | §3.1–3.5, seeds, default MAIN branch | low (additive) |
| `v28_rbac` | §4 + role/permission seeds | none |
| `v29_agent_configs` | §3.6, §5, §7.2 | low |
| `v30_audit_layer` | §6 — the five logs | none |
| `v31_operational_branch` | §7.1, §7.3–7.5, views | low (additive) |
| `v32_enforce_not_null` | `bank_id NOT NULL`, drop duplicate status trigger, drop global username unique | **only after backfill is verified** |

Conventions the migrations must follow (already true of v23–v25): `ADD COLUMN IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS`, CHECK constraints replaced via
`DROP IF EXISTS` + `ADD` with the full value list restated, and **fully idempotent** —
the runner does not verify checksums (`_migrations.checksum` is the literal
`'applied'`), so an applied file must never be edited; always add a new version.

### Backfill blocker — measured on live QA

| Table | Rows | `bank_id IS NULL` |
|---|---|---|
| `loan_applications` | 28 | **8 (29%)** |
| `agent_calls` | 142 | **36 (25%)** |
| `agent_batches` | 122 | **29 (24%)** |
| `phone_pools` | 2 | **1** |

`bank_id NOT NULL` cannot simply be switched on. **Do not silently assign these
orphans to the only existing bank** — that fabricates attribution on loan records.
Instead they go to an explicit `LEGACY` bank + `LEGACY` branch (seeded in §8.7 of the
DDL) and are flagged for manual review. Nothing is deleted, nothing is
mis-attributed, and the constraint becomes truthful. **Re-measure on prod** before
applying — the ratio will differ.

### Two pre-existing definition hazards

- `agent_calls` and `agent_batches` are each created by **two** migrations with
  different `bank_id` nullability (`migration_agent_tables.sql` NOT NULL, which sorts
  first, vs `migration_v2.sql` nullable). Both use `IF NOT EXISTS`, so **prod and a
  fresh dev DB can legitimately differ**. Normalise explicitly in v32 rather than
  assuming.
- `bank_users.username` is **globally unique**, so two banks cannot both have
  `manager1`. The per-bank unique index is added now, but the global constraint can
  only be dropped **after** the login path takes `bank_code + username` — dropping it
  first would break authentication.

## 11. Code changes required alongside

Schema alone is not enough:

1. **JWT must carry `branch_id`** (claims today are `user_id`, `role`, `user_type`,
   `bank_id` only), and so must the SSE stream-token.
2. **`dispatcher._acquire_trunk_from_db` must filter by tenant** — it has no
   `bank_id` predicate at all today.
3. **The spoken bank name must come from `banks.name` / `display_bank_name`**, not
   from `agent_type`.
4. **`record_transition()` becomes the single writer**, takes a request context
   (ip/session/request_id), and must be called on **vendor disbursement** and **LRS
   scoring** — neither logs anything today.
5. **Login must write `login_audit` on every attempt**, and stop `DELETE`ing
   `login_attempts` on success.
6. **Three `/api/admin/*` endpoints have no admin check** (`main.py:1691`, `:1721`,
   `:2752` — the last is a *write* that approves/rejects loans). They must use
   `get_current_admin`.
7. **Ops endpoints must stop defaulting to "operator sees everything"**
   (`agent/state.py:346` returns cross-bank access when no token is present), and the
   export endpoints' accidental `bank_id IS NOT DISTINCT FROM NULL` filter — which
   makes them return *only unassigned rows* — must be fixed.

## 12. How to verify

```bash
# throwaway DB, real baseline: schema-only dump of QA, then the design on top
docker exec <pg> pg_dump -U los_admin -d los_form_qa --schema-only --no-owner > /tmp/base.sql
docker exec <pg> psql -U los_admin -d postgres -c 'CREATE DATABASE los_schema_test;'
docker exec -i <pg> psql -U los_admin -d los_schema_test < /tmp/base.sql
docker exec -i <pg> psql -U los_admin -d los_schema_test -v ON_ERROR_STOP=1 \
    < database/design/multi_bank_v2.sql
docker exec <pg> psql -U los_admin -d postgres -c 'DROP DATABASE los_schema_test;'
```

Results from the run of this procedure: **31 → 51 tables, exit 0, zero errors**;
re-applying the file a second time was also clean with **no duplicated seed rows**
(3 plans / 9 roles / 33 permissions), confirming idempotency.

Constraint proofs — each behaved as designed:

| Proof | Expected | Actual |
|---|---|---|
| Same `branch_code` in two different banks | allow | allowed |
| Duplicate `(bank_id, branch_code)` | reject | `uq_branches_bank_code` |
| User pinned to another bank's branch | reject | `fk_bank_users_branch` |
| Parent branch in another bank | reject | `fn_branch_parent_same_bank` |
| Reuse `branch_code` after soft-delete | allow | allowed |
| `activity_log` UPDATE / DELETE | reject | append-only (both) |
| `bank_onboarding` auto-create | fire | both banks, 0% |
| Invalid IFSC / lowercase bank code | reject | both CHECKs |
| `documents_requested`, `disbursed` | accepted | present in CHECK |
