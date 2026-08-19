"""
Database migration runner.

Wired into FastAPI startup (see main.py @app.on_event("startup")). Finds every
`database/migration_*.sql` in sorted order, applies the ones not yet in the
`_migrations` tracker, and records the result.

Design notes:
- Uses pg_try_advisory_lock(8200) to prevent two uvicorn workers from racing.
  The losing worker logs and skips; the winning worker holds the lock for the
  whole run (lock auto-releases when the connection is closed).
- Files containing `CONCURRENTLY` are executed without a surrounding BEGIN/
  COMMIT (Postgres forbids CREATE INDEX CONCURRENTLY inside a transaction).
  All other files run inside a transaction so a mid-file failure rolls back.
- _migrations table is bootstrapped on every run with CREATE TABLE IF NOT
  EXISTS, so a fresh DB works even before v6 runs.
- The runner is idempotent and safe to re-run.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import asyncpg


logger = logging.getLogger(__name__)

# Postgres advisory lock key. Chosen to match BACKEND_PORT (8200) for ease of
# debugging — `SELECT pg_locks WHERE objid = 8200` shows the migration lock.
ADVISORY_LOCK_KEY = 8200

BOOTSTRAP_SQL = """
CREATE TABLE IF NOT EXISTS _migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT
);
"""

CONCURRENTLY_PATTERN = re.compile(r"\bCONCURRENTLY\b", re.IGNORECASE)


_VERSION_PATTERN = re.compile(r"^migration_v(\d+)", re.IGNORECASE)


def _sort_key(path: Path) -> tuple[int, str]:
    """Sort by extracted version number, falling back to filename.

    Lexical sort is wrong because 'v10' < 'v2'. We need 'v2' < 'v10'.
    Files without v<digits> (e.g. migration_agent_tables.sql) sort to the
    front with version 0, in lexical order among themselves.
    """
    m = _VERSION_PATTERN.match(path.name)
    version = int(m.group(1)) if m else 0
    return (version, path.name)


def _find_migrations(migrations_dir: Path) -> list[Path]:
    """Return migration_*.sql files sorted by numeric version."""
    return sorted(migrations_dir.glob("migration_*.sql"), key=_sort_key)


async def _already_applied(conn: asyncpg.Connection, filename: str) -> bool:
    row = await conn.fetchrow(
        "SELECT 1 FROM _migrations WHERE filename = $1", filename
    )
    return row is not None


async def _record(conn: asyncpg.Connection, filename: str) -> None:
    await conn.execute(
        "INSERT INTO _migrations (filename, checksum) VALUES ($1, 'applied') "
        "ON CONFLICT (filename) DO NOTHING",
        filename,
    )


def _split_top_level_statements(sql: str) -> list[str]:
    """Split SQL into top-level statements, respecting:
      - single-quoted strings: '...'
      - $$ ... $$ dollar-quoted blocks (and $tag$ ... $tag$)
      - -- line comments and /* ... */ block comments
    Splits only on top-level `;`. Empty/whitespace-only statements are dropped.
    """
    out: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(sql)
    in_single = False
    in_line_comment = False
    in_block_comment = False
    dollar_tag: str | None = None  # None unless inside a $tag$ ... $tag$ block

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            buf.append(ch)
            if ch == "*" and nxt == "/":
                buf.append(nxt)
                i += 2
                in_block_comment = False
                continue
            i += 1
            continue

        if dollar_tag is not None:
            # Look for the closing tag
            closing = f"${dollar_tag}$"
            if sql.startswith(closing, i):
                buf.append(closing)
                i += len(closing)
                dollar_tag = None
                continue
            buf.append(ch)
            i += 1
            continue

        if in_single:
            buf.append(ch)
            if ch == "'":
                # Postgres escapes single quote by doubling: '' inside string
                if nxt == "'":
                    buf.append(nxt)
                    i += 2
                    continue
                in_single = False
            i += 1
            continue

        # Not in any quoted/commented state
        if ch == "-" and nxt == "-":
            in_line_comment = True
            buf.append(ch)
            i += 1
            continue
        if ch == "/" and nxt == "*":
            in_block_comment = True
            buf.append(ch); buf.append(nxt)
            i += 2
            continue
        if ch == "'":
            in_single = True
            buf.append(ch)
            i += 1
            continue
        if ch == "$":
            # Try to match a dollar-quoted opening: $tag$ or $$
            j = i + 1
            while j < n and (sql[j].isalnum() or sql[j] == "_"):
                j += 1
            if j < n and sql[j] == "$":
                dollar_tag = sql[i + 1 : j]
                buf.append(sql[i : j + 1])
                i = j + 1
                continue

        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


async def _apply_file(conn: asyncpg.Connection, path: Path) -> None:
    """Run a single migration file. Wraps in a transaction unless the SQL
    contains CONCURRENTLY (which Postgres forbids inside a tx). For
    CONCURRENTLY files, split the SQL into individual statements and execute
    each separately, since asyncpg wraps multi-statement queries in implicit
    transactions."""
    sql = path.read_text(encoding="utf-8")

    if CONCURRENTLY_PATTERN.search(sql):
        logger.info("Applying %s (autocommit, contains CONCURRENTLY)", path.name)
        statements = _split_top_level_statements(sql)
        for stmt in statements:
            await conn.execute(stmt)
        # Record in a separate transaction so the tracker row commits atomically.
        async with conn.transaction():
            await _record(conn, path.name)
    else:
        logger.info("Applying %s (transactional)", path.name)
        async with conn.transaction():
            await conn.execute(sql)
            await _record(conn, path.name)


async def run_migrations(
    pool: asyncpg.Pool,
    migrations_dir: Path | None = None,
) -> dict:
    """Apply every pending migration. Returns a summary dict.

    Behavior:
    - Acquires a Postgres advisory lock; if another process holds it, skips
      gracefully (returns summary with skipped=True).
    - Bootstraps the _migrations table if missing.
    - Iterates migration_*.sql in sorted order, applies any not yet recorded.
    """
    if migrations_dir is None:
        # Default: <repo_root>/database/, computed relative to this file.
        # backend/db_migrations.py → ../database/
        migrations_dir = Path(__file__).resolve().parent.parent / "database"

    if not migrations_dir.exists():
        raise FileNotFoundError(f"Migrations directory not found: {migrations_dir}")

    summary = {"applied": [], "skipped_already_applied": [], "skipped_lock": False}

    async with pool.acquire() as conn:
        got_lock = await conn.fetchval(
            "SELECT pg_try_advisory_lock($1)", ADVISORY_LOCK_KEY
        )
        if not got_lock:
            logger.warning(
                "Another process holds the migrations advisory lock (key=%s); "
                "skipping. The other worker will apply pending migrations.",
                ADVISORY_LOCK_KEY,
            )
            summary["skipped_lock"] = True
            return summary

        try:
            # Bootstrap: ensure _migrations exists before we query it. Only run the
            # CREATE when it's actually missing — a least-privilege runtime role
            # (plan §11) has no CREATE on the schema, but _migrations always exists
            # by the time the app starts (the admin deploy step created it), so the
            # check-first path needs only SELECT and never trips the privilege.
            has_tracker = await conn.fetchval("SELECT to_regclass('public._migrations') IS NOT NULL")
            if not has_tracker:
                await conn.execute(BOOTSTRAP_SQL)

            files = _find_migrations(migrations_dir)
            if not files:
                logger.info("No migration files found in %s", migrations_dir)
                return summary

            for path in files:
                if await _already_applied(conn, path.name):
                    summary["skipped_already_applied"].append(path.name)
                    continue
                try:
                    await _apply_file(conn, path)
                    summary["applied"].append(path.name)
                except Exception:
                    logger.exception(
                        "Migration %s FAILED — aborting run. "
                        "Subsequent migrations not attempted.",
                        path.name,
                    )
                    raise

            logger.info(
                "Migrations done: applied=%d, already_applied=%d",
                len(summary["applied"]),
                len(summary["skipped_already_applied"]),
            )
            return summary
        finally:
            # Lock auto-releases when the conn is returned to the pool, but
            # being explicit makes ordering clear if someone refactors.
            await conn.execute("SELECT pg_advisory_unlock($1)", ADVISORY_LOCK_KEY)


# ── Standalone CLI ──────────────────────────────────────────────────────────
# Run as an explicit deploy step BEFORE restarting services:
#   DATABASE_URL=... python db_migrations.py
# Exits 0 on success, non-zero if any migration fails — so the deploy aborts and
# services keep running the old code instead of restarting onto a broken schema.
# This replaces the old `psql < file 2>/dev/null || true` loop, which hid failures.
if __name__ == "__main__":
    import asyncio
    import os
    import sys

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    async def _cli() -> None:
        # Migrations need DDL (CREATE/ALTER), so prefer the privileged migration
        # DSN. The runtime app (plan §11) connects with a scoped role that cannot
        # do DDL, so MIGRATION_DATABASE_URL points at the admin role for deploys.
        dsn = os.getenv("MIGRATION_DATABASE_URL") or os.getenv("DATABASE_URL")
        if not dsn:
            raise SystemExit("db_migrations: neither MIGRATION_DATABASE_URL nor DATABASE_URL set")
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
        try:
            summary = await run_migrations(pool)
        finally:
            await pool.close()
        if summary.get("skipped_lock"):
            print("db_migrations: another process holds the lock; nothing applied here.")
        applied = summary.get("applied", [])
        print(
            f"db_migrations: applied={len(applied)} "
            f"already_applied={len(summary.get('skipped_already_applied', []))}"
        )
        for f in applied:
            print(f"  + {f}")

    try:
        asyncio.run(_cli())
    except SystemExit:
        raise
    except Exception as exc:  # a migration failed → non-zero exit → deploy aborts
        print(f"db_migrations: FAILED — {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
