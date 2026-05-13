# backend/agent/analytics.py
import json
import asyncio
import logging
import uuid
from typing import Optional

from fastapi import APIRouter
from google import genai
from google.genai import types

from . import state as _state
from .state import (
    acquire_analytics_lock, release_analytics_lock,
    GEMINI_API_KEY, CATEGORY_OPTIONS, now_ist, _row_to_dict,
)

logger = logging.getLogger("agent-analytics")
router = APIRouter()


def analyze_transcript_with_llm(transcript: list) -> dict:
    """Analyze transcript using Gemini to categorize the call."""
    if not GEMINI_API_KEY or not transcript:
        return {"category": "Uncategorized", "reminder_date": None, "follow_up_needed": "No"}

    try:
        conversation_text = "\n".join(
            f"{msg.get('role', 'unknown')}: {msg.get('text', '')}" for msg in transcript
        )

        client = genai.Client(api_key=GEMINI_API_KEY)
        prompt = f"""Analyze this call transcript and categorize it.

Categories (choose one):
{chr(10).join(f'- {cat}' for cat in CATEGORY_OPTIONS)}

Also determine follow-up needs and lead quality:
- "Very Interested - Form Sent" -> follow_up_needed: "Yes", lead_quality: "hot"
- "Interested - Callback Requested" -> follow_up_needed: "Yes", lead_quality: "warm"
- "Interested - Needs Time to Decide" -> follow_up_needed: "Yes", lead_quality: "warm"
- "Not Interested" categories -> follow_up_needed: "No", lead_quality: "cold"
- "Ineligible" categories -> follow_up_needed: "No", lead_quality: "cold"
- Other -> follow_up_needed: "No", lead_quality: "cold"

Return JSON ONLY: {{"category": "chosen category", "reminder_date": "YYYY-MM-DD or null", "follow_up_needed": "Yes or No", "how_to_follow_up": "brief instructions", "when_to_follow_up": "timeframe", "lead_quality": "hot/warm/cold", "loan_type": "education/business/personal or null"}}

Transcript:
{conversation_text}"""

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(temperature=0.3),
        )

        result = response.text.strip()
        if result.startswith("```"):
            result = result.split("```")[1].replace("json", "").strip()
        parsed = json.loads(result)
        if "follow_up_needed" not in parsed:
            parsed["follow_up_needed"] = "No"
        return parsed
    except Exception as e:
        logger.error(f"LLM analysis failed: {e}")
        return {"category": "Uncategorized", "reminder_date": None, "follow_up_needed": "No"}


async def process_analytics_batch():
    """Sweep cron: enqueue transcript_analyze jobs for any call that completed
    with a transcript but is still 'Uncategorized'.

    The actual Gemini call is no longer made here — that work runs on the M3
    job worker pool (see services/job_worker.py + services/job_handlers.py),
    so a slow LLM cannot block this cron tick anymore.

    This function is now a safety-net producer: the transcript webhook enqueues
    jobs at call-completion time, so most analyses happen seconds after the
    call ends. This cron catches anything that slipped through (e.g. webhook
    delivery failure, agent crash before transcript POST).
    """
    if not await acquire_analytics_lock():
        return

    try:
        # Import the producer lazily to avoid circular import (services depends
        # on backend.agent at handler invocation time).
        from services.job_worker import enqueue_job

        rows = await _state.db_pool.fetch(
            """SELECT id FROM agent_calls
               WHERE COALESCE(category, 'Uncategorized') IN ('Uncategorized', '')
                 AND transcript IS NOT NULL AND transcript != '[]'::jsonb
                 AND status IN ('Called', 'Completed', 'Called - Interested', 'Called - Not Interested')
                 AND NOT EXISTS (
                     -- Avoid re-enqueueing if a pending/running/failed job already exists
                     SELECT 1 FROM call_processing_jobs j
                     WHERE j.job_type = 'transcript_analyze'
                       AND j.status IN ('pending', 'running', 'failed')
                       AND (j.payload->>'call_id') = agent_calls.id::text
                 )
               ORDER BY created_at ASC
               LIMIT 50"""
        )

        if not rows:
            return

        for row in rows:
            try:
                await enqueue_job(
                    _state.db_pool,
                    job_type="transcript_analyze",
                    payload={"call_id": str(row["id"])},
                )
                logger.info("Analytics sweep: enqueued transcript_analyze for call %s", row["id"])
            except Exception as e:
                logger.error("Failed to enqueue analytics job for %s: %s", row["id"], e)
    finally:
        await release_analytics_lock()
