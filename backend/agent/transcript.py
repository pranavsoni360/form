# backend/agent/transcript.py
import json
import math
import uuid
import logging
from decimal import Decimal
from datetime import datetime, timezone

from fastapi import APIRouter

from . import state as _state
from .state import (
    now_ist, RECORDING_BASE_URL, _row_to_dict,
    TranscriptPayload, IST,
)

logger = logging.getLogger("agent-transcript")
router = APIRouter()

# Both status names indicate a callback was already scheduled during this call.
# We must preserve whichever variant is stored so the dispatcher still picks it up.
_CALLBACK_STATUSES = {"Scheduled", "Called - Callback Requested"}


async def _bill_completed_call(call: dict, billable_seconds: int) -> None:
    """Debit the bank's prepaid wallet for a CONNECTED call, per-minute at the
    bank's rate card. Runs inside the call-completion webhook, so it is:
      * best-effort — any failure is logged, NEVER raised (billing must never
        break call finalization);
      * idempotent — guarded on usage_records.call_id so a re-fired webhook can't
        double-bill;
      * graceful — a bank with no rate_card_id is simply not billed (logged).
    The credit_ledger BEFORE trigger computes balance_after (= balance + amount, so
    a debit is a NEGATIVE amount) and the AFTER trigger auto-pauses at <= 0.
    """
    try:
        bank_id = call.get("bank_id")
        call_id = call.get("id")
        if not bank_id or not call_id or billable_seconds <= 0:
            return  # no bank to bill, or the call never connected
        bank_uuid = uuid.UUID(str(bank_id))
        call_uuid = uuid.UUID(str(call_id))

        # idempotency — already billed for this call?
        if await _state.db_pool.fetchval("SELECT 1 FROM usage_records WHERE call_id = $1 LIMIT 1", call_uuid):
            return

        rate = await _state.db_pool.fetchval(
            """SELECT rc.rate_per_minute FROM banks b
                 JOIN rate_cards rc ON rc.id = b.rate_card_id
                WHERE b.id = $1 AND rc.is_active AND NOT rc.is_deleted""",
            bank_uuid,
        )
        if rate is None:
            return  # bank not on a rate card yet — nothing to bill

        minutes = max(1, math.ceil(billable_seconds / 60))  # per-minute, rounded up, min 1
        amount = Decimal(minutes) * rate  # positive cost

        await _state.db_pool.execute(
            """INSERT INTO usage_records
                   (bank_id, call_id, billable_seconds, billable_minutes,
                    rate_per_minute, amount, currency, billing_period)
               VALUES ($1,$2,$3,$4,$5,$6,'INR', CURRENT_DATE)""",
            bank_uuid, call_uuid, billable_seconds, minutes, rate, amount,
        )
        await _state.db_pool.execute(
            """INSERT INTO credit_ledger
                   (bank_id, entry_type, amount, currency, related_call_id, actor_type, note)
               VALUES ($1,'debit',$2,'INR',$3,'system',$4)""",
            bank_uuid, -amount, call_uuid, f"Call {call_id}: {minutes} min @ {rate}/min",
        )
        logger.info("Billed bank %s ₹%s for call %s (%s min)", bank_id, amount, call_id, minutes)
    except Exception as e:
        logger.warning("Billing skipped for call %s: %s", call.get("id"), e)


@router.post("/transcript")
async def save_transcript(data: TranscriptPayload):
    """Save transcript from the voice agent. This is a webhook -- no JWT auth."""
    transcript = [item.model_dump() for item in data.transcript]
    room = data.room

    # Determine query target (prefer call_id)
    call_uuid = None
    if data.call_id:
        try:
            call_uuid = uuid.UUID(data.call_id)
        except ValueError:
            pass

    # Look up the call
    if call_uuid:
        call_row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", call_uuid)
    else:
        call_row = await _state.db_pool.fetchrow("SELECT * FROM agent_calls WHERE room_name = $1", room)

    if not call_row:
        logger.warning(f"Transcript webhook: no call found for room={room}, call_id={data.call_id}")
        return {"status": "error", "message": "Call not found"}

    call = _row_to_dict(call_row)
    actual_uuid = uuid.UUID(call["id"])

    # Determine final status.
    # IMPORTANT: if the voice agent already called schedule_callback() during this
    # conversation (status='Scheduled'), we MUST preserve that — the transcript
    # webhook fires a few seconds after end_call() and would otherwise overwrite
    # 'Scheduled' with 'Called - Not Interested', which silently drops the callback.
    existing_status = call.get("status")
    outcome = (data.call_outcome or "").strip().lower()
    if existing_status in _CALLBACK_STATUSES:
        # Callback already registered — preserve whichever variant is in the DB
        # so the dispatcher still picks this row up when scheduled_callback_at arrives.
        status = existing_status
    elif outcome == "wrong_number":
        # The call WAS answered (there's a conversation), but the callee said they
        # aren't the intended customer, so the agent ended with end_call
        # ("wrong_number"). Give it a dedicated status instead of letting it fall
        # through to "Called - Not Interested" (or "Not Answered") — those
        # misreport a reached-wrong-person as a rejection / no-answer.
        status = "Wrong Contact"
    elif transcript:
        status = "Called - Interested" if data.customer_interested else "Called - Not Interested"
    else:
        status = "Not Answered"

    recording_url = f"{RECORDING_BASE_URL}{data.recording_path}" if data.recording_path and RECORDING_BASE_URL else None

    # Calculate duration
    duration_seconds = 0
    if call.get("started_at"):
        try:
            start = call["started_at"]
            if isinstance(start, str):
                start = datetime.fromisoformat(start)
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc).astimezone(IST)
            duration_seconds = int((now_ist() - start).total_seconds())
        except Exception:
            pass

    # Build collected_data from qualification fields
    existing_collected = call.get("collected_data") or {}
    if isinstance(existing_collected, str):
        existing_collected = json.loads(existing_collected)
    qualification_data = {
        "customer_type": data.customer_type or existing_collected.get("customer_type"),
        "employment_type": data.employment_type or existing_collected.get("employment_type"),
        "business_type": data.business_type or existing_collected.get("business_type"),
        "monthly_income": data.monthly_income or existing_collected.get("monthly_income"),
        "interest_reason": data.interest_reason or existing_collected.get("interest_reason"),
        "age": data.age or existing_collected.get("age"),
        "loan_purpose": data.loan_purpose or existing_collected.get("loan_purpose"),
        "employer_name": data.employer_name or existing_collected.get("employer_name"),
        "designation": data.designation or existing_collected.get("designation"),
        "qualification": data.qualification or existing_collected.get("qualification"),
        "sector": data.sector or existing_collected.get("sector"),
        "working_experience": data.working_experience or existing_collected.get("working_experience"),
        "existing_emi": data.existing_emi or existing_collected.get("existing_emi"),
        "business_age": data.business_age or existing_collected.get("business_age"),
        "monthly_turnover": data.monthly_turnover or existing_collected.get("monthly_turnover"),
        "collected_address": data.collected_address or existing_collected.get("collected_address"),
        "is_salaried": data.is_salaried or existing_collected.get("is_salaried"),
        "individual_purpose": data.individual_purpose or existing_collected.get("individual_purpose"),
    }
    existing_collected.update({k: v for k, v in qualification_data.items() if v})

    if existing_status in _CALLBACK_STATUSES:
        category = call.get("category") or "Scheduled Callback"
    elif outcome == "wrong_number":
        category = "Wrong Number / Not Reachable"
    elif transcript:
        category = "Uncategorized"
    else:
        category = "Call Not Connected"

    # Build call_analysis JSONB with lead_quality so dashboard stats can find hot/warm leads.
    call_analysis = {
        "lead_quality": (data.lead_quality or "cold").lower(),
        "interest_reason": data.interest_reason,
        "call_outcome": data.call_outcome,
    }

    # Safe parse: agent occasionally sends free-text amounts ("5 lakh") that would crash float().
    def _safe_amount(v):
        if v is None: return None
        s = str(v).strip()
        if not s: return None
        digits = "".join(c for c in s if c.isdigit() or c == ".")
        try:
            return float(digits) if digits else None
        except ValueError:
            return None

    await _state.db_pool.execute(
        """UPDATE agent_calls SET
            transcript = $1,
            status = $2,
            recording_url = $3,
            ended_at = $4,
            call_duration = $5,
            updated_at = $4,
            interested = $6,
            form_sent = $7,
            loan_type = COALESCE($8, loan_type),
            loan_amount = COALESCE($9, loan_amount),
            collected_data = $10,
            category = $11,
            call_analysis = $12::jsonb
           WHERE id = $13""",
        json.dumps(transcript),
        status,
        recording_url,
        now_ist(),
        duration_seconds,
        data.customer_interested,
        # Preserve the sender's real result (whatsapp.py writes form_sent/form_status
        # from the actual AiSensy accept/fail). Do NOT overwrite it with the voice
        # agent's optimistic self-report (which only means "I called the tool").
        call.get("form_sent") or False,
        data.loan_type or None,
        _safe_amount(data.loan_amount),
        json.dumps(existing_collected),
        category,
        json.dumps(call_analysis),
        actual_uuid,
    )

    # Meter + debit the bank's prepaid wallet for this CONNECTED call (a transcript
    # means the call was answered). Best-effort + idempotent; never blocks the webhook.
    if transcript:
        await _bill_completed_call(call, duration_seconds)

    # ── If a loan_application was created from this call, backfill with collected data ──
    try:
        app_row = await _state.db_pool.fetchrow(
            "SELECT id FROM loan_applications WHERE agent_call_id = $1", actual_uuid)
        if app_row:
            from main import save_field_sources
            # Same free-text → dropdown-code mappers used by the live-call
            # seeding path. Without these, this end-of-call backfill's COALESCE
            # would overwrite the codes whatsapp.py already wrote with raw free
            # text ("salaried"), re-blanking the Occupation / Employment Type /
            # Industry Type dropdowns ~8s after the form was created.
            from .whatsapp import (
                _map_employment_type, _map_occupation, _map_industry_type, _parse_years,
            )

            def _parse_num(val):
                if not val: return None
                cleaned = "".join(c for c in str(val) if c.isdigit() or c == ".")
                try: return float(cleaned) if cleaned else None
                except ValueError: return None

            _emp_code = _map_employment_type(existing_collected.get("employment_type"))
            _occ_code = _map_occupation(existing_collected.get("occupation"), _emp_code)
            _ind_code = _map_industry_type(
                existing_collected.get("business_type") or existing_collected.get("sector")
            )
            _total_exp = _parse_years(existing_collected.get("working_experience"))
            _cur_org_exp = _parse_years(
                existing_collected.get("experience_current_org")
                or existing_collected.get("current_org_experience")
            )

            await _state.db_pool.execute(
                """UPDATE loan_applications SET
                    employer_name = COALESCE($1, employer_name),
                    designation = COALESCE($2, designation),
                    employment_type = COALESCE($3, employment_type),
                    monthly_gross_income = COALESCE($4, monthly_gross_income),
                    monthly_emi_existing = COALESCE($5, monthly_emi_existing),
                    current_address = COALESCE($6, current_address),
                    purpose_of_loan = COALESCE($7, purpose_of_loan),
                    loan_amount_requested = COALESCE($8, loan_amount_requested),
                    industry_type = COALESCE($9, industry_type),
                    customer_type = COALESCE($10, customer_type),
                    qualification = COALESCE($11, qualification),
                    total_work_experience = COALESCE($12, total_work_experience),
                    occupation = COALESCE($13, occupation),
                    experience_current_org = COALESCE($14, experience_current_org)
                WHERE id = $15""",
                existing_collected.get("employer_name") or None,
                existing_collected.get("designation") or None,
                _emp_code,
                _parse_num(existing_collected.get("monthly_income")),
                _parse_num(existing_collected.get("existing_emi")),
                existing_collected.get("collected_address") or None,
                existing_collected.get("loan_purpose") or None,
                _parse_num(data.loan_amount),
                _ind_code,
                existing_collected.get("customer_type") or None,
                existing_collected.get("qualification") or None,
                _total_exp,
                _occ_code,
                _cur_org_exp,
                app_row["id"],
            )
            # Save field_sources for Voice Call badges. Coded dropdowns are only
            # badged when a code resolved; the tooltip shows the raw free text.
            source_fields = {}
            field_map = {
                "employer_name": existing_collected.get("employer_name"),
                "designation": existing_collected.get("designation"),
                "employment_type": existing_collected.get("employment_type") if _emp_code else None,
                "occupation": (existing_collected.get("occupation") or existing_collected.get("employment_type")) if _occ_code else None,
                "monthly_gross_income": existing_collected.get("monthly_income"),
                "monthly_emi_existing": existing_collected.get("existing_emi"),
                "current_address": existing_collected.get("collected_address"),
                "purpose_of_loan": existing_collected.get("loan_purpose"),
                "industry_type": existing_collected.get("business_type") if _ind_code else None,
                "customer_type": existing_collected.get("customer_type"),
                "qualification": existing_collected.get("qualification"),
                "total_work_experience": _total_exp,
                "experience_current_org": _cur_org_exp,
            }
            for field, value in field_map.items():
                if value and str(value).strip():
                    source_fields[field] = value
            if source_fields:
                await save_field_sources(app_row["id"], "agent_call", source_fields)
            logger.info(f"Backfilled loan_application {app_row['id']} with {len(source_fields)} fields from call data")
    except Exception as e:
        logger.warning(f"Could not backfill loan_application: {e}")

    # ── Post-call WhatsApp safety net ──
    # An interested customer who hangs up before the agent fires
    # send_form_link (e.g. "haan link bhej do" → hang up 15s later) used to
    # get NOTHING — form sending only existed inside the live call. If the
    # call ended interested with no form sent, send it from here. Idempotent:
    # skips when the agent already sent (payload flag) or a prior webhook
    # already delivered (DB form_sent).
    try:
        if (
            data.customer_interested
            and not data.whatsapp_form_sent
            and not call.get("form_sent")
            and call.get("phone")
        ):
            from .whatsapp import send_whatsapp_form_impl
            result = await send_whatsapp_form_impl({
                "phone": call.get("phone"),
                "customer_name": call.get("customer_name"),
                "customer_type": data.customer_type,
                "call_id": str(actual_uuid),
                "loan_type": data.loan_type or call.get("loan_type") or "personal",
                "estimated_amount": data.loan_amount or 0,
                # DB collected_data was updated just above — impl reads it.
                "collected_data": {},
            })
            logger.info(
                f"Post-call WhatsApp safety net for {actual_uuid}: "
                f"sent={result.get('whatsapp_sent')} ({result.get('message')})"
            )
    except Exception as e:
        logger.error(f"Post-call WhatsApp safety net failed (non-fatal): {e}")

    # M3: enqueue immediate transcript analysis job. The job worker pool runs
    # Gemini categorization off the request thread so this webhook returns fast.
    # Idempotency is handled inside the handler (skips if already categorized)
    # and by the analytics cron's NOT EXISTS check (avoids duplicate jobs).
    if transcript:
        try:
            from services.job_worker import enqueue_job
            await enqueue_job(
                _state.db_pool,
                job_type="transcript_analyze",
                payload={"call_id": str(actual_uuid)},
            )
            logger.info(f"Enqueued transcript_analyze job for call {actual_uuid}")
        except Exception as e:
            # Non-fatal — the analytics cron will sweep this call up later
            logger.warning(f"Failed to enqueue transcript_analyze for {actual_uuid}: {e}")

    return {"status": "success", "room": room, "updated": True}
