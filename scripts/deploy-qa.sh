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
cd "$QA/frontend" && PORT=3002 npm run build 2>&1 | tail -3

echo "── 5. restart QA services ──"
systemctl restart los-backend-qa los-agent-qa-pusad los-agent-qa-union los-agent-qa-guarantor los-frontend-qa
sleep 9

echo "── 6. health ──"
curl -fsk -o /dev/null -w "QA backend /readyz: HTTP %{http_code}\n" https://localhost:8300/readyz || echo "BACKEND UNHEALTHY"
for s in los-backend-qa los-frontend-qa los-agent-qa-pusad los-agent-qa-union los-agent-qa-guarantor; do
  echo "  $s: $(systemctl is-active "$s")"
done
echo "═══ QA deploy complete → https://finix.vgipl.com:8445 ═══"
