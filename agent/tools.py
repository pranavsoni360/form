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

        if backend_ok:
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
        return "Failed to send form link."
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
    if session.call_ended:
        return
    logger.warning(
        "Auto-end: LLM never called end_call within %.0fs of form send — closing call silently.",
        grace,
    )
    if not session.call_outcome:
        session.call_outcome = "interested"
    agent_session = getattr(session, "agent_session", None)
    if agent_session is not None:
        try:
            agent_session.interrupt(force=True)
        except Exception as e:
            logger.debug(f"auto-end interrupt failed (non-fatal): {e}")
        try:
            if getattr(agent_session, "input", None) is not None:
                agent_session.input.audio = None
        except Exception as e:
            logger.debug(f"auto-end mic-off failed (non-fatal): {e}")
    try:
        await session.save_and_disconnect(delay=0)
    except Exception as e:
        logger.error(f"auto-end save_and_disconnect failed: {e}")


@function_tool(
    name="end_call",
    description=(
        "End the call AFTER speaking goodbye. "
        "reason in {interested, not_interested, wrong_number, user_busy, callback_requested, no_response, completed}. "
        "DO NOT speak anything after calling this tool."
    ),
)
async def end_call(context: RunContext, reason: str) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    session.call_outcome = reason
    logger.info(f"END CALL: {reason}")

    if reason == "interested" and not session.form_link_sent:
        try:
            # Same prefill payload as send_form_link — if the LLM jumps
            # straight to end_call("interested") without calling
            # send_form_link first, we still want the backend to create a
            # populated loan_applications row (not an empty one).
            fallback_collected = _build_collected_data(session)
            async with aiohttp.ClientSession() as http:
                await http.post(
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
                )
            session.form_link_sent = True
            logger.info(
                f"WhatsApp form link sent to {session.phone} via end_call fallback "
                f"({len(fallback_collected)} prefill fields)"
            )
        except Exception as e:
            logger.error(f"WhatsApp send failed: {e}")

    # Guarantee silence after the farewell. The LLM emits farewell text + this
    # tool call in the same response stream, so by the time we get here, the
    # TTS for the farewell has already started rendering. We:
    #   1. Wait a short grace period (~5s) for the farewell audio to finish.
    #   2. Force-interrupt anything still pending (kills any tail speech the
    #      LLM might emit after the tool result).
    #   3. Disable the mic input so customer noise can't re-trigger the LLM
    #      during the remaining ~3s before save_and_disconnect tears down.
    # Net effect: customer hears the goodbye and then complete silence until
    # the room is closed — no robotic word salad, no Gemini cancel-mid-stream
    # errors leaking into the logs.
    asyncio.create_task(_silence_after_farewell(session, grace=5.0))
    asyncio.create_task(session.save_and_disconnect(delay=8.0))
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
    }
    saved = 0
    for f, v in fields.items():
        if v and v.strip():
            session.update_collected_data(f, v)
            saved += 1
    logger.info(f"collect_all_data: saved {saved} fields")
    return "ok"
