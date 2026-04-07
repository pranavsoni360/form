#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$PROJECT_DIR/.los-pids"
LOGDIR="$PROJECT_DIR/logs"
BACKEND_VENV="$PROJECT_DIR/backend/venv/bin"
BACKEND_PORT=8200
FRONTEND_PORT=3001

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Docker Postgres ──────────────────────────────────────────
ensure_postgres() {
    local container="los-postgres-dev"
    local pg_port=5435

    if docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        echo -e "${CYAN}[db]${NC} Postgres already running on port ${pg_port}"
        return 0
    fi

    if docker ps -a --format '{{.Names}}' | grep -q "^${container}$"; then
        echo -e "${CYAN}[db]${NC} Starting existing Postgres container..."
        docker start "$container"
    else
        echo -e "${CYAN}[db]${NC} Creating Postgres container on port ${pg_port}..."
        docker run -d --name "$container" \
            -e POSTGRES_USER=${LOS_PG_USER:-los_admin} \
            -e POSTGRES_PASSWORD=${LOS_PG_PASSWORD:?Set LOS_PG_PASSWORD env var} \
            -e POSTGRES_DB=${LOS_PG_DB:-los_form} \
            -p ${pg_port}:5432 \
            --restart unless-stopped \
            postgres:16
        sleep 3
        echo -e "${CYAN}[db]${NC} Running schema migrations..."
        docker cp "$PROJECT_DIR/database/schema.sql" "${container}:/tmp/schema.sql"
        docker exec "$container" psql -U los_admin -d los_form -f /tmp/schema.sql 2>/dev/null || true
        if [[ -f "$PROJECT_DIR/database/migration_v2.sql" ]]; then
            docker cp "$PROJECT_DIR/database/migration_v2.sql" "${container}:/tmp/migration_v2.sql"
            docker exec "$container" psql -U los_admin -d los_form -f /tmp/migration_v2.sql 2>/dev/null || true
        fi
    fi
    echo -e "${GREEN}[db]${NC} Postgres ready on port ${pg_port}"
}

# MongoDB removed — agent module uses Postgres

# ── Kill stale processes ─────────────────────────────────────
stop_all() {
    if [[ -f "$PIDFILE" ]]; then
        while read -r pid; do
            kill "$pid" 2>/dev/null || true
        done < "$PIDFILE"
        rm -f "$PIDFILE"
    fi
    # Kill by port
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
    # Install deps if requirements changed
    local marker="$PROJECT_DIR/backend/venv/.deps-installed"
    if [[ ! -f "$marker" ]] || [[ "$PROJECT_DIR/backend/requirements.txt" -nt "$marker" ]]; then
        echo -e "${CYAN}[backend]${NC} Installing Python dependencies..."
        "$BACKEND_VENV/pip" install -q fastapi uvicorn asyncpg bcrypt PyJWT python-dotenv pydantic email-validator httpx python-multipart aiofiles
        touch "$marker"
    fi
}

# ── Frontend build ───────────────────────────────────────────
needs_frontend_build() {
    local next_dir="$PROJECT_DIR/frontend/.next"
    [[ ! -d "$next_dir" ]] && return 0
    # Check if source files are newer than build
    local newest_src newest_build
    newest_src=$(find "$PROJECT_DIR/frontend/app" "$PROJECT_DIR/frontend/components" "$PROJECT_DIR/frontend/lib" -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
    newest_build=$(stat -c '%Y' "$next_dir" 2>/dev/null || echo 0)
    (( $(echo "${newest_src:-0} > $newest_build" | bc) )) && return 0
    return 1
}

build_frontend() {
    echo -e "${CYAN}[frontend]${NC} Installing npm dependencies..."
    cd "$PROJECT_DIR/frontend" && npm install --silent 2>/dev/null
    echo -e "${CYAN}[frontend]${NC} Building Next.js..."
    npm run build
    cd "$PROJECT_DIR"
    echo -e "${GREEN}[frontend]${NC} Frontend build complete."
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

    # Frontend
    cd "$PROJECT_DIR/frontend"
    PORT=${FRONTEND_PORT} npx next start -p ${FRONTEND_PORT} > "$LOGDIR/frontend.log" 2>&1 &
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
    build)
        stop_all
        ensure_postgres
        ensure_backend_venv
        build_frontend
        start_all
        echo -e "${GREEN}[ready]${NC} LOS Form running. Ctrl+C to stop."
        echo -e "${GREEN}[ready]${NC} Backend:  http://localhost:${BACKEND_PORT}"
        echo -e "${GREEN}[ready]${NC} Frontend: http://localhost:${FRONTEND_PORT}"
        wait
        ;;
    db)
        ensure_postgres
        echo -e "${GREEN}[db]${NC} Postgres is running."
        ;;
    logs)
        tail -f "$LOGDIR"/*.log
        ;;
    start|"")
        stop_all
        ensure_postgres
        ensure_backend_venv
        if needs_frontend_build; then
            build_frontend
        else
            echo -e "${CYAN}[frontend]${NC} Build up to date, skipping."
        fi
        start_all
        echo -e "${GREEN}[ready]${NC} LOS Form running. Ctrl+C to stop."
        echo -e "${GREEN}[ready]${NC} Backend:  http://localhost:${BACKEND_PORT}"
        echo -e "${GREEN}[ready]${NC} Frontend: http://localhost:${FRONTEND_PORT}"
        wait
        ;;
    *)
        echo "Usage: ./run.sh [start|stop|build|db|logs]"
        echo "  start  - Start Docker + backend + frontend (auto-build if needed)"
        echo "  stop   - Kill all LOS processes"
        echo "  build  - Force rebuild frontend + restart everything"
        echo "  db     - Just ensure Postgres is running"
        echo "  logs   - Tail backend and frontend logs"
        exit 1
        ;;
esac
