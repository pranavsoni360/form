# Execution Plan — Separate Prod & QA (Postgres + SIP)

**Status:** ready to execute (own session, some steps need a maintenance window). **Risk:** ⚠️ touches live infra — stage carefully. **Est. effort:** 1 day for DB + SIP; +1 day if moving QA to its own box.

---

## Goal
Stop QA from sharing production's blast radius. Today a test run can consume prod call channels, dial from prod numbers, and lives one `DROP`/crash away from prod data.

## Current state (verified)
- **Postgres**: ONE instance (`vaani-los-postgres`, `127.0.0.1:5434`). Prod = DB `los_form`, QA = DB `los_form_qa`, **same `los_admin` superuser**, same host. Logically separate DBs, shared instance/credentials/box.
- **SIP**: **shared trunk** `SIP_TRUNK_ID=ST_GwFDcRGtgSVC` — QA calls consume prod trunk channels and dial from the same caller-IDs. (This is why QA testing caused prod concurrency exhaustion earlier.)
- **phone_numbers**: 2 rows in each DB — same physical numbers.
- **Box**: both on `164.52.217.236`; backends prod :8200 / QA :8300 (now loopback), nginx :443 / :8445.

## Target state (phased — do the high-value low-risk parts first)
Three independent tracks; ship in this order.

---

## Track A — SIP / phone separation (highest value, do first)
**Problem:** QA test calls burn prod channels + spoof prod caller-ID.
1. Provision a **separate SIP trunk + test DID** with the telephony vendor (Vobiz/Twilio) for QA — ideally a low-cost/sandbox number.
2. Set QA's `SIP_TRUNK_ID` (+ caller-ID / phone_numbers rows) to the QA trunk in `/root/vaani_los_form_qa/backend/.env.qa`. Prod keeps `ST_GwFDcRGtgSVC`.
3. Update `phone_numbers` / `phone_pools` in `los_form_qa` to the QA number(s) only.
4. **Verify**: trigger a QA test call → lands on the QA trunk, prod trunk channel count unaffected during the QA call. Confirm a prod call still uses the prod trunk.
- **Rollback**: point QA back at the prod trunk (revert the env + rows).
- No prod change required — this is QA-only config, so it's the safest high-value step.

## Track B — Postgres least-privilege (medium value, low risk)
Even before a full instance split, remove the shared-superuser risk.
1. Create a **QA-only role** `los_qa` that can touch only `los_form_qa` (revoke on `los_form`). Same for a prod-only role if desired.
2. Point QA's `DATABASE_URL` at `los_qa`. Keep `los_admin` for admin tasks only.
3. **Verify**: `los_qa` can read/write `los_form_qa`, is denied on `los_form`.
- Removes "a QA bug/typo hits prod data via the same superuser". (Partially started — a read-only `qa_tester` role already exists for testers.)

## Track C — Separate Postgres instance (full isolation, needs a window)
1. Stand up a **second Postgres container** `vaani-los-postgres-qa` (own port e.g. 5435, own volume, own credentials).
2. `pg_dump los_form_qa` from the shared instance → restore into the new QA instance.
3. Repoint QA `DATABASE_URL` to `:5435/los_form_qa`; run a QA deploy; smoke-test the QA dashboards.
4. Drop `los_form_qa` from the prod instance once QA is confirmed stable on its own.
- **Benefit**: a QA Postgres crash/lock/`DROP` can no longer take prod down; independent resource limits.
- **Window**: brief QA downtime during dump/restore/cutover (prod untouched).
- **Rollback**: repoint QA `DATABASE_URL` back to `:5434` (the source DB isn't dropped until after confirmation).

## Track D (optional, biggest lift) — QA on its own box
Move the QA worktree + services + Postgres to a separate cheap VM. Full blast-radius isolation (a QA runaway can't starve prod CPU/RAM/disk on the shared box). Do only if the shared box shows contention.

---

## Recommended sequence
1. **Track A** (SIP) — QA-only, safest, kills the prod-channel-contention bug. Do first.
2. **Track B** (DB least-privilege) — removes shared-superuser risk cheaply.
3. **Track C** (separate PG instance) — schedule a QA window.
4. **Track D** — only if the shared box is resource-constrained.

## Cross-cutting verification
After each track: prod calling + prod dashboards unaffected (curl prod health, place one prod test call), QA still fully functional (load QA dashboards, run a QA test call on the QA trunk).

## Risk notes
- Prod is live with real bank demos — every track is designed to be **QA-side first**, prod untouched until QA is proven on the new setup.
- Keep the source data (QA DB, old trunk config) until the new setup is confirmed; never delete-then-verify.
