#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$PROJECT_DIR/.los-pids"
LOGDIR="$PROJECT_DIR/logs"
BACKEND_VENV="$PROJECT_DIR/backend/venv/bin"
BACKEND_PORT=8200
FRONTEND_PORT=5180

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Docker Postgres ──────────────────────────────────────────
# Apply every database/migration_*.sql in sorted order. Safe to re-run — all
# migrations use IF NOT EXISTS / IF EXISTS, so existing containers pick up new
# files automatically on next start.
apply_migrations() {
    local container="$1"
    local count=0
    for mig in "$PROJECT_DIR"/database/migration_*.sql; do
        [[ -f "$mig" ]] || continue
        local name
        name=$(basename "$mig")
        docker cp "$mig" "${container}:/tmp/${name}" >/dev/null 2>&1
        # -q silences ALTER TABLE success lines; PGOPTIONS hides NOTICE ("already
        # exists, skipping") spam. Real errors still surface on stderr.
        local errs
        errs=$(PGOPTIONS='--client-min-messages=warning' docker exec -e PGOPTIONS \
            "$container" psql -q -U los_admin -d los_form -f "/tmp/${name}" 2>&1 1>/dev/null \
            | grep -i 'error' || true)
        if [[ -n "$errs" ]]; then
            echo -e "${YELLOW}[db]${NC} ${name} had errors:"
            echo "$errs" | sed 's/^/    /'
        fi
        count=$((count + 1))
    done
    [[ $count -gt 0 ]] && echo -e "${CYAN}[db]${NC} Applied ${count} migration(s)"
}

ensure_postgres() {
    local container="los-postgres-dev"
    local pg_port=5435

    if docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        echo -e "${CYAN}[db]${NC} Postgres already running on port ${pg_port}"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${container}$"; then
        echo -e "${CYAN}[db]${NC} Starting existing Postgres container..."
        docker start "$container" >/dev/null
        sleep 2
    else
        echo -e "${CYAN}[db]${NC} Creating Postgres container on port ${pg_port}..."
        docker run -d --name "$container" \
            -e POSTGRES_USER=${LOS_PG_USER:-los_admin} \
            -e POSTGRES_PASSWORD=${LOS_PG_PASSWORD:?Set LOS_PG_PASSWORD env var} \
            -e POSTGRES_DB=${LOS_PG_DB:-los_form} \
            -p ${pg_port}:5432 \
            --restart unless-stopped \
            postgres:16 >/dev/null
        sleep 3
        echo -e "${CYAN}[db]${NC} Applying schema_v3..."
        docker cp "$PROJECT_DIR/database/schema_v3.sql" "${container}:/tmp/schema_v3.sql"
        docker exec "$container" psql -U los_admin -d los_form -f /tmp/schema_v3.sql
    fi

    apply_migrations "$container"
    echo -e "${GREEN}[db]${NC} Postgres ready on port ${pg_port}"
}

# Wipe all LOS tables and reapply schema_v3 (destructive)
wipe_db() {
    local container="los-postgres-dev"
    if ! docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        echo -e "${RED}[db]${NC} Postgres container not running. Run './run.sh db' first."
        exit 1
    fi
    echo -e "${YELLOW}[db]${NC} Dropping all LOS tables..."
    docker cp "$PROJECT_DIR/database/drop_all.sql" "${container}:/tmp/drop_all.sql"
    docker exec "$container" psql -U los_admin -d los_form -f /tmp/drop_all.sql
    echo -e "${CYAN}[db]${NC} Applying schema_v3..."
    docker cp "$PROJECT_DIR/database/schema_v3.sql" "${container}:/tmp/schema_v3.sql"
    docker exec "$container" psql -U los_admin -d los_form -f /tmp/schema_v3.sql
    echo -e "${GREEN}[db]${NC} Database wiped and reinitialized with schema_v3."
}

# ── Kill stale processes ─────────────────────────────────────
stop_all() {
    if [[ -f "$PIDFILE" ]]; then
        while read -r pid; do
            kill "$pid" 2>/dev/null || true
        done < "$PIDFILE"
        rm -f "$PIDFILE"
    fi
    local backend_pid frontend_pid
    backend_pid=$(lsof -i :${BACKEND_PORT} -t 2>/dev/null || true)
    frontend_pid=$(lsof -i :${FRONTEND_PORT} -t 2>/dev/null || true)
    [[ -n "$backend_pid" ]] && echo "$backend_pid" | xargs kill -9 2>/dev/null || true
    [[ -n "$frontend_pid" ]] && echo "$frontend_pid" | xargs kill -9 2>/dev/null || true
    sleep 1
}

# ── Backend setup ────────────────────────────────────────────
ensure_backend_venv() {
    if [[ ! -d "$BACKEND_VENV" ]]; then
        echo -e "${CYAN}[backend]${NC} Creating Python venv..."
        python3 -m venv "$PROJECT_DIR/backend/venv"
    fi
    local marker="$PROJECT_DIR/backend/venv/.deps-installed"
    if [[ ! -f "$marker" ]] || [[ "$PROJECT_DIR/backend/requirements.txt" -nt "$marker" ]]; then
        echo -e "${CYAN}[backend]${NC} Installing Python dependencies..."
        "$BACKEND_VENV/pip" install -q fastapi uvicorn asyncpg bcrypt PyJWT python-dotenv pydantic email-validator httpx python-multipart aiofiles fpdf2
        touch "$marker"
    fi
}

# ── Frontend (Vite dev) ──────────────────────────────────────
ensure_frontend_deps() {
    if [[ ! -d "$PROJECT_DIR/frontend/node_modules" ]]; then
        echo -e "${CYAN}[frontend]${NC} Installing npm dependencies (first run)..."
        (cd "$PROJECT_DIR/frontend" && npm install --silent)
    fi
}

# ── Start services ───────────────────────────────────────────
start_all() {
    mkdir -p "$LOGDIR" "$PROJECT_DIR/uploads"

    # Backend
    cd "$PROJECT_DIR/backend"
    "$BACKEND_VENV/uvicorn" main:app --host 0.0.0.0 --port ${BACKEND_PORT} > "$LOGDIR/backend.log" 2>&1 &
    echo $! >> "$PIDFILE"
    echo -e "${GREEN}[start]${NC} Backend PID $! → logs/backend.log (port ${BACKEND_PORT})"
    cd "$PROJECT_DIR"

    # Frontend — Vite dev server
    cd "$PROJECT_DIR/frontend"
    ./node_modules/.bin/vite --port ${FRONTEND_PORT} --host 0.0.0.0 > "$LOGDIR/frontend.log" 2>&1 &
    echo $! >> "$PIDFILE"
    echo -e "${GREEN}[start]${NC} Frontend PID $! → logs/frontend.log (port ${FRONTEND_PORT})"
    cd "$PROJECT_DIR"
}

# ── Trap Ctrl+C ──────────────────────────────────────────────
trap 'echo; echo -e "${RED}[stop]${NC} Shutting down..."; stop_all; exit 0' INT TERM

# ── Main ─────────────────────────────────────────────────────
case "${1:-start}" in
    stop)
        stop_all
        echo -e "${YELLOW}[stop]${NC} All processes stopped."
        ;;
    db)
        ensure_postgres
        echo -e "${GREEN}[db]${NC} Postgres is running."
        ;;
    wipe)
        ensure_postgres
        wipe_db
        ;;
    logs)
        tail -f "$LOGDIR"/*.log
        ;;
    build)
        # Production build of the frontend
        ensure_frontend_deps
        echo -e "${CYAN}[frontend]${NC} Building Vite bundle..."
        (cd "$PROJECT_DIR/frontend" && npm run build)
        echo -e "${GREEN}[frontend]${NC} Build complete → frontend/dist"
        ;;
    start|"")
        stop_all
        ensure_postgres
        ensure_backend_venv
        ensure_frontend_deps
        start_all
        echo -e "${GREEN}[ready]${NC} LOS running. Ctrl+C to stop."
        echo -e "${GREEN}[ready]${NC} Backend:  http://localhost:${BACKEND_PORT}"
        echo -e "${GREEN}[ready]${NC} Frontend: http://localhost:${FRONTEND_PORT}"
        wait
        ;;
    *)
        echo "Usage: ./run.sh [start|stop|build|db|wipe|logs]"
        echo "  start  - Start Postgres + backend + Vite dev frontend"
        echo "  stop   - Kill backend & frontend processes"
        echo "  build  - Production-build the Vite frontend"
        echo "  db     - Just ensure Postgres is running"
        echo "  wipe   - DESTRUCTIVE: drop all tables & reapply schema_v3"
        echo "  logs   - Tail backend and frontend logs"
        exit 1
        ;;
esac
