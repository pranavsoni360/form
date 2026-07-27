# -*- coding: utf-8 -*-
"""
Loan Enquiry Agent — Tool definitions (4 function tools).
Extracted from los_updated.py; no logic changes.
"""

import asyncio
import logging

import aiohttp
from livekit.agents import function_tool, RunContext

from config import BACKEND_URL
from session import LoanEnquirySession

logger = logging.getLogger("loan-enquiry-agent")


def _build_collected_data(session: LoanEnquirySession) -> dict:
    """Snapshot everything the customer answered on the call so the backend
    can pre-fill the WhatsApp loan-application form.

    Field names mirror what backend/agent/whatsapp.py reads via
    `collected.get(...)` when it INSERTs into loan_applications. Empty / None
    values are skipped — backend merges this on top of DB state, so missing
    keys just leave the DB fallback intact.
    """
    raw = {
        "age":                getattr(session, "age", None),
        "loan_type":          getattr(session, "loan_type", None),
        "loan_amount":        getattr(session, "loan_amount", None),
        "loan_purpose":       getattr(session, "loan_purpose", None),
        "employment_type":    getattr(session, "employment_type", None),
        "employer_name":      getattr(session, "employer_name", None),
        "qualification":      getattr(session, "qualification", None),
        "designation":        getattr(session, "designation", None),
        "sector":             getattr(session, "sector", None),
        "working_experience": getattr(session, "working_experience", None),
        "monthly_income":     getattr(session, "monthly_income", None),
        "existing_emi":       getattr(session, "existing_emi", None),
        "business_type":      getattr(session, "business_type", None),
        "business_age":       getattr(session, "business_age", None),
        "monthly_turnover":   getattr(session, "monthly_turnover", None),
        "collected_address":  getattr(session, "collected_address", None),
        "account_type":       getattr(session, "account_type", None),
        "initial_deposit":    getattr(session, "initial_deposit", None),
        "customer_type":      getattr(session, "customer_type", None),
        "is_salaried":        getattr(session, "is_salaried", None),
        "individual_purpose": getattr(session, "individual_purpose", None),
    }
    return {k: v for k, v in raw.items() if v not in (None, "", 0)}


@function_tool(
    name="send_form_link",
    description="Send loan form link via WhatsApp. Call ONLY when customer is interested and agrees.",
)
async def send_form_link(context: RunContext, loan_type: str, estimated_amount: int,
                         delivery_method: str = "whatsapp") -> str:
    session: LoanEnquirySession = context.userdata["session"]
    try:
        # Pass collected fields directly in the payload so the backend can
        # pre-fill loan_applications immediately, without waiting for the
        # end-of-call transcript webhook (which would otherwise lose the race
        # against a customer who clicks the WhatsApp link fast).
        collected_data = _build_collected_data(session)
        # Tool args win over Q&A — LLM has the latest user confirmation.
        if loan_type:
            collected_data["loan_type"] = loan_type
        if estimated_amount:
            collected_data["loan_amount"] = estimated_amount

        payload = {
            "phone": session.phone,
            "customer_name": session.customer_name,
            "customer_type": session.customer_type,
            "call_id": session.call_id,
            "loan_type": loan_type,
            "estimated_amount": estimated_amount,
            "delivery_method": delivery_method,
            "collected_data": collected_data,
        }
        logger.info(
            f"send_form_link prefill: {len(collected_data)} fields -> {sorted(collected_data.keys())}"
        )
        async with aiohttp.ClientSession() as http:
            async with http.post(
                f"{BACKEND_URL}/api/agent/send-whatsapp-form",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10),
                ssl=False,
            ) as resp:
                backend_ok = resp.status == 200
                # The endpoint ALWAYS returns HTTP 200 — even when AiSensy rejects
                # the message it returns 200 with {"whatsapp_sent": false} (the
                # loan_application is created, but nothing is delivered). So
                # HTTP 200 alone is a false "success": trust the body's
                # `whatsapp_sent`, which reflects the REAL WhatsApp delivery.
                try:
                    result = await resp.json()
                except Exception:
                    result = {}
        whatsapp_delivered = bool(result.get("whatsapp_sent"))

        if backend_ok and whatsapp_delivered:
            session.form_link_sent = True
            session.loan_type = loan_type
            session.loan_amount = estimated_amount
            session.set_lead_quality(True, "form_sent")
            # SAFETY NET: the prompt asks the LLM to speak the farewell and
            # then call end_call() in the same turn — but LLM providers drop
            # function calls intermittently (Gemini's 'finish_reason: None',
            # Groq's 'Failed to call a function'). When that happens the
            # farewell text plays but end_call is silently lost, leaving the
            # call hanging for ~25s until silence_monitor fires an awkward
            # second farewell ("लगता है आप व्यस्त हैं") that the user does
            # not want. This task force-closes the call ~10s after form-send,
            # which is enough for the farewell TTS to finish naturally and
            # leaves the agent silent through to room teardown.
            asyncio.create_task(_auto_end_after_form_send(session, grace=10.0))
            return "Form link sent successfully."
        # HTTP 200 but WhatsApp NOT delivered (or a non-200). Do NOT set
        # form_link_sent — leaving it False lets the end_call fallback retry the
        # send. Surface the real reason so the failure is visible, not silent.
        logger.error(
            f"send_form_link: WhatsApp NOT delivered "
            f"(backend_ok={backend_ok}, whatsapp_sent={whatsapp_delivered}, "
            f"reason={result.get('message') or result.get('status')})"
        )
        return "Form link could not be delivered on WhatsApp."
    except Exception as e:
        logger.error(f"send_form_link error: {e}")
        return f"Error: {str(e)}"


async def _auto_end_after_form_send(session: LoanEnquirySession, grace: float = 10.0) -> None:
    """Force-end the call if the LLM fails to emit end_call after form send.

    Runs as a background task — idempotent against an LLM-driven end_call
    that *does* arrive (in which case session.call_ended is already True and
    this is a no-op). Never raises.
    """
    try:
        await asyncio.sleep(grace)
    except asyncio.CancelledError:
        return
    # call_ended → teardown already ran; ending → end_call is in flight and owns
    # the goodbye (it may still be awaiting its farewell say(), so call_ended is
    # not True yet). Either way this backstop must stay silent to avoid a
    # double / cut-off goodbye.
    if session.call_ended or getattr(session, "ending", False):
        return
    logger.warning(
        "Auto-end: LLM never called end_call within %.0fs of form send — "
        "speaking a farewell, then closing.",
        grace,
    )
    if not session.call_outcome:
        session.call_outcome = "interested"
    agent_session = getattr(session, "agent_session", None)
    if agent_session is not None:
        # The LLM finished the form-send turn but forgot to speak a goodbye and
        # call end_call. Cutting the line silently sounds like a dropped call, so
        # clear any hanging speech and speak a clean farewell — every successful
        # form-send now ends on a human note. (end_call ends the call itself when
        # the LLM does say goodbye, so this backstop only runs when it didn't →
        # no double-goodbye in the normal path.)
        try:
            agent_session.interrupt(force=True)
        except Exception as e:
            logger.debug(f"auto-end interrupt failed (non-fatal): {e}")
        try:
            farewell = {
                "hindi": "जी धन्यवाद! ABC Bank की ओर से आपका दिन शुभ हो।",
                "marathi": "धन्यवाद! ABC Bank तर्फे तुमचा दिवस शुभ जावो.",
                "english": "Thank you! Have a great day from ABC Bank.",
            }.get(getattr(session, "language", "hindi"), "Thank you! Have a great day.")
            await agent_session.say(farewell, allow_interruptions=False)
            await asyncio.sleep(3.0)  # let the goodbye TTS finish before teardown
        except Exception as e:
            logger.debug(f"auto-end farewell say failed (non-fatal): {e}")
        try:
            if getattr(agent_session, "input", None) is not None:
                agent_session.input.audio = None
        except Exception as e:
            logger.debug(f"auto-end mic-off failed (non-fatal): {e}")
    try:
        await session.save_and_disconnect(delay=0)
    except Exception as e:
        logger.error(f"auto-end save_and_disconnect failed: {e}")


def _farewell_text(session, reason: str) -> str:
    """Deterministic, language- + reason-aware closing line spoken by end_call so
    the customer ALWAYS hears a goodbye (the LLM sometimes drops the farewell text
    when it emits the tool call). This is the single closing line — the prompt
    tells the LLM not to speak its own goodbye."""
    lang = getattr(session, "language", "hindi") or "hindi"
    name = (getattr(session, "customer_name", "") or "").strip()
    n = f" {name}" if name else ""
    if reason in ("user_busy", "callback_requested"):
        return {
            "hindi": f"ठीक है{n} जी, मैं आपको उसी समय call कर लूँगा। धन्यवाद, आपका दिन शुभ हो।",
            "marathi": f"ठीक आहे{n}, मी तुम्हाला त्याच वेळी call करेन. धन्यवाद, तुमचा दिवस चांगला जावो.",
            "english": f"Sure{n}, I'll call you back at that time. Thank you, have a good day.",
        }.get(lang, "Thank you, have a good day.")
    if reason == "wrong_number":
        return {
            "hindi": "माफ़ कीजिए, गलती से call हो गई। आपका दिन शुभ हो।",
            "marathi": "माफ करा, चुकून call झाला. तुमचा दिवस चांगला जावो.",
            "english": "Apologies for the wrong call. Have a good day.",
        }.get(lang, "Apologies, have a good day.")
    # interested / not_interested / completed / no_response → warm generic close
    return {
        "hindi": f"धन्यवाद{n} जी, आपके समय के लिए। आपका दिन शुभ हो।",
        "marathi": f"धन्यवाद{n}, तुमच्या वेळेबद्दल. तुमचा दिवस चांगला जावो.",
        "english": f"Thank you{n} for your time. Have a good day.",
    }.get(lang, "Thank you for your time. Have a good day.")


@function_tool(
    name="end_call",
    description=(
        "End the call. This tool SPEAKS a short closing line itself, so you do NOT "
        "need to say goodbye — just call it. Do NOT speak anything before or after calling it. "
        "reason in {interested, not_interested, wrong_number, user_busy, callback_requested, no_response, completed}."
    ),
)
async def end_call(context: RunContext, reason: str) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    session.call_outcome = reason
    logger.info(f"END CALL: {reason}")

    # Claim the goodbye: end_call now speaks the closing line itself (below), and
    # that say() is awaited (up to ~10s) BEFORE save_and_disconnect flips
    # call_ended. Without this flag the _auto_end_after_form_send backstop (fires
    # 10s after form send) could wake mid-farewell — its call_ended guard would
    # still be False — force-interrupt our goodbye and speak its own → a
    # double/cut-off goodbye. Setting this the instant end_call runs makes the
    # backstop a no-op whenever the LLM did call end_call.
    session.ending = True

    # Loan-enquiry only: this fallback sends a LOAN form. end_call is shared by
    # all three agent purposes, and "interested" is a natural reason on a
    # guarantor/account call too — those must never receive a loan form.
    if (
        reason == "interested"
        and getattr(session, "agent_purpose", "loan_enquiry") == "loan_enquiry"
        and not session.form_link_sent
    ):
        try:
            # Same prefill payload as send_form_link — if the LLM jumps
            # straight to end_call("interested") without calling
            # send_form_link first, we still want the backend to create a
            # populated loan_applications row (not an empty one).
            fallback_collected = _build_collected_data(session)
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    f"{BACKEND_URL}/api/agent/send-whatsapp-form",
                    json={
                        "phone": session.phone,
                        "customer_name": session.customer_name,
                        "customer_type": session.customer_type,
                        "call_id": session.call_id,
                        "loan_type": session.loan_type or "personal",
                        "estimated_amount": session.loan_amount or 0,
                        "collected_data": fallback_collected,
                    },
                    timeout=aiohttp.ClientTimeout(total=10),
                    ssl=False,
                ) as resp:
                    # Only mark sent when WhatsApp was ACTUALLY delivered. The
                    # endpoint returns HTTP 200 even when AiSensy rejects the
                    # message (app created, nothing delivered), so trust the
                    # body's `whatsapp_sent` flag — not the status code — or the
                    # record says "sent" while the customer received nothing.
                    try:
                        fb_result = await resp.json()
                    except Exception:
                        fb_result = {}
                    if resp.status == 200 and bool(fb_result.get("whatsapp_sent")):
                        session.form_link_sent = True
                        logger.info(
                            f"WhatsApp form link sent to {session.phone} via end_call fallback "
                            f"({len(fallback_collected)} prefill fields)"
                        )
                    else:
                        logger.error(
                            f"end_call fallback WhatsApp NOT delivered "
                            f"(status={resp.status}, whatsapp_sent={fb_result.get('whatsapp_sent')}, "
                            f"reason={fb_result.get('message') or fb_result.get('status')})"
                        )
        except Exception as e:
            logger.error(f"WhatsApp send failed: {e}")

    # Deterministically SPEAK the closing line here (awaited) so the customer
    # always hears a goodbye before we tear down — even if the LLM dropped the
    # farewell text when it emitted this tool call. We await the say() we control
    # so it can't be cut off by the disconnect race.
    agent_session = getattr(session, "agent_session", None)
    if agent_session is not None and not session.call_ended:
        try:
            fut = agent_session.say(_farewell_text(session, reason), allow_interruptions=False)
            if fut is not None:
                try:
                    await asyncio.wait_for(fut, timeout=10.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
        except Exception as e:
            logger.debug(f"end_call farewell say failed (non-fatal): {e}")

    # Then silence + tear down. Grace/delay are short now because the farewell
    # above was already awaited to completion.
    asyncio.create_task(_silence_after_farewell(session, grace=1.0))
    asyncio.create_task(session.save_and_disconnect(delay=3.0))
    return "SUCCESS: User hanging up. Stop generating anything."


async def _silence_after_farewell(session: LoanEnquirySession, grace: float = 5.0) -> None:
    """Best-effort: wait for the farewell to finish, then silence the agent.

    Runs as a background task — never raises. Idempotent against
    save_and_disconnect cleanup that may already be in flight.
    """
    try:
        await asyncio.sleep(grace)
    except asyncio.CancelledError:
        return
    agent_session = getattr(session, "agent_session", None)
    if agent_session is None or session.call_ended:
        return
    # 1) Cut off any speech still being rendered or queued.
    try:
        fut = agent_session.interrupt(force=True)
        if fut is not None:
            try:
                await asyncio.wait_for(fut, timeout=1.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
    except Exception as e:
        logger.debug(f"interrupt after farewell failed (non-fatal): {e}")
    # 2) Disable mic input so customer noise can't re-trigger the LLM.
    try:
        if getattr(agent_session, "input", None) is not None:
            agent_session.input.audio = None
    except Exception as e:
        logger.debug(f"input.audio disable failed (non-fatal): {e}")
    logger.info("Agent silenced after farewell.")


@function_tool(
    name="schedule_callback",
    description=(
        "Schedule callback when customer is busy. Pass ISO 8601 IST datetime "
        "(e.g. '2026-04-30T10:00:00+05:30'). After it returns, say a short polite "
        "confirmation then call end_call('user_busy')."
    ),
)
async def schedule_callback(context: RunContext, callback_iso: str, reason: str = "user_busy") -> str:
    session: LoanEnquirySession = context.userdata["session"]
    try:
        async with aiohttp.ClientSession() as http:
            async with http.post(
                f"{BACKEND_URL}/api/agent/schedule-callback",
                json={"call_id": session.call_id, "callback_iso": callback_iso, "reason": reason},
                timeout=aiohttp.ClientTimeout(total=10),
                ssl=False,
            ) as resp:
                if resp.status == 200:
                    body = await resp.json()
                    logger.info(f"Callback scheduled: {body}")
                    return f"OK callback set for {body.get('scheduled_callback_at')}"
                txt = await resp.text()
                logger.warning(f"schedule_callback backend {resp.status}: {txt}")
                return f"Failed: {txt}"
    except Exception as e:
        logger.error(f"schedule_callback error: {e}")
        return f"Error: {e}"


@function_tool(
    name="collect_all_data",
    description=(
        "Save ALL collected customer details in ONE call. "
        "Call this exactly ONCE — right before send_form_link OR end_call. "
        "Pass only fields the customer actually answered; leave the rest as empty string. "
        "DO NOT call this mid-conversation; batch everything at the end."
    ),
)
async def collect_all_data(
    context: RunContext,
    age: str = "",
    employment_type: str = "",
    employer_name: str = "",
    qualification: str = "",
    designation: str = "",
    sector: str = "",
    working_experience: str = "",
    existing_emi: str = "",
    monthly_income: str = "",
    loan_amount: str = "",
    loan_type: str = "",
    loan_purpose: str = "",
    business_type: str = "",
    business_age: str = "",
    monthly_turnover: str = "",
    address: str = "",
    account_type: str = "",
    initial_deposit: str = "",
    is_salaried: str = "",
    individual_purpose: str = "",
) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    fields = {
        "age": age, "employment_type": employment_type, "employer_name": employer_name,
        "qualification": qualification, "designation": designation, "sector": sector,
        "working_experience": working_experience, "existing_emi": existing_emi,
        "monthly_income": monthly_income, "loan_amount": loan_amount, "loan_type": loan_type,
        "loan_purpose": loan_purpose, "business_type": business_type, "business_age": business_age,
        "monthly_turnover": monthly_turnover, "address": address,
        "account_type": account_type, "initial_deposit": initial_deposit,
        "is_salaried": is_salaried, "individual_purpose": individual_purpose,
    }
    saved = 0
    for f, v in fields.items():
        if v and v.strip():
            session.update_collected_data(f, v)
            saved += 1
    logger.info(f"collect_all_data: saved {saved} fields")

    # Plausibility backstop (Issue: age 25 + 25 yrs experience is impossible).
    # A person can't have more work experience than (age - ~18). The prompt is
    # expected to catch and re-ask this live; this is a logged safety net that
    # flags the record and returns a hint so the LLM can still correct it.
    def _num(s: str):
        try:
            return float("".join(c for c in str(s) if c.isdigit() or c == "."))
        except (ValueError, TypeError):
            return None
    a, exp = _num(age), _num(working_experience)
    if a and exp and exp > a - 15:
        logger.warning(f"Implausible age/experience: age={a}, experience={exp}")
        session.update_collected_data("data_flags", f"experience_{exp}_exceeds_age_{a}_minus_15")
        return (
            f"WARNING: work experience ({exp}) is not plausible for age ({a}) — a person "
            f"cannot have worked more than (age - 18) years. Politely point this out to the "
            f"customer and re-ask their correct work experience before proceeding."
        )
    return "ok"


@function_tool(
    name="record_guarantor_consent",
    description=(
        "Record the guarantor's consent. consent must be 'yes', 'no', or '' (unclear). "
        "Call this exactly once, as soon as the guarantor gives a clear answer."
    ),
)
async def record_guarantor_consent(
    context: RunContext,
    consent: str = "",
    note: str = "",
) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    c = (consent or "").strip().lower()
    if c in ("yes", "y", "haan", "ho", "हाँ", "हो"):
        session.guarantor_consent = "yes"
    elif c in ("no", "n", "nahi", "नहीं", "नाही"):
        session.guarantor_consent = "no"
    else:
        session.guarantor_consent = None
    session.guarantor_consent_note = note or None
    logger.info(f"record_guarantor_consent: consent={session.guarantor_consent!r} note={note!r}")
    # Best-effort immediate post (robust against call drop); transcript webhook also carries it.
    try:
        async with aiohttp.ClientSession() as http:
            await http.post(
                f"{BACKEND_URL}/api/guarantor/consent",
                json={"call_id": session.call_id, "consent": consent, "note": note},
                timeout=aiohttp.ClientTimeout(total=8),
                ssl=False,
            )
    except Exception as e:
        logger.warning(f"immediate consent post failed (non-fatal): {e}")
    return "ok"
