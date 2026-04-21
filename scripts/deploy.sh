#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
# LOS Form — VPS Deployment Script
#
# Usage:
#   sudo bash scripts/deploy.sh                    # Full install
#   sudo bash scripts/deploy.sh --update           # Quick redeploy
#   sudo bash scripts/deploy.sh --migrate-only     # Just run DB migrations
#   sudo bash scripts/deploy.sh --help             # Show usage
#
# Target: 164.52.217.236 (virtualvaani.vgipl.com)
# Services: los-backend (8200), los-frontend (3001), vaani-los-postgres (5434)
# ══════════════════════════════════════════════════════════════════════════════

SCRIPT_VERSION="2.0.0"
REPO_URL="https://github.com/pranavsoni360/form.git"
REPO_BRANCH="${LOS_BRANCH:-main}"
INSTALL_DIR="/root/vaani_los_form"
BACKEND_PORT=8200
FRONTEND_PORT=3001
SSL_CERT_DIR="/etc/letsencrypt/live/virtualvaani.vgipl.com-0002"
DOMAIN="virtualvaani.vgipl.com"

# Postgres (read from env or use defaults — password MUST be in env)
PG_CONTAINER="vaani-los-postgres"
PG_PORT="${LOS_PG_PORT:-5434}"
PG_USER="${LOS_PG_USER:-los_admin}"
PG_PASSWORD="${LOS_PG_PASSWORD:-}"
PG_DB="${LOS_PG_DB:-los_form}"

DO_UPDATE=0
DO_MIGRATE=0

# ── Utility functions ────────────────────────────────────────────────────────

log()  { printf "\033[0;32m[%s]\033[0m %s\n" "$(date -u +"%Y-%m-%d %H:%M:%S")" "$*"; }
warn() { printf "\033[0;33m[%s] WARN:\033[0m %s\n" "$(date -u +"%Y-%m-%d %H:%M:%S")" "$*" >&2; }
die()  { printf "\033[0;31m[%s] ERROR:\033[0m %s\n" "$(date -u +"%Y-%m-%d %H:%M:%S")" "$*" >&2; exit 1; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }
gen_secret() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | head -c 44; }

wait_for_port() {
    local port="$1" label="${2:-service}" timeout="${3:-30}" i=0
    while ! ss -tlnp | grep -q ":${port} "; do
        sleep 1; i=$((i + 1))
        [[ $i -ge $timeout ]] && { warn "${label} not ready after ${timeout}s"; return 1; }
    done
    log "${label} ready on port ${port}"
}

# ── Parse arguments ──────────────────────────────────────────────────────────

show_help() {
    cat <<EOF
LOS Form Deployment Script v${SCRIPT_VERSION}

Usage:
  sudo bash scripts/deploy.sh                    Full install (first time)
  sudo bash scripts/deploy.sh --update           Quick redeploy (git pull + rebuild + restart)
  sudo bash scripts/deploy.sh --migrate-only     Just run DB migrations
  sudo bash scripts/deploy.sh --branch <name>    Deploy specific branch

Environment variables:
  LOS_PG_PASSWORD   (required for full install) Postgres password
  LOS_PG_PORT       Postgres port (default: 5434)
  LOS_PG_USER       Postgres user (default: los_admin)
  LOS_PG_DB         Postgres database (default: los_form)
  LOS_BRANCH        Git branch to deploy (default: main)
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --update)       DO_UPDATE=1; shift ;;
        --migrate-only) DO_MIGRATE=1; shift ;;
        --branch)       REPO_BRANCH="$2"; shift 2 ;;
        --help|-h)      show_help ;;
        *)              die "Unknown option: $1. Use --help for usage." ;;
    esac
done

# ── Migrate-only path ───────────────────────────────────────────────────────

do_migrate() {
    log "═══ Running DB migrations only ═══"
    for f in "${INSTALL_DIR}"/database/migration*.sql; do
        [[ -f "$f" ]] || continue
        log "Applying $(basename "$f")..."
        docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" < "$f" 2>/dev/null || true
    done
    log "═══ Migrations complete ═══"
    exit 0
}
[[ "${DO_MIGRATE}" == "1" ]] && do_migrate

# ── Quick update path ───────────────────────────────────────────────────────

do_update() {
    [[ "${EUID}" -ne 0 ]] && die "Run as root (use sudo)."
    [[ ! -d "${INSTALL_DIR}" ]] && die "Install dir ${INSTALL_DIR} not found. Run full install first."

    log "═══ Quick update (--update) ═══"

    # 1. Pull latest code
    log "Pulling latest code (branch: ${REPO_BRANCH})..."
    cd "${INSTALL_DIR}"
    git fetch origin "${REPO_BRANCH}"
    git checkout -B "${REPO_BRANCH}" "origin/${REPO_BRANCH}" 2>/dev/null || true
    git pull --ff-only origin "${REPO_BRANCH}" || git reset --hard "origin/${REPO_BRANCH}"

    local commit_hash
    commit_hash="$(git rev-parse --short HEAD)"
    log "Deployed commit: ${commit_hash}"

    # 2. Docker compose (ensure postgres is up)
    log "Ensuring Docker services..."
    if [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
        cd "${INSTALL_DIR}"
        # Read password from existing container if not set
        if [[ -z "${PG_PASSWORD}" ]]; then
            PG_PASSWORD=$(docker inspect "${PG_CONTAINER}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep POSTGRES_PASSWORD | cut -d= -f2 || true)
            export LOS_PG_PASSWORD="${PG_PASSWORD}"
        fi
        docker compose up -d 2>/dev/null || true
    fi

    # 3. Python dependencies
    log "Installing Python dependencies..."
    "${INSTALL_DIR}/backend/venv/bin/pip" install -q -r "${INSTALL_DIR}/backend/requirements.txt"

    # 4. Run DB migrations
    for f in "${INSTALL_DIR}"/database/migration*.sql; do
        [[ -f "$f" ]] || continue
        log "Applying $(basename "$f")..."
        docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" < "$f" 2>/dev/null || true
    done

    # 5. Frontend rebuild
    if have_cmd npm; then
        log "Rebuilding frontend..."
        cd "${INSTALL_DIR}/frontend"
        npm install --silent 2>/dev/null || true
        npm run build
        cd "${INSTALL_DIR}"
    else
        warn "npm not found — skipping frontend rebuild"
    fi

    # 6. Restart services
    log "Restarting services..."
    systemctl restart los-backend los-frontend

    # 7. Health check
    sleep 3
    if curl -fsk "https://localhost:${BACKEND_PORT}/" >/dev/null 2>&1; then
        log "Backend health check passed (port ${BACKEND_PORT})."
    else
        warn "Backend health check failed. Check: journalctl -u los-backend -n 50"
    fi

    # 8. Summary
    log "═══ Update complete ═══"
    log "Commit: ${commit_hash}"
    log "Backend:  https://${DOMAIN}:${BACKEND_PORT}"
    log "Frontend: https://${DOMAIN}:${FRONTEND_PORT}"
    exit 0
}

[[ "${DO_UPDATE}" == "1" ]] && do_update

# ══════════════════════════════════════════════════════════════════════════════
# FULL INSTALL
# ══════════════════════════════════════════════════════════════════════════════

[[ "${EUID}" -ne 0 ]] && die "Run as root (use sudo)."
[[ -z "${PG_PASSWORD}" ]] && die "Set LOS_PG_PASSWORD env var before running full install."

log "═══ LOS Form Installer v${SCRIPT_VERSION} ═══"
log "Target: ${DOMAIN}"
log "Branch: ${REPO_BRANCH}"

# ── Phase 1: System Prerequisites ────────────────────────────────────────────

log "── Phase 1: System Prerequisites ──"

if ! have_cmd docker; then
    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
fi

if ! have_cmd node; then
    log "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

log "Phase 1 complete"

# ── Phase 2: Docker Postgres (via compose) ──────────────────────────────────

log "── Phase 2: Docker Postgres ──"

export LOS_PG_PASSWORD="${PG_PASSWORD}"
export LOS_PG_PORT="${PG_PORT}"
export LOS_PG_USER="${PG_USER}"
export LOS_PG_DB="${PG_DB}"

if [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
    cd "${INSTALL_DIR}"
    docker compose up -d
elif docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    log "Postgres container already exists (pre-compose)"
    docker start "${PG_CONTAINER}" 2>/dev/null || true
else
    # Fallback: clone repo first for docker-compose.yml
    log "Cloning repo first for docker-compose.yml..."
    git clone -b "${REPO_BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
    cd "${INSTALL_DIR}"
    docker compose up -d
fi

wait_for_port "${PG_PORT}" "Postgres"
log "Phase 2 complete"

# ── Phase 3: Application Code ────────────────────────────────────────────────

log "── Phase 3: Application Code ──"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating existing repo..."
    cd "${INSTALL_DIR}"
    git fetch origin "${REPO_BRANCH}"
    git checkout -B "${REPO_BRANCH}" "origin/${REPO_BRANCH}" 2>/dev/null || true
    git pull --ff-only origin "${REPO_BRANCH}" || true
else
    log "Cloning repo..."
    rm -rf "${INSTALL_DIR}"
    git clone -b "${REPO_BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"
log "Phase 3 complete (commit: $(git rev-parse --short HEAD))"

# ── Phase 4: Database Schema ─────────────────────────────────────────────────

log "── Phase 4: Database Schema ──"

# Run base schema
docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" < "${INSTALL_DIR}/database/schema.sql" 2>/dev/null || true

# Run all migrations
for f in "${INSTALL_DIR}"/database/migration*.sql; do
    [[ -f "$f" ]] || continue
    log "Applying $(basename "$f")..."
    docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" < "$f" 2>/dev/null || true
done

# Seed admin user
docker exec "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" -c \
    "INSERT INTO admin_users (email, password_hash, full_name, role) VALUES ('admin@bank.com', '\$2b\$12\$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NU7JmZ.7Q8SO', 'Bank Admin', 'admin') ON CONFLICT (email) DO NOTHING;" 2>/dev/null || true

log "Phase 4 complete"

# ── Phase 5: Backend Setup ───────────────────────────────────────────────────

log "── Phase 5: Backend Setup ──"

cd "${INSTALL_DIR}/backend"
if [[ ! -d venv ]]; then
    python3 -m venv venv
fi
venv/bin/pip install -q -r requirements.txt

# Create .env if not exists
if [[ ! -f .env ]]; then
    cat > .env <<ENVFILE
DATABASE_URL=postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}
JWT_SECRET=$(gen_secret)
ENCRYPTION_KEY=$(gen_secret | head -c 32)
UPLOAD_DIR=${INSTALL_DIR}/uploads
FORM_BASE_URL=https://${DOMAIN}:${FRONTEND_PORT}

# VG DocVerify API
VG_API_BASE=https://vpays.in/VGDocverify/VGKVerify.asmx
VG_MOCK_MODE=true
VG_USER_ID=33
VG_KEY=
VG_BANK_CODE=VGIL
VG_BANK_NAME=VIRTUAL URBAN CO-OPERATIVE BANK LTD

# AiSensy WhatsApp OTP
AISENSY_API_KEY=
AISENSY_CAMPAIGN_NAME=otp_verification
ENVFILE
    log "Created backend .env — fill in API keys manually"
fi

mkdir -p "${INSTALL_DIR}/uploads"
cd "${INSTALL_DIR}"
log "Phase 5 complete"

# ── Phase 6: Frontend Build ──────────────────────────────────────────────────

log "── Phase 6: Frontend Build ──"

cd "${INSTALL_DIR}/frontend"
npm install --silent 2>/dev/null || true
npm run build
cd "${INSTALL_DIR}"

# Create HTTPS server wrapper if not exists
if [[ ! -f "${INSTALL_DIR}/frontend/https-server.js" ]]; then
    cat > "${INSTALL_DIR}/frontend/https-server.js" <<'JSEOF'
const { createServer } = require("https");
const { parse } = require("url");
const next = require("next");
const fs = require("fs");

const app = next({ dev: false });
const handle = app.getRequestHandler();
const port = process.env.PORT || 3001;

const httpsOptions = {
  key: fs.readFileSync(process.env.SSL_KEY || "/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/privkey.pem"),
  cert: fs.readFileSync(process.env.SSL_CERT || "/etc/letsencrypt/live/virtualvaani.vgipl.com-0002/fullchain.pem"),
};

app.prepare().then(() => {
  createServer(httpsOptions, (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(port, "0.0.0.0", () => {
    console.log(`> HTTPS server running on https://0.0.0.0:${port}`);
  });
});
JSEOF
fi

log "Phase 6 complete"

# ── Phase 7: Systemd Services ────────────────────────────────────────────────

log "── Phase 7: Systemd Services ──"

cat > /etc/systemd/system/los-backend.service <<SVC
[Unit]
Description=LOS Form Backend (FastAPI)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}/backend
EnvironmentFile=${INSTALL_DIR}/backend/.env
ExecStart=${INSTALL_DIR}/backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port ${BACKEND_PORT} --ssl-keyfile ${SSL_CERT_DIR}/privkey.pem --ssl-certfile ${SSL_CERT_DIR}/fullchain.pem
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVC

cat > /etc/systemd/system/los-frontend.service <<SVC
[Unit]
Description=LOS Form Frontend (Next.js HTTPS)
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}/frontend
Environment="PORT=${FRONTEND_PORT}"
ExecStart=/usr/bin/node ${INSTALL_DIR}/frontend/https-server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable los-backend los-frontend

log "Phase 7 complete"

# ── Phase 8: Firewall ────────────────────────────────────────────────────────

log "── Phase 8: Firewall ──"

if have_cmd ufw; then
    ufw allow ${BACKEND_PORT}/tcp comment "LOS Backend" 2>/dev/null || true
    ufw allow ${FRONTEND_PORT}/tcp comment "LOS Frontend" 2>/dev/null || true
    log "Firewall rules added"
else
    warn "ufw not found — manually open ports ${BACKEND_PORT} and ${FRONTEND_PORT}"
fi

# ── Phase 9: Start Services ──────────────────────────────────────────────────

log "── Phase 9: Start Services ──"

systemctl restart los-backend los-frontend

sleep 5
wait_for_port ${BACKEND_PORT} "Backend" 15
wait_for_port ${FRONTEND_PORT} "Frontend" 15

# Health check
if curl -fsk "https://localhost:${BACKEND_PORT}/" >/dev/null 2>&1; then
    log "Backend health check passed"
else
    warn "Backend health check failed"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

log "══════════════════════════════════════════════════════════"
log " LOS Form Installation Complete"
log "══════════════════════════════════════════════════════════"
log ""
log " Backend:  https://${DOMAIN}:${BACKEND_PORT}"
log " Frontend: https://${DOMAIN}:${FRONTEND_PORT}"
log ""
log " Admin Login:"
log "   URL:   https://${DOMAIN}:${FRONTEND_PORT}/admin/login"
log "   Email: admin@bank.com"
log "   Pass:  admin123 (change after first login)"
log ""
log " Database:"
log "   Container: ${PG_CONTAINER}"
log "   Port:      ${PG_PORT}"
log ""
log " Logs:"
log "   journalctl -u los-backend -f"
log "   journalctl -u los-frontend -f"
log ""
log " Quick update:"
log "   sudo bash scripts/deploy.sh --update"
log "══════════════════════════════════════════════════════════"
