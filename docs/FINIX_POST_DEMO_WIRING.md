# Finix — Post-Demo Wiring Backlog

**Status as of 2026-08-13.** The database foundation for the multi-bank product
is fully applied to `los_form_qa` (migrations v26–v38, all recorded in
`_migrations`, pushed to the `qa` branch). Many of those tables and guards are
**foundation only — the live application code does not read/write them yet.**

This document is the precise map of what still needs *code* wiring.

> Rule of thumb: a migration changed the schema safely. Wiring changes running
> behaviour.

## ✅ DONE (shipped to QA + PROD, 2026-08-14)
- **#16 security** — all 40 endpoints authenticated + tenant-scoped + network bind (see FINIX_SECURITY_REMEDIATION_16.md).
- **Calling window** — 7 PM cap + per-bank window enforcement (already live on prod).
- **Document dual-write** — both upload endpoints write to `application_documents` (any doc type); legacy `*_url` write made best-effort (fixes the 5 phantom-column 500s).
- **Billing debit-per-call** — transcript webhook debits the bank wallet per-minute at its rate_card (best-effort + idempotent); dispatcher skips `calling_paused` banks; auto-pause at ₹0 verified. **Dormant until a bank gets `rate_card_id` assigned.**

- **Consent-check before send** ✅ (2026-08-14) — `is_phone_opted_out` guards send_whatsapp_message + send_whatsapp_aisensy; OTP + in-call form-link stay transactional. Last-10-digit match verified.
- **login_audit** ✅ (2026-08-14) — admin-login + bank-login write login_audit on success (best-effort).

## ⏳ STILL TO WIRE
- **Scorecard engine → live version**: LRS engine still reads global `lrs_scorecard_config`; make it read the bank's live `scorecard_versions` row + stamp the scored version onto the application.
- **Retention purge job**: scheduled deletion of recordings/PII past `bank_retention_config` days when `auto_purge_enabled` (⚠️ deletion — build carefully with dry-run first).
- **Disbursement logging**: log disbursement events to the audit trail.

---

## 1. Calling-window compliance (task #9) — **highest priority**

**Two real findings, both live-code:**

| Finding | Where | Fix |
|---|---|---|
| Calls allowed **10 AM–midnight** (`CALL_END_HOUR=24`) | `backend/agent/state.py:59-60` | Set the window to RBI/TRAI-compliant hours (≈9 AM–7 PM). This is an env/config change — **coordinate first**, it will stop evening calls. |
| Per-bank `calling_window_start` / `calling_window_end` in `bank_settings` are **never read** — enforcement is global | `is_within_calling_hours()` `backend/agent/state.py:226` | Make it bank-aware: look up the bank's `bank_settings` window, fall back to the global default. Callers: `agent/batch.py`, `agent/calls.py`, `guarantor/runner.py`. |

**Test after wiring:** a bank with a 10–17 window cannot dispatch at 18:00 IST;
a bank with no row falls back to the global default.

---

## 2. Document normalization (task #7 / #10)

- **Tables ready:** `application_documents` (backfilled from the 7 `*_url`
  columns), `application_notes`, `export_jobs`.
- **Wire:** `/api/upload-document` (`main.py:2895`) and
  `/api/upload-document-session` (`main.py:3728`) currently write only the fixed
  `*_url` columns. Make them **also** insert an `application_documents` row
  (dual-write; keep the `*_url` write for back-compat).
- **Bonus bug this fixes:** the upload `field_mapping` (`main.py:2914`) lists 12
  document types but only **7** `*_url` columns exist — uploading
  `salary_slips` / `itr_form16` / `proof_of_residence` / `proof_of_identification`
  / `bank_statements` currently targets a non-existent column. Once uploads go to
  `application_documents`, any document type is just a row and the bug is gone.
- **Then:** the officer/bank UI can read documents + notes from the new tables
  (single query, with who/when/verification) instead of scattered columns.

---

## 3. Commercial / billing (task #3)

- **Tables ready:** `rate_cards`, `credit_ledger` (append-only, auto-pause at
  ≤₹0), `usage_records`, `invoices`, `invoice_line_items`.
- **Wire:** on each completed call, insert one `credit_ledger` debit row (single
  row per statement — enforced by `trg_credit_ledger_single_row`) at the bank's
  rate-card price, and a `usage_records` row. The AFTER trigger already syncs
  `banks.credit_balance` and pauses outbound at zero — the app just needs to
  respect `banks.pause_outbound` before dispatching.

---

## 4. Scorecard engine (task #4)

- **Tables ready:** `loan_products` (seed PERSONAL), `scorecard_versions` (jsonb
  config, one live per bank, seeded from `lrs_scorecard_config`).
- **Wire:** the scoring engine should read the bank's **live** `scorecard_versions`
  row instead of the global `lrs_scorecard_config`, and stamp the scored version
  onto the application for auditability.

---

## 5. Governance / maker-checker (task #7)

- **Ready:** `chk_maker_ne_checker` guard (active on new writes),
  `loan_products.second_approver_threshold`, `bank_settings.second_approver_threshold`
  (bank-level, colleague's), `application_approvals` audit table.
- **Wire:** on approve/reject, insert an `application_approvals` row. When the
  loan amount exceeds the threshold, require a second approver before moving to
  `approved`/`disbursed`.
- **Note overlap:** threshold exists at **two grains** — `bank_settings`
  (bank-wide, colleague) and `loan_products` (per-product, v38). Decide which
  wins (suggest: product overrides bank default) before wiring.

---

## 6. Retention / DPDP (task #9)

- **Ready:** `bank_retention_config` (recording/document/PII days + auto-purge),
  `notification_optouts` (consent-withdrawal registry).
- **Wire:** (a) a scheduled purge job that deletes recordings/PII older than the
  bank's retention days when `auto_purge_enabled`; (b) a consent check before any
  WhatsApp/SMS send — skip recipients present in `notification_optouts`.

---

## 7. Audit-table writes (task #5)

- **Done (DB):** duplicate status-log trigger dropped (v34); `record_transition()`
  is the single actor-attributed writer to `status_transitions`.
- **Wire:** ensure `login_audit` is written on every admin/bank login, and
  disbursement events are logged. (Verify what's already writing to `activity_log`
  / `platform_audit_log` before adding.)

---

## 8. Security — close unauthenticated endpoints (task #16) — **release blocker**

Separate, larger workstream (see [[project_los_network_exposure]] in memory).
The agent router's `get_current_bank_user` returns an operator dict when **no**
token is present (`backend/agent/state.py` ~340), making call-data endpoints and
`/export/all-calls`, `/export/daily-report` effectively public. This must close
before the product is sold. **Paused until after the demo** by explicit decision.

---

### Sequencing suggestion (post-demo)

1. #16 security (release blocker) + #1 calling-window fix (compliance).
2. Document dual-write (#2 above) — unblocks the UI and kills the 5-column bug.
3. Billing + scorecard wiring (revenue + decisioning correctness).
4. Governance + retention/consent (compliance depth).
5. Audit completeness.
