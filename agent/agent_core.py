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
from livekit.agents import JobContext, function_tool, RunContext, APIConnectOptions
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


# ---------------------------------------------------------------------------
# Sentry / GlitchTip — capture agent exceptions + ERROR logs.
# No-op unless SENTRY_DSN_AGENT is set (so dev/local runs stay clean). The
# module-level init runs in every worker/job process LiveKit spawns, so both
# the main worker and per-call job processes report errors.
# ---------------------------------------------------------------------------
_SENTRY_DSN_AGENT = os.getenv("SENTRY_DSN_AGENT", "").strip()
if _SENTRY_DSN_AGENT:
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=_SENTRY_DSN_AGENT,
            environment=os.getenv("LOS_ENV", "production"),
            traces_sample_rate=0.0,
            send_default_pii=False,
        )
        logger.info(
            "Sentry initialized for agent (env=%s)",
            os.getenv("LOS_ENV", "production"),
        )
    except ImportError:
        logger.warning("SENTRY_DSN_AGENT set but sentry-sdk not installed")
    except Exception as _sentry_exc:  # never let telemetry break the agent
        logger.error("Agent Sentry init failed: %s", _sentry_exc)


# ---------------------------------------------------------------------------
# Sarvam TTS with extended WebSocket receive timeout
# ---------------------------------------------------------------------------
# The default APIConnectOptions.timeout is 10 s.  For mixed Hindi/English
# greeting text on first connection the Sarvam API occasionally takes >10 s
# to return the first audio chunk, causing:
#   "WebSocket receive timeout" → retry → 5-6 s silence at call start
#   "_SegmentSynchronizerImpl.resume called after close" warning cascade
# Bumping to 30 s eliminates these without changing any other behaviour.
_SARVAM_CONN = APIConnectOptions(timeout=30.0, max_retry=3, retry_interval=2.0)


class _SarvamTTS(sarvam.TTS):
    """Drop-in wrapper that injects a 30-second receive timeout."""

    def stream(self, *, conn_options=None):
        return super().stream(conn_options=conn_options or _SARVAM_CONN)

    def synthesize(self, text, *, conn_options=None):
        return super().synthesize(text, conn_options=conn_options or _SARVAM_CONN)

# Wire agent → /api/internal/errors webhook (idempotent — silently no-ops if
# LOS_BACKEND_URL / LOS_INTERNAL_HMAC_SECRET aren't set in .env.local).
# Lifts every logger.error / uncaught exception into /ops/errors.
try:
    from los_error_reporter import install as _install_los_reporter
    _install_los_reporter()
except Exception as _e:
    logger.warning(f"LOS error reporter not installed: {_e}")


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
                logger.info("Customer hung up - silencing agent and saving transcript...")
                # Cut off any in-flight LLM generation / TTS speech so we don't
                # cascade into "Gemini finish_reason: None" or stray audio after
                # the customer has already left the room.
                try:
                    if session.agent_session is not None:
                        session.agent_session.interrupt(force=True)
                        if getattr(session.agent_session, "input", None) is not None:
                            session.agent_session.input.audio = None
                except Exception as e:
                    logger.debug(f"silence on customer-disconnect failed (non-fatal): {e}")
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
                        # flash-lite = Google's low-latency variant. Measured on
                        # this key: ~0.8s TTFT and 8/8 clean responses, vs full
                        # 2.5-flash at ~1.4s with intermittent 503 "overloaded"
                        # + streaming "finish_reason: None" empties — those empties
                        # stalled turns (agent went silent) and forced a mid-call
                        # Groq fallback, which is the lag/"agent kuch bola nahi"
                        # users saw. Lighter model = higher free-tier throughput
                        # + fewer throttles. Groq stays as the instant fallback.
                        model="gemini-2.5-flash-lite",
                        temperature=0.4,
                        # Disable Gemini 2.5 "thinking": it spends seconds on
                        # internal reasoning tokens BEFORE the first response
                        # token, which is fatal for a real-time voice agent
                        # (turns the ~1s TTFT into 3-6s). thinking_budget=0 = off.
                        thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                        # 10s per-request ceiling (was 30s): if Gemini ever hangs
                        # producing no tokens, abort fast and fall to Groq instead
                        # of leaving the customer in 30s of dead air.
                        http_options=genai_types.HttpOptions(timeout=10000),
                    ),
                    groq.LLM(model="llama-3.3-70b-versatile", temperature=0.4),
                    groq.LLM(model="llama-3.1-8b-instant", temperature=0.4),
                ]
            ),
            tts=_SarvamTTS(
                model="bulbul:v3",
                target_language_code=session.tts_language_code,
                speaker=session.tts_speaker,
                # pace=1.18 — ~15% faster than the Bulbul default. At 1.06 the Hindi
                # voice felt sluggish on phone calls (customers were interrupting mid-
                # sentence because each utterance took 8-10 sec to play). 1.18 stays
                # natural-sounding while delivering content noticeably quicker. Sarvam
                # docs accept 0.5-2.0; 1.20+ starts sounding rushed.
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

        # ── Latency instrumentation — logs per-turn EOU delay, LLM TTFT, and
        # TTS TTFB so we can see exactly which stage costs what. Logging only,
        # zero behavioral impact. View: journalctl -u los-agent-* | grep METRIC
        from livekit.agents import metrics as _lk_metrics

        @agent_session.on("metrics_collected")
        def _on_metrics_collected(ev):
            try:
                _lk_metrics.log_metrics(ev.metrics)
            except Exception:
                pass

        # Track agent activity so the silence-monitor never counts the agent's
        # OWN thinking/speaking time as "customer silence" (that caused false
        # "you seem busy" hang-ups during long agent turns). Resets the silence
        # clock on every agent state change. Guarded so an unknown event name
        # can never break the call.
        session.agent_busy = False
        try:
            @agent_session.on("agent_state_changed")
            def _on_agent_state(ev):
                st = getattr(ev, "new_state", None) or getattr(ev, "state", None)
                session.agent_busy = st in ("thinking", "speaking")
                session.last_speech_time = asyncio.get_event_loop().time()
        except Exception:
            pass

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

            # Tightened greeting: identity + disclaimer fused into one short sentence.
            # The verbose "security and quality purposes" phrasing added 3-4 seconds
            # of audio with no business value; customers were hanging up before the
            # ID check question even started.
            if session.language == "english":
                part1 = f"Hello, this is {session.agent_name} from {session.bank_name}. This call is recorded for quality."
                part2 = f"Am I speaking with {session.customer_name}?"
            elif session.language == "marathi":
                bolte = "बोलतेय" if session.gender == "female" else "बोलतोय"
                part1 = f"नमस्कार, मी {session.agent_name}, {session.bank_name} मधून {bolte}. ही call quality साठी record होत आहे."
                part2 = f"मी {session.customer_name} जींशी बोलतोय का?"
            else:
                bol = "रही" if session.gender == "female" else "रहा"
                part1 = f"Hello, मैं {session.agent_name} {session.bank_name} से बोल {bol} हूँ। यह call quality के लिए record हो रही है।"
                part2 = f"क्या मेरी बात {session.customer_name} जी से हो रही है?"

            handle1 = agent_session.say(part1, allow_interruptions=False, add_to_chat_ctx=True)
            await handle1
            await asyncio.sleep(0.2)
            handle2 = agent_session.say(part2, allow_interruptions=True, add_to_chat_ctx=True)
            await handle2
        except Exception as e:
            logger.warning(f"Greeting failed: {e}")

        async def silence_monitor():
            while not session.call_ended:
                await asyncio.sleep(3)
                gap = asyncio.get_event_loop().time() - session.last_speech_time
                if gap > 25 and not session.call_ended and not getattr(session, "agent_busy", False):
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
