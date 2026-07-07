#!/bin/bash
# ────────────────────────────────────────────────────────────────────────────
# deploy-qa.sh — Deploy the `qa` branch to the QA environment (finix.vgipl.com:8445)
#
# QA promotion pipeline (Option A — QA first, then production):
#   1. Make a fix on a branch, merge/push it to the `qa` branch.
#   2. Run this script  →  QA env updates  →  QA team verifies on :8445.
#   3. Once QA approves: merge `qa` → `master`  →  CI runs deploy.sh (production).
#
# QA runs from an isolated git worktree (/root/vaani_los_form_qa on branch `qa`),
# its own DB (los_form_qa), its own services (los-backend-qa, los-frontend-qa,
# los-agent-qa-*), reusing prod's venvs/node_modules. Production is never touched.
# ────────────────────────────────────────────────────────────────────────────
set -uo pipefail
QA=/root/vaani_los_form_qa
PROD=/root/vaani_los_form
PG=vaani-los-postgres; PGUSER=los_admin; QADB=los_form_qa

echo "═══ Deploying qa branch → QA environment ═══"

echo "── 1. pull qa branch ──"
cd "$QA" || { echo "QA worktree missing"; exit 1; }
git fetch origin qa
git reset --hard origin/qa
echo "deployed commit: $(git rev-parse --short HEAD)"

echo "── 2. python deps (shared venv; installs only new) ──"
"$PROD/backend/venv/bin/pip" install -q -r "$QA/backend/requirements.txt" || true

echo "── 3. migrate QA database ($QADB) ──"
for f in "$QA"/database/migration*.sql; do
  [ -f "$f" ] || continue
  docker exec -i "$PG" psql -U "$PGUSER" -d "$QADB" < "$f" >/dev/null 2>&1 || true
done

echo "── 4. rebuild QA frontend ──"
# Build BEFORE restarting anything. If it fails, abort the deploy — the old
# build keeps serving and QA stays up (a broken build must never take QA down).
cd "$QA/frontend"
if ! PORT=3002 npm run build 2>&1 | tail -20; then
  echo "❌ QA frontend build FAILED — aborting deploy, services NOT restarted (old build still serving)"
  exit 1
fi
if [ ! -f "$QA/frontend/.next/BUILD_ID" ]; then
  echo "❌ .next/BUILD_ID missing after build — aborting deploy, services NOT restarted"
  exit 1
fi

echo "── 5. restart QA services ──"
systemctl restart los-backend-qa los-agent-qa-pusad los-agent-qa-union los-agent-qa-guarantor los-frontend-qa
sleep 9

echo "── 6. health ──"
# Fail the deploy loudly if anything is unhealthy, so the workflow goes red
# (and GitHub notifies) instead of silently reporting success on a dead QA.
FAILED=0
code=$(curl -sk -o /dev/null -w "%{http_code}" https://localhost:8300/readyz || echo 000)
echo "QA backend /readyz: HTTP $code"
[ "$code" = "200" ] || { echo "  ↳ backend NOT healthy"; FAILED=1; }
for s in los-backend-qa los-frontend-qa los-agent-qa-pusad los-agent-qa-union los-agent-qa-guarantor; do
  st=$(systemctl is-active "$s")
  echo "  $s: $st"
  [ "$st" = "active" ] || FAILED=1
done
if [ "$FAILED" != "0" ]; then
  echo "❌ QA deploy finished but environment is UNHEALTHY — see above"
  exit 1
fi
echo "═══ QA deploy complete → https://finix.vgipl.com:8445 ═══"
