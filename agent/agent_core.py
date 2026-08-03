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
from livekit.agents.tts import FallbackAdapter as TTSFallbackAdapter
from google.genai import types as genai_types

try:
    from livekit.agents import BackgroundAudioPlayer, AudioConfig, BuiltinAudioClip
    _BACKGROUND_AUDIO_AVAILABLE = True
except ImportError:
    _BACKGROUND_AUDIO_AVAILABLE = False

# Semantic end-of-utterance model (multilingual, Hindi supported). VAD alone
# treats any pause as end-of-turn — on a real QA call the agent barged in on
# "नहीं नहीं नहीं मुझे" (customer mid-sentence; EOU prob 0.2% per the model)
# and closed the call. With the model, incomplete sentences hold the turn
# (waits up to max_endpointing_delay) while complete ones stay fast at
# min_endpointing_delay. Inference ~20ms in the worker's inference process.
# Graceful fallback: without the plugin/model files, behaviour is unchanged.
try:
    from livekit.plugins.turn_detector.multilingual import MultilingualModel
    _TURN_DETECTOR_AVAILABLE = True
except ImportError:
    _TURN_DETECTOR_AVAILABLE = False

from config import IST, BACKEND_URL, LANG_CONFIG, GENDER_CONFIG
from session import LoanEnquirySession, CustomerType
from tools import send_form_link, end_call, schedule_callback, collect_all_data, record_guarantor_consent
from prompts import build_loan_enquiry_instructions
from prompts_account import build_account_opening_instructions
from prompts_guarantor import build_guarantor_consent_instructions

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
# NOTE: inside TTSFallbackAdapter this is bypassed — the adapter passes its own
# conn options (10 s timeout, no inner retries) so a dead Sarvam fails over to
# Gemini TTS fast instead of stalling 30 s. _SARVAM_CONN still applies to any
# direct _SarvamTTS use outside the adapter.
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
                session.call_ended = True
                await session._send_transcript()
                # Without this the finally-block below waits forever on an
                # event nobody will set — every unanswered call (the most
                # common outbound outcome) parked its job until LiveKit
                # force-killed it.
                session.shutdown_event.set()
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
                        # Primary = full gemini-2.5-flash (billing/paid tier
                        # enabled). Chosen for conversation + tool-call quality.
                        # The old lag was FREE-TIER throttling — slow throughput
                        # (5 tok/s) + streaming "finish_reason: None" empties;
                        # billing removes that. 2.5-flash can still return an
                        # occasional 503 "high demand", but that's an INSTANT
                        # error (not a hang), so the FallbackAdapter switches to
                        # Groq in ~1s — no dead air. Groq stays the fallback.
                        model="gemini-2.5-flash",
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
            # TTS fallback chain: Sarvam bulbul (primary) → Gemini TTS (backup).
            # Sarvam's streaming WS intermittently drops mid-call ("Cannot write to
            # closing transport") and its own 3 retries all hit the same dead
            # service — the utterance was dropped and the agent went SILENT.
            # FallbackAdapter tries Sarvam max twice with no inner retries
            # (max_retry=0, 10s timeout per attempt), then switches to Gemini TTS
            # (uses the existing GOOGLE_API_KEY; non-streaming, auto-wrapped in a
            # StreamAdapter; 22050→24000 resampling is handled by the adapter).
            # Tradeoff: during a Sarvam outage a sentence or two plays in the
            # Gemini voice — always better than dead air on a live loan call.
            tts=TTSFallbackAdapter(
                [
                    _SarvamTTS(
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
                    google.beta.GeminiTTS(
                        model="gemini-2.5-flash-preview-tts",
                        # Gender-matched fallback so a mid-call Sarvam drop doesn't
                        # flip the perceived voice: "Kore" is female, "Charon" is a
                        # professional male voice. Without this, every male call fell
                        # back to a female voice during a Sarvam WS hiccup.
                        voice_name="Kore" if session.gender == "female" else "Charon",
                    ),
                ]
            ),
            vad=vad,
            # Semantic turn detection (see import note above); "vad" = the
            # exact pre-turn-detector behaviour if the plugin/model is absent.
            turn_detection=MultilingualModel() if _TURN_DETECTOR_AVAILABLE else "vad",
            preemptive_generation=True,
            min_endpointing_delay=0.13,
            max_endpointing_delay=2.5,
            min_interruption_duration=0.35,
            # Noise defense for phone calls. min_interruption_words=0 (default)
            # meant raw VAD energy — traffic, TV, crowd noise — paused the agent,
            # then resume_false_interruption waited 2s before resuming: customers
            # heard the voice "breaking" in noisy places. Requiring 1 transcribed
            # word means non-speech noise never pauses the agent at all, while a
            # real barge-in ("हाँ", "रुको") still interrupts instantly.
            min_interruption_words=1,
            # If a false interruption still slips through, resume after 1s of
            # user silence instead of the 2s default — halves the dead air.
            false_interruption_timeout=1.0,
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
        if agent_purpose == "guarantor_consent":
            instructions = build_guarantor_consent_instructions(session)
            agent_tools = [record_guarantor_consent, end_call]
        elif agent_purpose == "account_opening":
            instructions = build_account_opening_instructions(
                customer_name=session.customer_name,
                phone=session.phone,
                language=session.language,
                gender=session.gender,
                agent_name=session.agent_name,
            )
            agent_tools = [send_form_link, end_call, schedule_callback, collect_all_data]
        else:
            instructions = build_loan_enquiry_instructions(session)
            agent_tools = [send_form_link, end_call, schedule_callback, collect_all_data]

        await agent_session.start(
            room=ctx.room,
            agent=Agent(instructions=instructions, tools=agent_tools),
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
            # Two-stage silence handling:
            #   Stage 1 (after ~12s dead air): gently nudge — "are you still there?"
            #   Stage 2 (another ~13s of silence): say "looks like you're busy,
            #            I'll call you later" and hang up.
            # agent_busy guards against counting the agent's own thinking/speaking
            # as customer silence. last_speech_time is refreshed on every agent
            # state change, so a customer reply (which triggers the agent) resets it.
            NUDGE_AFTER = 12.0
            HANGUP_AFTER = 13.0   # additional silence after the nudge
            nudged = False
            while not session.call_ended:
                await asyncio.sleep(3)
                if session.call_ended:
                    break
                if getattr(session, "agent_busy", False):
                    continue
                gap = asyncio.get_event_loop().time() - session.last_speech_time
                if not nudged:
                    if gap > NUDGE_AFTER and session.agent_session:
                        nudge = {
                            "hindi": f"Hello {session.customer_name} जी, क्या आप अभी भी line पर हैं?",
                            "marathi": f"Hello {session.customer_name}, तुम्ही अजून line वर आहात का?",
                            "english": f"Hello {session.customer_name}, are you still there?",
                        }.get(session.language, "Hello, are you still there?")
                        logger.info("Silence >%.0fs — nudging customer.", NUDGE_AFTER)
                        try:
                            await session.agent_session.say(nudge, allow_interruptions=True)
                        except Exception as e:
                            logger.debug(f"silence nudge failed (non-fatal): {e}")
                        nudged = True
                        session.last_speech_time = asyncio.get_event_loop().time()
                else:
                    if gap <= NUDGE_AFTER:
                        # Customer resumed — their turn refreshed last_speech_time.
                        nudged = False
                    elif gap > HANGUP_AFTER:
                        logger.warning("Still silent after nudge — closing politely.")
                        if session.agent_session:
                            try:
                                farewell = {
                                    "hindi": "लगता है आप अभी busy हैं। कोई बात नहीं, मैं आपको बाद में call कर लूँगा जब आप free हों। धन्यवाद।",
                                    "marathi": "तुम्ही busy आहात असं वाटतंय. काही हरकत नाही, मी तुम्हाला नंतर call करेन जेव्हा तुम्ही free असाल. धन्यवाद.",
                                    "english": "It looks like you're busy right now. No problem, I'll call you back later when you're free. Thank you.",
                                }.get(session.language, "It looks like you're busy, I'll call you back later. Thank you.")
                                await session.agent_session.say(farewell, allow_interruptions=False)
                                await asyncio.sleep(2.0)
                            except Exception as e:
                                logger.error(f"Error speaking silence farewell: {e}")
                            session.call_outcome = "no_response"
                            await session.save_and_disconnect(delay=0)
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
        if session:
            session.shutdown_event.set()
        # Job cancellation (worker shutdown/drain) must propagate — swallowing
        # it here left jobs "stuck draining" during deploys.
        if isinstance(e, asyncio.CancelledError):
            raise

    finally:
        if session:
            logger.info("Waiting for call to finish (shutdown_event)...")
            try:
                # ⚠️ This wait is the CALL'S LIFETIME ANCHOR, not a post-teardown
                # flush: the entrypoint reaches this finally right after setup,
                # and returning from it ends the LiveKit job (agent leaves the
                # room). It must block for the entire live conversation until
                # save_and_disconnect completes and sets shutdown_event.
                # A 60s bound here force-killed every call at the 60s mark.
                # 600s is a pure backstop: safety_timeout force-ends any call at
                # 360s and worst-case teardown (transcript retries + egress) is
                # ~60s more, so a healthy call ALWAYS finishes well under this.
                await asyncio.wait_for(session.shutdown_event.wait(), timeout=600)
                logger.info("Agent shutdown complete")
            except asyncio.TimeoutError:
                logger.error("Shutdown wait timed out after 600s — exiting anyway")
            except Exception as e:
                logger.error(f"Error waiting for shutdown: {e}")
