# finix.vgipl.com Deploy + CI/CD Pipeline — Design

**Date:** 2026-06-02
**Status:** Approved (design), pending implementation plan
**Author:** Adil + Claude (pair)

## Goal

Get the current local system (the `feature/ops-overhaul-complete` lineage) running in
production on the GPU server at `finix.vgipl.com`, and set up a CI/CD pipeline so that
future pushes to `master` auto-deploy to the GPU — without breaking the existing
`virtualvaani.vgipl.com` site or the other unrelated projects on the same server.

## Architecture (target)

```
Developer
  │  git push origin master
  ▼
GitHub Actions  (.github/workflows/deploy.yml)
  │  SSH (dedicated deploy key, from repo secrets)
  ▼
GPU  /root/vaani_los_form
  │  bash scripts/deploy.sh --update
  ├─ git pull origin master  (|| git reset --hard origin/master)
  ├─ frontend rebuild + backend venv deps
  ├─ systemctl restart los-backend los-frontend los-agent-union los-agent-pusad
  └─ health gates: /readyz + agent systemd is-active
  ▼
Live on https://finix.vgipl.com  (and virtualvaani.vgipl.com still works)
```

## Current state (verified on the GPU, 2026-06-02)

Discovered by read-only SSH inspection of `root@164.52.217.236`.

### Server
- Ubuntu 24.04, busy multi-project host (n8n, emailthing, llmthing, livekit-*, mongodb,
  zabbix, etc.). **All other projects must remain untouched.**
- `/root/vaani_los_form` is a clone of `github.com/pranavsoni360/form.git`.
- Services for this project are already systemd-managed and enabled:
  - `los-backend.service` → `backend/venv/bin/uvicorn main:app --port 8200` (SSL, virtualvaani cert)
  - `los-frontend.service` → `node frontend/https-server.js` (port 3001)
  - `los-agent.service` → `agent/venv/bin/python loan_agent.py start`
- venvs: `backend/venv`, `agent/venv` (Python 3.12). Env files present:
  `backend/.env`, `agent/.env.local`.

### The two critical divergences

1. **Stale code.** The GPU checkout is on branch `master` at commit `b2be5d8`
   (2026-04-27). `origin/master` is `617ab3e`. Neither has any of the ops-overhaul work
   (M1–M8) or this session's agent fixes. The GPU runs the April monolith agent
   `loan_agent.py`; the new modular agents do not exist on it.

2. **Unrelated git histories.** `feature/ops-overhaul-complete` (root `359d38a`
   "whatsapp working") and `origin/master` (root `60471715`) share **no merge base**
   (`git merge-base` exits 1). A normal merge is impossible/all-conflicts. The new system
   was built on a fresh history, separate from the lineage the GPU tracks.

### Domain
- `finix.vgipl.com` DNS already resolves to `164.52.217.236`.
- No SSL cert for finix (only `virtualvaani.vgipl.com` exists in letsencrypt).
- No nginx server block for finix (only virtualvaani, in `sites-available/default`).
- `los-backend.service` and `frontend/https-server.js` hard-code the virtualvaani cert path.

### Agent canonical decision
Production must run **the local system**: the modular agents
`union_bank_los.py` (port 8081, agent `union-bank-account-opening`) and
`los_updated.py` (port 8082, agent `pusad-bank-loan-enquiry-enhanced`). These replace the
single `loan_agent.py` / `los-agent.service`.

### Env gap
The new agents use a Gemini→Groq `FallbackAdapter`. GPU `agent/.env.local` has
`GOOGLE_API_KEY`, `DEEPGRAM_API_KEY`, `SARVAM_API_KEY` but **no `GROQ_API_KEY`** — must be
added or the fallback path errors.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Production agent | New modular agents (`union_bank_los.py` + `los_updated.py`) |
| Deploy branch | `master` |
| History reconcile | Archive old master, force `master` → `feature/ops-overhaul-complete` lineage |
| Domain | Add `finix.vgipl.com`; keep `virtualvaani.vgipl.com` working |
| Pipeline | GitHub Actions + SSH → `deploy.sh --update` (Approach A) |
| Agent process mgmt | systemd (2 units), replacing `los-agent.service` |
| Execution | Phase 0 → Phase 1 → Phase 2 (sequential, verify each) |

---

## Phase 0 — Reconcile & sync GPU to the new system (one-time, highest risk)

**Goal:** GPU runs the new system from `master`, with the old state fully archived.

1. **Archive (zero data loss):**
   - `git tag archive/master-pre-finix-2026-06-02 origin/master && git push origin --tags`
     (preserves `617ab3e` forever — recoverable via `git checkout` the tag).
   - On GPU: `git tag gpu-pre-finix-2026-06-02 HEAD` (preserves `b2be5d8`).
   - **DB backup:** run `scripts/pg_backup.sh` (or a manual `pg_dump -Fc`) before any
     migration runs. Keep the dump off-box.
2. **Repoint master:**
   - `git branch -f master feature/ops-overhaul-complete`
   - `git push --force-with-lease origin master`
3. **Sync GPU:**
   - `git fetch origin && git checkout master && git reset --hard origin/master`
   - GPU working tree has junk (`frontend-v1-archive/*` modified, untracked `backups/`);
     `reset --hard` handles tracked files; untracked archive dirs are harmless but may be
     cleaned manually if desired (NOT with `git clean -x` blindly — could delete `.env`).
4. **Env reconciliation:**
   - Add `GROQ_API_KEY` to `agent/.env.local`.
   - Diff `backend/.env.example` and `agent/.env.example` against the live `.env` files;
     add any new required keys introduced since April.
5. **Agent systemd cutover:**
   - Install `los-agent-union.service` + `los-agent-pusad.service` (templates in `scripts/`).
   - `systemctl disable --now los-agent.service` (old monolith).
   - `systemctl enable --now los-agent-union los-agent-pusad`.
6. **DB migrations:** new backend auto-runs migrations on boot (idempotent v6–v10 per
   `db_migrations.py`). Backup from step 1 is the safety net.
7. **Verify:** `/readyz` 200; both agents show `registered worker` in journald and connect
   to LiveKit; one end-to-end test call on a non-production number.

**Rollback:** `git reset --hard gpu-pre-finix-2026-06-02` on GPU, restore old
`los-agent.service`, restore DB from the dump, restart services.

---

## Phase 1 — finix.vgipl.com (both domains live)

1. **SSL:** `certbot --nginx -d finix.vgipl.com` (or `certonly` + manual nginx). DNS
   already points to the box, so HTTP-01 will succeed.
2. **nginx:** add a server block for `finix.vgipl.com` mirroring the virtualvaani routing.
   Routing to be confirmed during planning — current virtualvaani serves static
   `/var/www/html` on its 443 block while the app serves HTTPS directly on `:3001`
   (frontend) and `:8200` (backend). Target for finix: nginx `443 → frontend:3001`, with
   `/api` proxied to `backend:8200`, so the app is reachable at plain
   `https://finix.vgipl.com` (no port in URL).
3. **Cert wiring:** point `los-backend.service` ExecStart and `frontend/https-server.js`
   at the finix cert **or** terminate TLS at nginx and run backend/frontend on plain HTTP
   behind it (cleaner — decided in planning).
4. **virtualvaani untouched:** its server block, cert, and routing stay as-is.
5. **Verify:** `https://finix.vgipl.com` loads the form; `https://virtualvaani.vgipl.com`
   still works.

---

## Phase 2 — CI/CD pipeline (the deliverable)

### Components

| File | Type | Purpose |
|---|---|---|
| `.github/workflows/deploy.yml` | NEW | On `push` to `master` (+ `workflow_dispatch`): SSH to GPU, run deploy, gate on health |
| `scripts/deploy.sh` | MODIFY | (a) default branch `main`→`master`; (b) `--update` also restarts `los-agent-union` + `los-agent-pusad`; (c) add agent `is-active` health check |
| `scripts/los-agent-union.service` | NEW | systemd unit — `union_bank_los.py start` |
| `scripts/los-agent-pusad.service` | NEW | systemd unit — `los_updated.py start` |

### Agent systemd unit (template)

```ini
[Unit]
Description=LOS Pusad Loan Voice Agent
After=network-online.target los-backend.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/vaani_los_form/agent
EnvironmentFile=/root/vaani_los_form/agent/.env.local
ExecStart=/root/vaani_los_form/agent/venv/bin/python los_updated.py start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
(union variant: `union_bank_los.py`; both already default to distinct ports 8081/8082.)

### Workflow data flow

```
push to master
  → deploy.yml: ssh-action → GPU
    → cd /root/vaani_los_form && bash scripts/deploy.sh --update
      → git pull origin master  (|| git reset --hard origin/master)
      → frontend rebuild + backend deps
      → systemctl restart los-backend los-frontend los-agent-union los-agent-pusad
      → curl -fsS https://localhost:8200/readyz  (gate)
      → systemctl is-active los-agent-union los-agent-pusad  (gate)
  → GitHub UI shows pass/fail; existing Telegram alerts fire on backend boot failure
```

### Secrets (GitHub repo → Settings → Secrets → Actions)

| Secret | Value |
|---|---|
| `GPU_HOST` | `164.52.217.236` |
| `GPU_USER` | `root` |
| `GPU_PORT` | `22` |
| `GPU_SSH_KEY` | Private half of a **dedicated** ed25519 deploy key |

GPU side: deploy key's public half appended to `/root/.ssh/authorized_keys`. Hardening
(later): forced-command on the authorized_keys entry to only allow the deploy script.

## Error handling & rollback

- **Bad git pull** → `git reset --hard origin/master` (deploy.sh built-in).
- **Backend boot failure** → `/readyz` ≠ 200 → deploy.sh non-zero → workflow RED +
  Telegram alert.
- **Agent crash-loop on bad code** → `is-active` gate fails → workflow RED. `Restart=always`
  keeps retrying; revert the commit to recover.
- **Rollback a release** → `git revert <sha>` on master (auto-redeploys), or
  `deploy.sh --update --branch <archive-tag>`.
- **`.env` files** → never touched by git (gitignored, live only on GPU).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Force-push master loses old lineage | Archived as tag `archive/master-pre-finix-2026-06-02` before force |
| DB migration corrupts prod data | `pg_dump` backup before Phase 0; migrations are idempotent |
| finix cert/nginx breaks virtualvaani | Separate server block + cert; virtualvaani config untouched; `nginx -t` before reload |
| Agent cutover leaves no agent running | Keep old `los-agent` until new units verified, then disable |
| Missing env var (GROQ etc.) | Explicit env reconciliation step in Phase 0 |
| SSH exposure for CI | Dedicated key, `--force-with-lease`, optional forced-command hardening |

## Out of scope (YAGNI for v1)

- Test gate (pytest/tsc) before deploy — add later.
- Zero-downtime / blue-green — single server; a few seconds of restart is acceptable.
- Other projects on the GPU (livekit-sip-server, SAMAVESH, etc.).
- Containerizing backend/frontend — they stay as systemd + venv/node.

## Verification checklist (end state)

- [ ] `git push origin master` triggers a green GitHub Actions deploy.
- [ ] GPU `master` == `origin/master` == the new system; old master recoverable via tag.
- [ ] `los-agent-union` + `los-agent-pusad` active; old `los-agent` disabled.
- [ ] `/readyz` 200; a test call connects and the agent talks.
- [ ] `https://finix.vgipl.com` serves the app; `https://virtualvaani.vgipl.com` still works.
- [ ] Server reboot brings everything back automatically (all systemd-enabled).
```
