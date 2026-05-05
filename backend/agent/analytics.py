# backend/agent/analytics.py
import json
import asyncio
import logging
import uuid
from typing import Optional

from fastapi import APIRouter
from google import genai
from google.genai import types

from .state import (
    db_pool, acquire_analytics_lock, release_analytics_lock,
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
    """Background LLM analysis of completed call transcripts.
    Picks up calls that have a transcript but were left as 'Uncategorized' by the
    immediate transcript handler. Merges the LLM result into call_analysis (preserves
    fields the agent already set, e.g. lead_quality from the agent's own assessment)."""
    if not await acquire_analytics_lock():
        return

    try:
        rows = await db_pool.fetch(
            """SELECT * FROM agent_calls
               WHERE COALESCE(category, 'Uncategorized') IN ('Uncategorized', '')
                 AND transcript IS NOT NULL AND transcript != '[]'::jsonb
                 AND status IN ('Called', 'Completed', 'Called - Interested', 'Called - Not Interested')
               ORDER BY created_at ASC
               LIMIT 20"""
        )

        if not rows:
            return

        for row in rows:
            call = _row_to_dict(row)
            try:
                transcript = call.get("transcript", [])
                if isinstance(transcript, str):
                    transcript = json.loads(transcript)
                analysis = await asyncio.to_thread(analyze_transcript_with_llm, transcript)

                existing = call.get("call_analysis") or {}
                if isinstance(existing, str):
                    try: existing = json.loads(existing)
                    except: existing = {}
                merged = dict(existing) if isinstance(existing, dict) else {}
                # Don't clobber agent-set lead_quality with a None from the LLM
                for k, v in {
                    "follow_up_needed": analysis.get("follow_up_needed", "No"),
                    "reminder_date": analysis.get("reminder_date"),
                    "how_to_follow_up": analysis.get("how_to_follow_up"),
                    "when_to_follow_up": analysis.get("when_to_follow_up"),
                    "lead_quality": analysis.get("lead_quality") or merged.get("lead_quality"),
                    "summary": f"Category: {analysis.get('category')} | Follow-up: {analysis.get('follow_up_needed')}",
                }.items():
                    if v is not None:
                        merged[k] = v

                await db_pool.execute(
                    """UPDATE agent_calls
                       SET category = $1,
                           call_analysis = $2::jsonb,
                           updated_at = $3
                       WHERE id = $4""",
                    analysis.get("category", "Uncategorized"),
                    json.dumps(merged),
                    now_ist(),
                    uuid.UUID(call["id"]),
                )
                logger.info(f"Analytics done for call {call['id']}: {analysis.get('category')}")
            except Exception as e:
                logger.error(f"Analytics failed for {call['id']}: {e}")
    finally:
        await release_analytics_lock()
