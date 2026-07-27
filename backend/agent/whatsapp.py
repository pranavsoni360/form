# backend/agent/whatsapp.py
import os
import json
import uuid
import secrets
import time
import logging
from datetime import timedelta

import aiohttp
from fastapi import APIRouter, Request

from . import state as _state
from .state import (
    now_ist, AISENSY_API_KEY, AISENSY_CAMPAIGN_NAME,
    AISENSY_USERNAME, AISENSY_IMAGE_URL, FORM_BASE_URL,
)

logger = logging.getLogger("agent-whatsapp")
router = APIRouter()

# QA-only behavior toggle, gated purely by the database name (same mechanism as
# migration_v21_twilio_phone.sql — zero config, deploy-by-push, prod-safe).
# On the QA database each voice call starts a FRESH loan_applications row instead
# of reusing an existing in-progress draft, so the testing team can re-test from
# one mobile number repeatedly and always see the latest call reflected. Prod
# (los_form) is completely unaffected. The DB name is fixed for a process, so we
# cache it after the first lookup.
_IS_QA_DB: "bool | None" = None


async def _is_qa_db() -> bool:
    global _IS_QA_DB
    if _IS_QA_DB is None:
        try:
            db = await _state.db_pool.fetchval("SELECT current_database()")
            _IS_QA_DB = (db == "los_form_qa")
        except Exception:
            _IS_QA_DB = False  # fail safe → behave like prod (reuse)
    return _IS_QA_DB


@router.post("/send-whatsapp-form")
async def send_whatsapp_form(request: Request):
    """Triggered by the AI voice agent's send_form_link tool.
    Creates a loan_application from call data (so OTP flow works),
    saves field_sources for 'Voice Call' badges, and sends WhatsApp."""
    from main import save_field_sources

    data = await request.json()
    phone = data.get("phone")
    customer_name = data.get("customer_name")
    loan_type = data.get("loan_type", "")
    call_id = data.get("call_id")

    # ── 1. Fetch call data ──
    # Prefer collected_data sent in the payload by the voice agent — it captures
    # everything the customer just said on the call. The DB-side agent_calls.collected_data
    # only gets populated by the end-of-call transcript webhook (~8s after this
    # endpoint fires), so without the inline payload we'd race against a fast
    # customer who clicks the WhatsApp link before the backfill lands.
    call_row = None
    call_uuid = None
    payload_collected = data.get("collected_data") or {}
    if isinstance(payload_collected, str):
        try:
            payload_collected = json.loads(payload_collected)
        except Exception:
            payload_collected = {}
    db_collected: dict = {}
    if call_id:
        try:
            call_uuid = uuid.UUID(call_id)
            call_row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
            if call_row:
                cd = call_row["collected_data"]
                if isinstance(cd, str):
                    cd = json.loads(cd)
                db_collected = cd if isinstance(cd, dict) else {}
        except Exception as e:
            logger.warning(f"Could not fetch call data: {e}")
    # Merge: DB first (oldest), payload last (freshest) — payload wins where set.
    collected = {**db_collected, **{k: v for k, v in payload_collected.items() if v not in (None, "")}}
    if payload_collected:
        logger.info(
            f"send-whatsapp-form: payload_collected has "
            f"{len([v for v in payload_collected.values() if v])} fields; "
            f"merged with db_collected ({len(db_collected)} fields)"
        )

    # ── 2. Normalize phone ──
    if phone and not phone.startswith("+"):
        phone = f"+91{phone[-10:]}"
    phone_clean_digits = "".join(filter(str.isdigit, str(phone or "")))
    if len(phone_clean_digits) == 10:
        phone_norm = f"+91{phone_clean_digits}"
    elif phone_clean_digits.startswith("91") and len(phone_clean_digits) == 12:
        phone_norm = f"+{phone_clean_digits}"
    else:
        phone_norm = phone or ""

    # ── 3. Create loan_application (bridge: agent_calls → loan system) ──
    app_id = None
    agent_type = call_row.get("agent_type", "loan_enquiry") if call_row else "loan_enquiry"

    # Append phone as query param so the OTP page auto-fills and auto-sends.
    # Take the last 10 digits — handles +91/91 prefixes without the str.lstrip
    # character-class footgun (lstrip("91") strips any leading 9s and 1s).
    _digits = ''.join(c for c in (phone_norm or '') if c.isdigit())
    bare_phone = _digits[-10:] if len(_digits) >= 10 else _digits

    if agent_type == "account_opening":
        form_url = f"{FORM_BASE_URL}/bank/account-form?call_id={call_id}"
    else:
        form_url = f"{FORM_BASE_URL}/?phone={bare_phone}" if bare_phone else f"{FORM_BASE_URL}/"

    if phone_norm and agent_type != "account_opening":
        # Reuse an existing in-progress application for this phone — EXCEPT on QA,
        # where every call starts a fresh application so the testing team can
        # re-test the same number repeatedly and always get the latest call's
        # data. (Rows accumulate on QA by design; prod behaviour is unchanged.)
        existing_app = None
        if not await _is_qa_db():
            existing_app = await _state.db_pool.fetchrow(
                "SELECT id FROM loan_applications WHERE phone = $1 AND status != 'submitted' ORDER BY created_at DESC LIMIT 1",
                phone_norm,
            )

        if existing_app:
            app_id = existing_app["id"]
            logger.info(f"Existing application found for {phone_norm}: {app_id}")
        else:
            # Create new loan_application pre-filled from call data
            loan_id = f"AGENT-{secrets.token_hex(4)}-{int(time.time())}"
            bank_id = None
            if call_row and call_row.get("bank_id"):
                try:
                    bank_id = uuid.UUID(str(call_row["bank_id"])) if call_row["bank_id"] else None
                except Exception:
                    pass

            # Parse numeric fields safely
            def parse_num(val):
                if not val:
                    return None
                cleaned = "".join(c for c in str(val) if c.isdigit() or c == ".")
                try:
                    return float(cleaned) if cleaned else None
                except ValueError:
                    return None

            loan_amount = parse_num(call_row["loan_amount"] if call_row else None) or parse_num(collected.get("loan_amount"))

            # Auto-detect consumer durable loan from purpose keywords
            _purpose_raw = (collected.get("loan_purpose") or "").lower()
            _consumer_keywords = [
                "fridge", "refrigerator", "tv", "television", "laptop", "computer", "pc",
                "ac", "air conditioner", "washing machine", "washer", "mobile", "phone",
                "smartphone", "furniture", "sofa", "bed", "microwave", "camera", "led",
                "two wheeler", "bike", "scooter", "electronic", "appliance", "consumer"
            ]
            _consumer_loan_type = "consumer_durable" if any(kw in _purpose_raw for kw in _consumer_keywords) else "personal"
            monthly_income = parse_num(collected.get("monthly_income"))
            existing_emi = parse_num(collected.get("existing_emi"))

            try:
                row = await _state.db_pool.fetchrow(
                    """INSERT INTO loan_applications (
                        customer_name, phone, loan_id, current_step, status, last_saved_at, bank_id,
                        agent_call_id, full_name, employer_name, designation, employment_type,
                        monthly_gross_income, monthly_emi_existing, current_address,
                        purpose_of_loan, loan_amount_requested, customer_type, industry_type,
                        total_work_experience, qualification, consumer_loan_type,
                        guarantor_name, guarantor_phone
                    ) VALUES (
                        $1, $2, $3, 1, 'draft', $4, $5,
                        $6, $7, $8, $9, $10,
                        $11, $12, $13,
                        $14, $15, $16, $17,
                        $18, $19, $20,
                        $21, $22
                    ) RETURNING id""",
                    customer_name or "Customer",
                    phone_norm,
                    loan_id,
                    now_ist(),
                    bank_id,
                    call_uuid,
                    customer_name or "",
                    collected.get("employer_name") or None,
                    collected.get("designation") or None,
                    collected.get("employment_type") or None,
                    monthly_income,
                    existing_emi,
                    collected.get("collected_address") or None,
                    collected.get("loan_purpose") or None,
                    loan_amount,
                    collected.get("customer_type") or "new",
                    collected.get("business_type") or None,
                    collected.get("working_experience") or None,
                    collected.get("qualification") or None,
                    _consumer_loan_type,
                    collected.get("guarantor_name") or None,
                    collected.get("guarantor_phone") or None,
                )
                app_id = row["id"]
                logger.info(f"Created loan_application {app_id} for {phone_norm} from call {call_id}")

                # Save field_sources for "Voice Call" badges
                source_fields = {}
                field_map = {
                    "employer_name": collected.get("employer_name"),
                    "designation": collected.get("designation"),
                    "employment_type": collected.get("employment_type"),
                    "monthly_gross_income": str(monthly_income) if monthly_income else None,
                    "monthly_emi_existing": str(existing_emi) if existing_emi else None,
                    "current_address": collected.get("collected_address"),
                    "purpose_of_loan": collected.get("loan_purpose"),
                    "loan_amount_requested": str(loan_amount) if loan_amount else None,
                    "customer_type": collected.get("customer_type"),
                    "industry_type": collected.get("business_type"),
                    "total_work_experience": collected.get("working_experience"),
                    "qualification": collected.get("qualification"),
                    "consumer_loan_type": _consumer_loan_type,
                    "customer_name": customer_name,
                    "full_name": customer_name,
                    "guarantor_name": collected.get("guarantor_name"),
                    "guarantor_phone": collected.get("guarantor_phone"),
                }
                for field, value in field_map.items():
                    if value and str(value).strip():
                        source_fields[field] = value
                if source_fields:
                    await save_field_sources(app_id, "agent_call", source_fields)

            except Exception as e:
                logger.error(f"Failed to create loan_application: {e}")

        # Link agent_call → application
        if app_id and call_uuid:
            await _state.db_pool.execute(
                "UPDATE agent_calls SET application_id = $1 WHERE id = $2",
                app_id, call_uuid,
            )

    # ── 4. Send WhatsApp via AiSensy ──
    notification_message = (
        f"Dear {customer_name},\n\n"
        f"Thank you for your interest in a {loan_type} loan.\n"
        f"Please click the link below to complete your application:\n"
        f"{form_url}\n"
        f"An OTP will be sent to your WhatsApp automatically."
    )
    print(f"[AiSensy Form] notification for {customer_name} ({phone_norm}) -> {form_url}", flush=True)
    logger.info(f"Form notification for {customer_name} ({phone_norm}): {form_url}")

    aisensy_ok = False
    aisensy_msg_id = None       # AiSensy submitted_message_id (proof of accept)
    aisensy_fail_reason = None  # why the send did not succeed (for audit + UI)

    # ── Dedup guard: don't re-send a form link to the same number within a
    # cooldown window. Repeated sends to one number (from re-dials / retries /
    # the agent invoking send_form_link more than once) trip WhatsApp/Meta's
    # frequency protection ("not delivered to maintain healthy ecosystem
    # engagement"), which then blocks EVEN legitimate first sends. We treat a
    # recent SUCCESSFUL send as "already delivered" and skip re-firing.
    # Window defaults to 24h (Meta's own session window). QA DB is exempt so the
    # test team can re-send from one number repeatedly.
    _skip_send = False
    if phone_norm and not await _is_qa_db():
        try:
            cooldown_hours = int(os.getenv("FORM_RESEND_COOLDOWN_HOURS", "24"))
        except ValueError:
            cooldown_hours = 24
        if cooldown_hours > 0:
            recent = await _state.db_pool.fetchrow(
                """SELECT sent_at FROM whatsapp_messages
                     WHERE phone = $1 AND message_type = 'form_link'
                       AND status = 'sent' AND sent_at IS NOT NULL
                       AND sent_at > $2
                     ORDER BY sent_at DESC LIMIT 1""",
                phone_norm,
                now_ist() - timedelta(hours=cooldown_hours),
            )
            if recent:
                _skip_send = True
                aisensy_ok = True  # already delivered — treat as success
                logger.info(
                    "Form link to %s skipped — already sent %s (within %dh cooldown)",
                    phone_norm, recent["sent_at"], cooldown_hours,
                )
                print(
                    f"[AiSensy Form] SKIPPED (dedup) dest={phone_norm} "
                    f"last_sent={recent['sent_at']} cooldown={cooldown_hours}h",
                    flush=True,
                )

    if not _skip_send and AISENSY_API_KEY and phone_norm:
        wa_phone = "".join(filter(str.isdigit, phone_norm))
        if len(wa_phone) == 10:
            wa_phone = f"91{wa_phone}"

        first_name = customer_name.strip().split()[0] if customer_name else "Customer"
        # Match the LIVE AiSensy 'form_link' template exactly (same as production,
        # which delivers reliably): ONE body param (first name), no dynamic button.
        # The template supplies the link itself. Sending a 2nd param or a URL
        # button that the template does not define returns HTTP 400
        # "Template params does not match the campaign" and nothing is delivered.
        payload = {
            "apiKey": AISENSY_API_KEY,
            "campaignName": AISENSY_CAMPAIGN_NAME,
            "destination": wa_phone,
            "userName": AISENSY_USERNAME,
            "templateParams": [first_name],
            "source": "new-landing-page form",
            "media": {}, "buttons": [], "carouselCards": [], "location": {}, "attributes": {},
            "paramsFallbackValue": {"FirstName": "Customer"},
        }
        # ── Print the outbound payload (minus the API key) so we can debug in journalctl ──
        _debug_payload = {k: ("<redacted>" if k == "apiKey" else v) for k, v in payload.items()}
        print(f"[AiSensy Form] POST campaign={AISENSY_CAMPAIGN_NAME} dest={wa_phone} payload={_debug_payload}", flush=True)
        try:
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    "https://backend.api-wa.co/campaign/virtual-galaxy-infotech/api/v2",
                    json=payload, timeout=aiohttp.ClientTimeout(total=10), ssl=False,
                ) as resp:
                    body = await resp.text()
                    print(f"[AiSensy Form] response status={resp.status} body={body}", flush=True)
                    logger.info(f"AiSensy {wa_phone}: {resp.status} | {body}")
                    # AiSensy returns HTTP 200 even for some errors, and a 200 only
                    # means "accepted/queued". So trust the BODY, not just the code:
                    # success looks like {"success":"true","submitted_message_id":"..."}.
                    parsed = {}
                    try:
                        parsed = json.loads(body) if body else {}
                    except Exception:
                        parsed = {}
                    success_flag = str(parsed.get("success", "")).lower() == "true"
                    aisensy_msg_id = parsed.get("submitted_message_id")
                    aisensy_ok = resp.status == 200 and success_flag and bool(aisensy_msg_id)
                    if not aisensy_ok:
                        aisensy_fail_reason = (
                            parsed.get("message")
                            or parsed.get("error")
                            or f"HTTP {resp.status}: {body[:300]}"
                        )
        except Exception as e:
            aisensy_fail_reason = f"{type(e).__name__}: {e}"
            print(f"[AiSensy Form] EXCEPTION: {type(e).__name__}: {e}", flush=True)
            logger.error(f"AiSensy failed: {e}")
    else:
        aisensy_fail_reason = "aisensy_not_configured_or_no_phone"
        print(f"[AiSensy Form] SKIPPED — api_key_set={bool(AISENSY_API_KEY)} phone_set={bool(phone_norm)}", flush=True)

    # ── 5. Update agent_calls ──
    # form_status is the source of truth for the UI: 'sent' only when AiSensy
    # actually ACCEPTED the message (success flag + submitted_message_id),
    # 'failed' otherwise. HTTP 200 alone is NOT enough. The transcript webhook
    # is not allowed to overwrite this with the agent's optimistic self-report.
    form_status = "sent" if aisensy_ok else "failed"
    if call_uuid:
        try:
            row = await _state.db_pool.fetchrow("SELECT call_analysis FROM agent_calls WHERE id = $1", call_uuid)
            analysis = {}
            if row and row["call_analysis"]:
                analysis = row["call_analysis"] if isinstance(row["call_analysis"], dict) else json.loads(row["call_analysis"])
            analysis["lead_quality"] = "hot"
            analysis["notification_status"] = "sent_via_aisensy" if aisensy_ok else "aisensy_failed"
            analysis["notification_time"] = now_ist().isoformat()
            if aisensy_msg_id:
                analysis["aisensy_message_id"] = aisensy_msg_id
            if aisensy_fail_reason and not aisensy_ok:
                analysis["notification_error"] = str(aisensy_fail_reason)[:500]

            await _state.db_pool.execute(
                """UPDATE agent_calls SET form_sent = $1, form_status = $2, form_link = $3,
                   call_analysis = $4, updated_at = $5 WHERE id = $6""",
                aisensy_ok, form_status, form_url, json.dumps(analysis), now_ist(), call_uuid,
            )
        except Exception as e:
            logger.warning(f"Could not update agent_calls: {e}")

    # ── 5b. Audit row in whatsapp_messages ──
    # Brings the previously-unused delivery-tracking table to life so we keep a
    # per-attempt record (message id on success, reason on failure). A future
    # AiSensy delivery-receipt webhook can UPDATE delivered_at on this row.
    # Skip when we short-circuited on the dedup guard — no attempt was made, so
    # a new audit row would double-count the earlier successful send.
    if phone_norm and not _skip_send:
        try:
            await _state.db_pool.execute(
                """INSERT INTO whatsapp_messages
                       (phone, message_type, message_body, status, sent_at,
                        failed_reason, whatsapp_message_id, application_id)
                   VALUES ($1, 'form_link', $2, $3, $4, $5, $6, $7)""",
                phone_norm,
                notification_message,
                "sent" if aisensy_ok else "failed",
                now_ist() if aisensy_ok else None,
                None if aisensy_ok else str(aisensy_fail_reason or "unknown")[:500],
                aisensy_msg_id,
                app_id,
            )
        except Exception as e:
            logger.warning(f"Could not log whatsapp_messages: {e}")

    # Caller (voice agent) checks `whatsapp_sent` to know whether to retry / disclose to user.
    return {
        "status": "success" if aisensy_ok else "partial",
        "whatsapp_sent": aisensy_ok,
        "message": "Form link sent" if aisensy_ok else "Form created (WhatsApp delivery failed)",
        "form_url": form_url,
        "application_id": str(app_id) if app_id else (call_id if agent_type == "account_opening" else None),
    }
