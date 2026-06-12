# backend/guarantor/trigger.py
"""Enqueue a guarantor consent call when a loan form is submitted with guarantor details.

Best-effort + additive: any failure here MUST NOT break form submission.
"""
import logging

logger = logging.getLogger("guarantor-trigger")


def _digits(s) -> str:
    return "".join(c for c in str(s or "") if c.isdigit())


async def enqueue_guarantor_consent_call(db_pool, application_id) -> None:
    """Upsert a guarantor_consent_calls row for the given loan application.

    Rules (see spec): skip if no guarantor details; skip if guarantor phone ==
    customer phone; resolve language (via linked agent_call) + bank_name; upsert
    keyed by application_id; re-call on changed number only if not yet completed.
    """
    app = await db_pool.fetchrow(
        """SELECT id, bank_id, customer_name, phone, guarantor_name, guarantor_phone,
                  loan_amount_requested, agent_call_id
             FROM loan_applications WHERE id = $1""",
        application_id,
    )
    if not app:
        return

    g_name = (app["guarantor_name"] or "").strip()
    g_phone_digits = _digits(app["guarantor_phone"])
    if not g_name or not g_phone_digits:
        logger.info("Guarantor enqueue skipped (no guarantor details) app=%s", application_id)
        return

    if g_phone_digits[-10:] == _digits(app["phone"])[-10:] and len(g_phone_digits) >= 10:
        logger.warning("Guarantor phone == customer phone; skipping app=%s", application_id)
        return

    # Resolve language from the linked agent_call (else hindi).
    language = "hindi"
    if app["agent_call_id"]:
        lang_row = await db_pool.fetchrow(
            "SELECT language FROM agent_calls WHERE id = $1", app["agent_call_id"]
        )
        if lang_row and lang_row["language"]:
            language = lang_row["language"]

    # Resolve bank name (else ABC Bank).
    bank_name = "ABC Bank"
    if app["bank_id"]:
        b = await db_pool.fetchrow("SELECT name FROM banks WHERE id = $1", app["bank_id"])
        if b and b["name"]:
            bank_name = b["name"]

    existing = await db_pool.fetchrow(
        "SELECT id, status, guarantor_phone FROM guarantor_consent_calls WHERE application_id = $1",
        application_id,
    )

    if existing is None:
        await db_pool.execute(
            """INSERT INTO guarantor_consent_calls
                 (application_id, bank_id, bank_name, guarantor_name, guarantor_phone,
                  borrower_name, loan_amount, language, status, scheduled_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW(),NOW(),NOW())""",
            application_id, app["bank_id"], bank_name, g_name, g_phone_digits,
            app["customer_name"], app["loan_amount_requested"], language,
        )
        # Mirror initial state.
        await db_pool.execute(
            "UPDATE loan_applications SET guarantor_consent = 'pending' WHERE id = $1",
            application_id,
        )
        logger.info("Guarantor consent call enqueued app=%s", application_id)
        return

    # Row exists: re-call only if not yet completed AND number changed.
    if existing["status"] != "completed" and _digits(existing["guarantor_phone"]) != g_phone_digits:
        await db_pool.execute(
            """UPDATE guarantor_consent_calls
                 SET guarantor_phone=$1, status='pending', retry_count=0,
                     scheduled_at=NOW(), updated_at=NOW()
               WHERE application_id=$2""",
            g_phone_digits, application_id,
        )
        await db_pool.execute(
            "UPDATE loan_applications SET guarantor_consent='pending' WHERE id=$1", application_id
        )
        logger.info("Guarantor consent call re-queued (number changed) app=%s", application_id)
