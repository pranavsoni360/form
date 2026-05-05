# -*- coding: utf-8 -*-
"""
Loan Enquiry Agent — core logic.
Contains LoanEnquiryAgent (Agent subclass) and entrypoint().
Extracted from los_updated.py; no logic changes.
"""

import os
import json
import logging
import asyncio

from livekit import rtc
from livekit.agents import JobContext, function_tool, RunContext
from livekit.agents.voice import AgentSession, Agent
from livekit.plugins import deepgram, silero, sarvam, google, groq
from livekit.agents.llm import FallbackAdapter
from google.genai import types as genai_types

try:
    from livekit.agents import BackgroundAudioPlayer, AudioConfig, BuiltinAudioClip
    _BACKGROUND_AUDIO_AVAILABLE = True
except ImportError:
    _BACKGROUND_AUDIO_AVAILABLE = False

from config import IST, BACKEND_URL, LANG_CONFIG, GENDER_CONFIG
from session import LoanEnquirySession, CustomerType
from tools import send_form_link, end_call, schedule_callback, collect_all_data
from prompts import build_loan_enquiry_instructions
from prompts_account import build_account_opening_instructions

logger = logging.getLogger("loan-enquiry-agent")


# ===================================================================
# AGENT
# ===================================================================

class LoanEnquiryAgent(Agent):
    def __init__(self, session: LoanEnquirySession):
        super().__init__(
            instructions=build_loan_enquiry_instructions(session),
            tools=[send_form_link, end_call, schedule_callback, collect_all_data],
        )


# ===================================================================
# ENTRYPOINT
# ===================================================================

async def entrypoint(ctx: JobContext):
    logger.info("Loan Enquiry Agent starting")
    session = None

    try:
        await ctx.connect()
        logger.info(f"Connected: {ctx.room.name}")

        metadata = {}
        if ctx.room.metadata:
            try:
                metadata = json.loads(ctx.room.metadata)
                logger.info(f"Room Metadata: {metadata}")
            except Exception as e:
                logger.warning(f"Room metadata parse error: {e}")
        if not metadata and ctx.job.metadata:
            try:
                metadata = json.loads(ctx.job.metadata)
                logger.info(f"Job Metadata: {metadata}")
            except:
                pass

        session = LoanEnquirySession(ctx, metadata)

        async def _flush_transcript_on_shutdown():
            try:
                await session._send_transcript()
            except Exception as e:
                logger.error(f"Shutdown-callback transcript flush failed: {e}")

        ctx.add_shutdown_callback(_flush_transcript_on_shutdown)

        async def wait_for_participant(timeout: float = 60.0):
            deadline = asyncio.get_event_loop().time() + timeout
            while len(ctx.room.remote_participants) == 0:
                if asyncio.get_event_loop().time() > deadline:
                    raise TimeoutError("No participant joined")
                await asyncio.sleep(0.05)
            return list(ctx.room.remote_participants.values())[0]

        try:
            participant = await wait_for_participant()
            logger.info(f"Customer answered: {participant.identity}")
        except TimeoutError:
            logger.error("No participant, exiting")
            if session:
                await session._send_transcript()
            return

        @ctx.room.on("participant_disconnected")
        def on_participant_disconnect(participant_info):
            logger.info(f"Participant disconnected: {participant_info.identity}")
            if session is not None and not session.call_ended:
                logger.info("Customer hung up - saving transcript...")
                asyncio.create_task(session.save_and_disconnect(delay=0))

        await asyncio.sleep(0.2)

        # VAD — slightly higher threshold to avoid false trips on phone noise/breathing
        # which would otherwise interrupt the agent mid-sentence and feel like "pauses".
        vad = silero.VAD.load(
            min_speech_duration=0.20,
            min_silence_duration=0.03,
            activation_threshold=0.50,
        )

        logger.info(
            f"Config: STT={session.stt_language} | TTS={session.tts_language_code} | Speaker={session.tts_speaker}"
        )

        agent_session = AgentSession(
            stt=deepgram.STT(
                model="nova-3",
                language=session.stt_language,
                detect_language=False,
                interim_results=True,
            ),
            # Fallback chain: Gemini → Groq (llama-3.3) → Groq (llama-3.1)
            # When Gemini returns 503 (overloaded), agent auto-switches
            # to Groq so the call doesn't stall.
            llm=FallbackAdapter(
                [
                    google.LLM(
                        model="gemini-2.5-flash",
                        temperature=0.4,
                        http_options=genai_types.HttpOptions(timeout=30000),
                    ),
                    groq.LLM(model="llama-3.3-70b-versatile", temperature=0.4),
                    groq.LLM(model="llama-3.1-8b-instant", temperature=0.4),
                ]
            ),
            tts=sarvam.TTS(
                model="bulbul:v3",
                target_language_code=session.tts_language_code,
                speaker=session.tts_speaker,
                pace=1.06,
                speech_sample_rate=22050,
                enable_preprocessing=True,
            ),
            vad=vad,
            preemptive_generation=True,
            min_endpointing_delay=0.13,
            max_endpointing_delay=2.5,
            min_interruption_duration=0.35,
            discard_audio_if_uninterruptible=True,
            userdata={"session": session},
        )

        @agent_session.on("user_input_transcribed")
        def on_user_transcript(event):
            try:
                if not event.is_final:
                    return
                text = event.transcript.strip()
                if not text:
                    return
                session.add_user_message(text)
            except Exception as e:
                logger.error(f"Transcript capture error: {e}")

        @agent_session.on("conversation_item_added")
        def on_agent_speech(event):
            try:
                item = event.item
                if not item or item.role != "assistant":
                    return
                text_parts = []
                for part in item.content:
                    if isinstance(part, dict):
                        if part.get("type") in ("output_text", "text"):
                            text_parts.append(part.get("text", ""))
                    elif isinstance(part, str):
                        text_parts.append(part)
                final_text = " ".join(text_parts).strip()
                if not final_text:
                    return
                session.add_agent_message(final_text)
            except Exception as e:
                logger.error(f"Agent speech capture error: {e}")

        session.agent_session = agent_session

        agent_purpose = metadata.get("agent_purpose", "loan_enquiry")
        if agent_purpose == "account_opening":
            instructions = build_account_opening_instructions(
                customer_name=session.customer_name,
                phone=session.phone,
                language=session.language,
                gender=session.gender,
                agent_name=session.agent_name,
            )
        else:
            instructions = build_loan_enquiry_instructions(session)

        await agent_session.start(
            room=ctx.room,
            agent=Agent(
                instructions=instructions,
                tools=[send_form_link, end_call, schedule_callback, collect_all_data],
            ),
        )
        logger.info("Session started with production settings")

        asyncio.create_task(session.start_recording())

        bg_audio = None
        if _BACKGROUND_AUDIO_AVAILABLE:
            try:
                bg_audio = BackgroundAudioPlayer(
                    ambient_sound=AudioConfig(BuiltinAudioClip.OFFICE_AMBIENCE, volume=0.15),
                )
                await bg_audio.start(room=ctx.room, agent_session=agent_session)
                logger.info("Office ambience started")
            except Exception as e:
                logger.warning(f"Background audio failed: {e}")
                bg_audio = None
        session.bg_audio = bg_audio

        try:
            logger.info("Triggering hardcoded split greeting")

            if session.language == "english":
                part1 = f"Hello, this is {session.agent_name} calling from {session.bank_name}. This call is being recorded for security and quality purposes."
                part2 = f"Am I speaking with {session.customer_name}?"
            elif session.language == "marathi":
                bolte = "बोलतेय" if session.gender == "female" else "बोलतोय"
                part1 = f"नमस्कार, मी {session.agent_name}, {session.bank_name} मधून {bolte}. ही कॉल सुरक्षेसाठी रेकॉर्ड केली जात आहे."
                part2 = f"मी {session.customer_name} जींशी बोलतोय का?"
            else:
                bol = "रही" if session.gender == "female" else "रहा"
                part1 = f"Hello, मैं {session.agent_name} बोल {bol} हूँ {session.bank_name} से। यह कॉल सुरक्षा के लिए रिकॉर्ड की जा रही है।"
                part2 = f"क्या मेरी बात {session.customer_name} जी से हो रही है?"

            handle1 = agent_session.say(part1, allow_interruptions=False, add_to_chat_ctx=False)
            await handle1
            await asyncio.sleep(0.2)
            handle2 = agent_session.say(part2, allow_interruptions=True, add_to_chat_ctx=False)
            await handle2
        except Exception as e:
            logger.warning(f"Greeting failed: {e}")

        async def silence_monitor():
            while not session.call_ended:
                await asyncio.sleep(3)
                gap = asyncio.get_event_loop().time() - session.last_speech_time
                if gap > 20 and not session.call_ended:
                    logger.warning("Over 25s silence — hanging up.")
                    if session.agent_session:
                        try:
                            farewell = {
                                "hindi": "लगता है आप अभी व्यस्त हैं, धन्यवाद।",
                                "marathi": "तुम्ही व्यस्त आहात असे वाटते, धन्यवाद.",
                                "english": "It seems you are busy right now, thank you.",
                            }.get(session.language, "Thank you!")
                            await session.agent_session.say(farewell)
                            await asyncio.sleep(3.0)
                            session.call_outcome = "silence_timeout"
                            await session.save_and_disconnect(delay=0)
                        except Exception as e:
                            logger.error(f"Error triggering silence end_call: {e}")
                            session.call_outcome = "silence_timeout"
                            await session.save_and_disconnect(delay=3.0)
                    break

        session.silence_monitor_task = asyncio.create_task(silence_monitor())

        async def safety_timeout():
            await asyncio.sleep(360)
            if not session.call_ended:
                logger.warning("SAFETY TIMEOUT: 360s exceeded — force-ending stuck call")
                session.call_outcome = "safety_timeout"
                await session.save_and_disconnect(delay=0)

        session.safety_timeout_task = asyncio.create_task(safety_timeout())

    except Exception as e:
        logger.error(f"CRITICAL ERROR in entrypoint: {e}", exc_info=True)
        if session and not session.call_ended:
            try:
                await session.save_and_disconnect(delay=0)
            except Exception as e2:
                logger.error(f"Save after error also failed: {e2}")
    except BaseException as e:
        logger.error(f"AGENT CRASH (BaseException): {type(e).__name__}: {e}")
        if session and not session.call_ended:
            try:
                session.call_ended = True
                await session._send_transcript()
            except Exception as e2:
                logger.error(f"Emergency save failed: {e2}")

    finally:
        if session:
            logger.info("Waiting for transcript save to complete...")
            try:
                await session.shutdown_event.wait()
                logger.info("Agent shutdown complete")
            except Exception as e:
                logger.error(f"Error waiting for shutdown: {e}")
