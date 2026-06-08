# finix.vgipl.com Deploy + CI/CD Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline,
> checkpointed) to implement this plan. This is **production infrastructure over SSH** —
> do NOT use subagent-driven parallel execution. Steps use checkbox (`- [ ]`) syntax.
> Execute phase-by-phase; STOP at each ⛔ CHECKPOINT for human confirmation.

**Goal:** Run the current local system (the `feature/ops-overhaul-complete` lineage) in
production on the GPU at `finix.vgipl.com`, and auto-deploy it whenever `master` changes.

**Architecture:** Archive the old `master`, force `master` to the new system, sync the GPU,
cut agents over to systemd, add the `finix` domain (keep `virtualvaani`), then wire a
GitHub Actions → SSH → `deploy.sh --update` pipeline.

**Tech Stack:** Git, GitHub Actions, SSH (paramiko from the controller), Ubuntu 24.04,
systemd, nginx, certbot, Docker Postgres, FastAPI/uvicorn, Next.js/node, LiveKit Python agents.

**Key facts (verified 2026-06-02):**
- GPU: `root@164.52.217.236`, repo at `/root/vaani_los_form`, remote `pranavsoni360/form.git`.
- `origin/master` (old) = `617ab3e`; new system HEAD = `feature/ops-overhaul-complete` (`34c1f44`); GPU HEAD = `b2be5d8`.
- New-system / old-master histories are **unrelated** (no merge base) → force, not merge.
- Services already systemd: `los-backend` (:8200), `los-frontend` (:3001), `los-agent` (loan_agent.py — to be replaced).
- venvs: `backend/venv`, `agent/venv` (py3.12). Env files live on GPU; not in git.
- `finix.vgipl.com` DNS → the GPU already; no cert/nginx block yet.

**SSH note:** Controller has no `sshpass`. Use the paramiko pattern: write a short
`_run.py` that connects with `paramiko` (host `164.52.217.236`, user `root`, password from
the user) and `exec_command`s. Delete the script after each use (it holds the password).
All commands below are the remote command strings to run through it. Force UTF-8.

---

## PHASE 0 — Reconcile & sync GPU to the new system

### Task 0.1: Pre-flight archive + DB backup (zero-loss safety net)

**Files:** none (git tags + remote DB dump)

- [ ] **Step 1 — Tag the old master locally and push it**

```bash
cd /c/Users/adil.sheikh/Desktop/form/form
git tag archive/master-pre-finix-2026-06-02 617ab3efc3d1ab6d6af5bf8fc3b8b1e24baa600e
git push origin archive/master-pre-finix-2026-06-02
```
Expected: `* [new tag] archive/master-pre-finix-2026-06-02 -> ...`

- [ ] **Step 2 — Tag the GPU's current commit (remote)**

```bash
cd /root/vaani_los_form && git tag gpu-pre-finix-2026-06-02 HEAD && git tag | grep finix
```
Expected: `gpu-pre-finix-2026-06-02`

- [ ] **Step 3 — Back up the production DB (remote)**

```bash
mkdir -p /root/backups && docker exec vaani-los-postgres pg_dump -U los_admin -Fc los_form > /root/backups/los_form_pre_finix_2026-06-02.dump && ls -la /root/backups/los_form_pre_finix_2026-06-02.dump
```
Expected: a `.dump` file with size > 0 bytes. **If size is 0 → STOP, fix DB creds/name first.**

**Verify:** all three artifacts exist (2 tags + 1 dump > 0 bytes).
**Rollback:** none needed (purely additive).

⛔ **CHECKPOINT 0.1** — confirm dump size > 0 before continuing.

---

### Task 0.2: Force `master` to the new system

**Files:** none (git ref move)

- [ ] **Step 1 — Point local master at the new system**

```bash
cd /c/Users/adil.sheikh/Desktop/form/form
git branch -f master feature/ops-overhaul-complete
git rev-parse --short master feature/ops-overhaul-complete
```
Expected: both print the same short sha (e.g. `34c1f44`).

- [ ] **Step 2 — Force-push master with lease**

```bash
git push --force-with-lease=master:617ab3efc3d1ab6d6af5bf8fc3b8b1e24baa600e origin master
```
Expected: `+ 617ab3e...34c1f44 master -> master (forced update)`.
If lease rejected: re-`git fetch origin master`, confirm remote is still `617ab3e`, retry.

- [ ] **Step 3 — Verify remote**

```bash
git ls-remote origin refs/heads/master
```
Expected: the new sha (`34c1f44...`).

**Verify:** `origin/master` now points at the new system; old master recoverable via the archive tag.
**Rollback:** `git push --force origin archive/master-pre-finix-2026-06-02:refs/heads/master`

---

### Task 0.3: Sync the GPU to the new master

**Files:** none (remote checkout)

- [ ] **Step 1 — Fetch + hard reset on GPU**

```bash
cd /root/vaani_los_form && git fetch origin && git checkout master 2>&1; git reset --hard origin/master && git rev-parse HEAD
```
Expected: HEAD == new sha (`34c1f44...`).

- [ ] **Step 2 — Confirm the new agent files arrived**

```bash
ls /root/vaani_los_form/agent/*.py
```
Expected: includes `union_bank_los.py`, `los_updated.py`, `agent_core.py`, `loan_agent.py`, `session.py`, `tools.py`, `prompts.py`, `prompts_account.py`.

**Verify:** GPU HEAD == origin/master; new modular agent files present.
**Rollback:** `cd /root/vaani_los_form && git reset --hard gpu-pre-finix-2026-06-02`

⛔ **CHECKPOINT 0.3** — GPU is now on new code but services still run OLD processes. Do not skip ahead.

---

### Task 0.4: Reconcile environment variables

**Files:** Modify on GPU: `/root/vaani_los_form/agent/.env.local`, check `backend/.env`

- [ ] **Step 1 — Diff example vs live (agent)**

```bash
cd /root/vaani_los_form/agent && echo "== example keys ==" && cut -d= -f1 .env.example | grep -vE '^\s*#|^\s*$' | sort -u && echo "== live keys ==" && cut -d= -f1 .env.local | grep -vE '^\s*#|^\s*$' | sort -u
```
Expected: a `GROQ_API_KEY` (and any other new key) present in example but missing in live.

- [ ] **Step 2 — Add the missing key(s)**

> **NEEDS-FROM-USER:** the `GROQ_API_KEY` value (from console.groq.com). Also any other key
> the diff flags as missing.

```bash
echo 'GROQ_API_KEY=<value-from-user>' >> /root/vaani_los_form/agent/.env.local
grep GROQ_API_KEY /root/vaani_los_form/agent/.env.local
```

- [ ] **Step 3 — Diff example vs live (backend)**

```bash
cd /root/vaani_los_form/backend && diff <(cut -d= -f1 .env.example | grep -vE '^\s*#|^\s*$' | sort -u) <(cut -d= -f1 .env | grep -vE '^\s*#|^\s*$' | sort -u) || echo '(differences above — add any missing required keys)'
```
Add any missing required keys (values from the user if secret).

**Verify:** `GROQ_API_KEY` present in `agent/.env.local`; no required backend key missing.
**Rollback:** `.env.local` has a timestamped `.bak` already on the box; restore if needed.

---

### Task 0.5: Install new Python/Node deps for the new code

**Files:** none (venv + node_modules on GPU)

- [ ] **Step 1 — Backend venv deps**

```bash
cd /root/vaani_los_form/backend && venv/bin/pip install -q -r requirements.txt && echo "backend deps ok"
```

- [ ] **Step 2 — Agent venv deps (new: livekit-plugins-groq etc.)**

```bash
cd /root/vaani_los_form/agent && venv/bin/pip install -q -r requirements.txt && venv/bin/python -c "import livekit.plugins.groq; print('groq plugin ok')"
```
Expected: `groq plugin ok` (the FallbackAdapter needs it).

- [ ] **Step 3 — Frontend build**

```bash
cd /root/vaani_los_form/frontend && npm install --silent && npm run build 2>&1 | tail -5
```
Expected: Next.js build completes without errors.

**Verify:** backend imports, `groq` plugin imports, frontend `.next` build succeeds.
**Rollback:** deps are additive; no action needed.

---

### Task 0.6: Agent systemd cutover (1 monolith → 2 modular)

**Files:**
- Create (repo): `scripts/los-agent-union.service`, `scripts/los-agent-pusad.service`
- Install (GPU): `/etc/systemd/system/los-agent-union.service`, `/etc/systemd/system/los-agent-pusad.service`

- [ ] **Step 1 — Create unit files in the repo (local), commit, push**

`scripts/los-agent-pusad.service`:
```ini
[Unit]
Description=LOS Pusad Loan Voice Agent (LiveKit)
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

`scripts/los-agent-union.service`:
```ini
[Unit]
Description=LOS Union Bank Account-Opening Voice Agent (LiveKit)
After=network-online.target los-backend.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/vaani_los_form/agent
EnvironmentFile=/root/vaani_los_form/agent/.env.local
ExecStart=/root/vaani_los_form/agent/venv/bin/python union_bank_los.py start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
cd /c/Users/adil.sheikh/Desktop/form/form
git add scripts/los-agent-union.service scripts/los-agent-pusad.service
git commit -m "feat(deploy): systemd units for the two modular voice agents"
git push origin master
```

- [ ] **Step 2 — Pull on GPU + install units**

```bash
cd /root/vaani_los_form && git pull origin master && cp scripts/los-agent-union.service scripts/los-agent-pusad.service /etc/systemd/system/ && systemctl daemon-reload && echo "units installed"
```

- [ ] **Step 3 — Stop old monolith, start the two new agents**

```bash
systemctl disable --now los-agent.service; systemctl enable --now los-agent-union los-agent-pusad; sleep 6; systemctl is-active los-agent-union los-agent-pusad
```
Expected: `active` then `active`.

- [ ] **Step 4 — Confirm both registered with LiveKit**

```bash
journalctl -u los-agent-union -u los-agent-pusad --since "1 min ago" -o cat 2>&1 | grep -iE "registered worker|HTTP server listening" | tail
```
Expected: a `registered worker` line for each (`union-bank-account-opening` and `pusad-bank-loan-enquiry-enhanced`), on ports 8081 and 8082.

**Verify:** both agent services active + registered; old `los-agent` disabled.
**Rollback:** `systemctl enable --now los-agent.service; systemctl disable --now los-agent-union los-agent-pusad`

⛔ **CHECKPOINT 0.6** — confirm both agents registered before restarting backend.

---

### Task 0.7: Restart backend/frontend on new code (runs DB migrations)

**Files:** none

- [ ] **Step 1 — Restart backend + frontend**

```bash
systemctl restart los-backend los-frontend && sleep 8 && systemctl is-active los-backend los-frontend
```
Expected: `active` then `active`.

- [ ] **Step 2 — Confirm migrations applied + health**

```bash
journalctl -u los-backend --since "1 min ago" -o cat 2>&1 | grep -iE "Migrations done|applied" | tail; echo "== readyz =="; curl -fsS -k https://localhost:8200/readyz 2>&1 || curl -fsS http://localhost:8200/readyz 2>&1
```
Expected: a `Migrations done` line; `/readyz` returns JSON with `"status":"ok"`.

**Verify:** backend `/readyz` ok; migrations ran cleanly.
**Rollback:** restore DB dump (Task 0.1 §3) + `git reset --hard gpu-pre-finix-2026-06-02` + restart.

---

### Task 0.8: End-to-end smoke test

- [ ] **Step 1 — Dispatch one test call** to a safe number via the ops UI/batch, on each
      agent type (loan + account-opening). Confirm the agent answers, talks naturally, and
      ends the call cleanly (the fixes from this session).

**Verify:** both agents converse end-to-end; form pre-fill + call-end behave as fixed.
**Rollback:** full Phase 0 rollback (DB restore + git reset + old service).

⛔ **CHECKPOINT 0.8 — PHASE 0 COMPLETE.** GPU now runs the new system from `master`.
Confirm before starting Phase 1.

---

## PHASE 1 — finix.vgipl.com (both domains live)

### Task 1.1: Confirm current routing, then choose finix routing

**Files:** read-only inspection on GPU

- [ ] **Step 1 — Inspect how virtualvaani is served**

```bash
nginx -T 2>/dev/null | grep -nE "server_name|proxy_pass|listen|root|location" | grep -iE "virtualvaani|proxy_pass|3001|8200|location /" | head -40
```
Decide finix routing (target: nginx terminates TLS on 443, proxies `/` → `127.0.0.1:3001`,
`/api` → `127.0.0.1:8200`). Record the exact upstream the frontend expects (it may itself
serve HTTPS via `https-server.js`; if so, proxy to it over https or convert it to http
behind nginx — pick during this step based on what the inspection shows).

**Verify:** routing plan written down with exact upstreams/paths.
**Rollback:** n/a (read-only).

### Task 1.2: Issue the finix TLS certificate

- [ ] **Step 1 — Certbot (nginx plugin, HTTP-01)**

```bash
certbot certonly --nginx -d finix.vgipl.com --non-interactive --agree-tos -m <admin-email> 2>&1 | tail -15
ls -la /etc/letsencrypt/live/finix.vgipl.com/
```
> **NEEDS-FROM-USER:** admin email for certbot (or confirm reuse of an existing account).
Expected: `fullchain.pem` + `privkey.pem` under `live/finix.vgipl.com/`.

**Verify:** cert files exist.
**Rollback:** `certbot delete --cert-name finix.vgipl.com`.

### Task 1.3: Add the finix nginx server block

**Files:** Create on GPU: `/etc/nginx/conf.d/finix.conf` (also commit a copy to repo `scripts/nginx/finix.conf`)

- [ ] **Step 1 — Write the server block** (final upstreams per Task 1.1), e.g.:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name finix.vgipl.com;
    ssl_certificate     /etc/letsencrypt/live/finix.vgipl.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/finix.vgipl.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location /api/ { proxy_pass http://127.0.0.1:8200/api/; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; }
    location /    { proxy_pass http://127.0.0.1:3001/;     proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; }
}
server {
    listen 80; listen [::]:80; server_name finix.vgipl.com;
    return 301 https://$host$request_uri;
}
```
(If the frontend/backend keep serving their own TLS, use `https://127.0.0.1:<port>` upstreams
+ `proxy_ssl_verify off;` — decided in Task 1.1.)

- [ ] **Step 2 — Test + reload (never reload on a bad config)**

```bash
nginx -t && systemctl reload nginx && echo "nginx reloaded"
```
Expected: `syntax is ok` / `test is successful`, then `nginx reloaded`.

**Verify:** `nginx -t` passes; reload succeeds.
**Rollback:** `rm /etc/nginx/conf.d/finix.conf && nginx -t && systemctl reload nginx`.

### Task 1.4: Verify both domains

- [ ] **Step 1 — Hit both**

```bash
curl -sS -o /dev/null -w "finix %{http_code}\n" https://finix.vgipl.com/ ; curl -sS -o /dev/null -w "vv %{http_code}\n" https://virtualvaani.vgipl.com/
```
Expected: `finix 200` and `vv 200` (or expected redirect codes).

- [ ] **Step 2 — Update app base URLs if needed** (e.g. `FORM_BASE_URL` in `backend/.env` →
      `https://finix.vgipl.com` if the WhatsApp form link should use the new domain). Restart
      backend if changed.

**Verify:** finix serves the app; virtualvaani still works.
**Rollback:** remove finix conf; revert `FORM_BASE_URL`.

⛔ **CHECKPOINT 1.4 — PHASE 1 COMPLETE.**

---

## PHASE 2 — CI/CD pipeline (push to master → GPU auto-update)

### Task 2.1: Update `deploy.sh` for master + the two agents

**Files:** Modify `scripts/deploy.sh`

- [ ] **Step 1 — Default branch main→master**

In `scripts/deploy.sh`, change:
```bash
REPO_BRANCH="${LOS_BRANCH:-main}"
```
to:
```bash
REPO_BRANCH="${LOS_BRANCH:-master}"
```

- [ ] **Step 2 — Restart the two agents in the `--update` path**

Find the update restart line (currently `systemctl restart los-backend los-frontend`) and change it to:
```bash
systemctl restart los-backend los-frontend los-agent-union los-agent-pusad
```

- [ ] **Step 3 — Add agent health gate** after the backend `/readyz` check:
```bash
if ! systemctl is-active --quiet los-agent-union || ! systemctl is-active --quiet los-agent-pusad; then
    warn "One or both agents not active after deploy. Check: journalctl -u los-agent-union -u los-agent-pusad -n 50"
    exit 1
fi
```

- [ ] **Step 4 — Also install the two agent units in the systemd-setup section** (so a fresh
      `deploy.sh` provisions them, mirroring the existing `los-backend`/`los-frontend` install +
      `systemctl enable`). Commit.

```bash
cd /c/Users/adil.sheikh/Desktop/form/form
git add scripts/deploy.sh
git commit -m "feat(deploy): deploy.sh tracks master + manages the two modular agents"
git push origin master
```

**Verify:** `bash -n scripts/deploy.sh` (syntax) passes; manual `deploy.sh --update` on GPU
restarts all four services and gates on health.
**Rollback:** `git revert` the commit.

### Task 2.2: Create a dedicated deploy SSH key

**Files:** none (key material)

- [ ] **Step 1 — Generate an ed25519 keypair (local, no passphrase)**

```bash
ssh-keygen -t ed25519 -f /c/Users/adil.sheikh/.ssh/finix_deploy -N "" -C "github-actions-finix-deploy"
```

- [ ] **Step 2 — Install the public half on the GPU**

```bash
cat ~/.ssh/finix_deploy.pub >> /root/.ssh/authorized_keys && echo "key added"
```
(run remotely; append only — do not overwrite authorized_keys)

- [ ] **Step 3 — Test key-based login** works (controller, key, no password).

> **NEEDS-FROM-USER (GitHub UI):** add repo secrets in
> GitHub → repo → Settings → Secrets and variables → Actions:
> - `GPU_HOST` = `164.52.217.236`
> - `GPU_USER` = `root`
> - `GPU_PORT` = `22`
> - `GPU_SSH_KEY` = contents of `~/.ssh/finix_deploy` (the PRIVATE key)

**Verify:** key-based SSH works; 4 secrets saved in GitHub.
**Rollback:** remove the pubkey line from `authorized_keys`; delete the secrets.

### Task 2.3: Create the GitHub Actions workflow

**Files:** Create `.github/workflows/deploy.yml`

- [ ] **Step 1 — Write the workflow**

```yaml
name: Deploy to GPU
on:
  push:
    branches: [master]
  workflow_dispatch: {}

concurrency:
  group: gpu-deploy
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.GPU_HOST }}
          username: ${{ secrets.GPU_USER }}
          port: ${{ secrets.GPU_PORT }}
          key: ${{ secrets.GPU_SSH_KEY }}
          command_timeout: 20m
          script: |
            set -e
            cd /root/vaani_los_form
            bash scripts/deploy.sh --update
```

- [ ] **Step 2 — Commit + push**

```bash
cd /c/Users/adil.sheikh/Desktop/form/form
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): GitHub Actions auto-deploy to GPU on push to master"
git push origin master
```
This push itself will trigger the FIRST pipeline run.

**Verify:** workflow file valid YAML; appears under repo → Actions.
**Rollback:** delete `.github/workflows/deploy.yml`, push.

### Task 2.4: Validate the pipeline end-to-end

- [ ] **Step 1 — Watch the triggered run** in GitHub → Actions → "Deploy to GPU". Expect green.
- [ ] **Step 2 — Manual trigger test:** Actions → Deploy to GPU → "Run workflow" (workflow_dispatch). Expect green.
- [ ] **Step 3 — Real change test:** make a tiny visible change (e.g. a comment), push to
      master, confirm it lands on the GPU (`git -C /root/vaani_los_form rev-parse HEAD` matches)
      and `/readyz` stays 200.

**Verify:** push to master → green deploy → GPU HEAD updated → health ok.
**Rollback:** `git revert` the bad commit (auto-redeploys), or `deploy.sh --update --branch <archive-tag>`.

⛔ **CHECKPOINT 2.4 — PIPELINE LIVE.** Every push to `master` now auto-deploys to the GPU.

---

## Final verification checklist (matches spec)

- [ ] `git push origin master` triggers a green GitHub Actions deploy.
- [ ] GPU `master` == `origin/master` == new system; old master recoverable via `archive/master-pre-finix-2026-06-02`.
- [ ] `los-agent-union` + `los-agent-pusad` active; old `los-agent` disabled.
- [ ] `/readyz` 200; a test call connects and the agent talks + ends cleanly.
- [ ] `https://finix.vgipl.com` serves the app; `https://virtualvaani.vgipl.com` still works.
- [ ] Reboot brings everything back (all systemd-enabled).
