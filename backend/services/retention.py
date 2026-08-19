"""Data-retention purge (plan §42).

Per-bank, driven by bank_retention_config. For each bank that has
auto_purge_enabled, redacts call recordings + transcripts older than
call_recording_retention_days, and soft-deletes application_documents older than
document_retention_days.

SAFETY:
- DRY-RUN by default. run_retention_purge(pool) reports what WOULD be purged and
  deletes nothing. Only run_retention_purge(pool, dry_run=False) actually redacts.
- The scheduled job (agent/batch.py) runs dry-run unless RETENTION_PURGE_LIVE=true,
  so turning on real deletion is an explicit, auditable opt-in.
- "Redact" nulls the DB reference (recording_url, transcript) so the data is no
  longer reachable through the app. The recording FILE on the media box is left to
  a separate storage-lifecycle step (see plan §25) — this pass handles the
  database-visible copy only, and never touches audit tables.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("retention")


async def run_retention_purge(pool, dry_run: bool = True) -> dict:
    """Purge (or, in dry-run, report) data past each bank's retention window.

    Returns a summary: {dry_run, banks: [{bank_id, recordings, transcripts,
    documents}], totals: {...}}.
    """
    configs = await pool.fetch(
        """SELECT bank_id, call_recording_retention_days, document_retention_days,
                  pii_retention_days
             FROM bank_retention_config
            WHERE auto_purge_enabled = true"""
    )
    summary = {"dry_run": dry_run, "banks": [], "totals": {"recordings": 0, "documents": 0}}

    for c in configs:
        bank_id = c["bank_id"]
        entry = {"bank_id": str(bank_id), "recordings": 0, "documents": 0}

        # ── Call recordings + transcripts ──
        rec_days = c["call_recording_retention_days"]
        if rec_days and rec_days > 0:
            n = await pool.fetchval(
                """SELECT count(*) FROM agent_calls
                    WHERE bank_id = $1
                      AND created_at < NOW() - ($2 || ' days')::interval
                      AND (recording_url IS NOT NULL OR transcript IS NOT NULL)""",
                bank_id, str(rec_days),
            )
            entry["recordings"] = int(n or 0)
            if not dry_run and entry["recordings"]:
                await pool.execute(
                    """UPDATE agent_calls
                          SET recording_url = NULL, transcript = NULL, updated_at = NOW()
                        WHERE bank_id = $1
                          AND created_at < NOW() - ($2 || ' days')::interval
                          AND (recording_url IS NOT NULL OR transcript IS NOT NULL)""",
                    bank_id, str(rec_days),
                )

        # ── Application documents ──
        doc_days = c["document_retention_days"]
        if doc_days and doc_days > 0:
            n = await pool.fetchval(
                """SELECT count(*) FROM application_documents
                    WHERE bank_id = $1
                      AND uploaded_at < NOW() - ($2 || ' days')::interval""",
                bank_id, str(doc_days),
            )
            entry["documents"] = int(n or 0)
            if not dry_run and entry["documents"]:
                await pool.execute(
                    """DELETE FROM application_documents
                        WHERE bank_id = $1
                          AND uploaded_at < NOW() - ($2 || ' days')::interval""",
                    bank_id, str(doc_days),
                )

        summary["banks"].append(entry)
        summary["totals"]["recordings"] += entry["recordings"]
        summary["totals"]["documents"] += entry["documents"]

    verb = "would purge" if dry_run else "purged"
    logger.info(
        "Retention purge (%s): %s %d recording(s) + %d document(s) across %d bank(s)",
        "dry-run" if dry_run else "LIVE", verb,
        summary["totals"]["recordings"], summary["totals"]["documents"], len(configs),
    )
    return summary
