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


@function_tool(
    name="send_form_link",
    description="Send loan form link via WhatsApp. Call ONLY when customer is interested and agrees.",
)
async def send_form_link(context: RunContext, loan_type: str, estimated_amount: int,
                         delivery_method: str = "whatsapp") -> str:
    session: LoanEnquirySession = context.userdata["session"]
    try:
        payload = {
            "phone": session.phone,
            "customer_name": session.customer_name,
            "customer_type": session.customer_type,
            "call_id": session.call_id,
            "loan_type": loan_type,
            "estimated_amount": estimated_amount,
            "delivery_method": delivery_method,
        }
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
            return "Form link sent successfully."
        return "Failed to send form link."
    except Exception as e:
        logger.error(f"send_form_link error: {e}")
        return f"Error: {str(e)}"


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
                    },
                    timeout=aiohttp.ClientTimeout(total=10),
                    ssl=False,
                )
            session.form_link_sent = True
            logger.info(f"WhatsApp form link sent to {session.phone}")
        except Exception as e:
            logger.error(f"WhatsApp send failed: {e}")

    asyncio.create_task(session.save_and_disconnect(delay=8.0))
    return "SUCCESS: User hanging up. Stop generating anything."


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
) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    fields = {
        "age": age, "employment_type": employment_type, "employer_name": employer_name,
        "qualification": qualification, "designation": designation, "sector": sector,
        "working_experience": working_experience, "existing_emi": existing_emi,
        "monthly_income": monthly_income, "loan_amount": loan_amount, "loan_type": loan_type,
        "loan_purpose": loan_purpose, "business_type": business_type, "business_age": business_age,
        "monthly_turnover": monthly_turnover, "address": address,
    }
    saved = 0
    for f, v in fields.items():
        if v and v.strip():
            session.update_collected_data(f, v)
            saved += 1
    logger.info(f"collect_all_data: saved {saved} fields")
    return "ok"
