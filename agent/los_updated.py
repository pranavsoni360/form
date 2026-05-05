# -*- coding: utf-8 -*-
"""
Loan Enquiry Agent - Pusad Urban Bank
=========================================
LATENCY-OPTIMIZED build:
  - Compressed system prompt (no giant rule walls)
  - Batched data collection (collect_all_data once at end, no inline tool round-trips)
  - Tight endpointing + preemptive generation
  - Idempotent transcript flush via shutdown callback
Author: Tanvi Shrivastava - Vaani Team
"""

import os
import json
import logging
import asyncio
import aiohttp
from datetime import datetime, timedelta
import pytz
from dotenv import load_dotenv

from livekit import agents, rtc
from livekit.agents import JobContext, WorkerOptions, cli, function_tool, RunContext
from livekit.agents.voice import AgentSession, Agent
from livekit.plugins import deepgram, silero, sarvam, google, groq
from livekit.agents.llm import FallbackAdapter
from livekit.api import DeleteRoomRequest, LiveKitAPI
from livekit.protocol.egress import RoomCompositeEgressRequest, EncodedFileOutput

try:
    from livekit.agents import BackgroundAudioPlayer, AudioConfig, BuiltinAudioClip
    _BACKGROUND_AUDIO_AVAILABLE = True
except ImportError:
    _BACKGROUND_AUDIO_AVAILABLE = False

load_dotenv(".env.local")

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s")
logger = logging.getLogger("loan-enquiry-agent")

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8002")
if "localhost" in BACKEND_URL:
    import warnings
    warnings.warn(
        f"BACKEND_URL={BACKEND_URL} — set correct server URL in .env.local or transcripts will fail.",
        stacklevel=1,
    )
IST = pytz.timezone("Asia/Kolkata")

LANG_CONFIG = {
    "hindi":   {"stt_lang": "hi", "tts_lang": "hi-IN"},
    "marathi": {"stt_lang": "hi", "tts_lang": "mr-IN"},
    "english": {"stt_lang": "en", "tts_lang": "en-IN"},
}

GENDER_CONFIG = {
    "male":   {"speaker": "shubh", "name": "Amit"},
    "female": {"speaker": "pooja", "name": "Priya"},
}


def now_ist() -> str:
    return datetime.now(IST).strftime("%b %d, %Y %I:%M %p")


def normalize_mobile(mobile: str) -> str:
    mobile = mobile.strip()
    if mobile.startswith("+91"): return mobile[3:]
    if mobile.startswith("91") and len(mobile) == 12: return mobile[2:]
    return mobile


class CustomerType:
    EXISTING = "existing"
    NEW = "new"


# ===================================================================
# CALL SESSION
# ===================================================================

class LoanEnquirySession:
    def __init__(self, job_ctx: JobContext, metadata: dict):
        self.job_ctx = job_ctx
        self.room_name = job_ctx.room.name
        self.call_ended = False
        self.transcript = []
        self.egress_id = None
        self.agent_session = None
        self.bg_audio = None
        self.safety_timeout_task = None
        self.silence_monitor_task = None
        self.shutdown_event = asyncio.Event()
        self.transcript_sent = False
        self.last_speech_time = asyncio.get_event_loop().time()

        self.customer_name = metadata.get("customer_name", "Customer")
        self.phone = normalize_mobile(metadata.get("phone", ""))
        self.call_id = metadata.get("call_id")
        self.customer_type = metadata.get("customer_type", "new").lower()

        self.customer_since  = metadata.get("customer_since", "")
        self.account_type    = metadata.get("account_type", "Savings")
        self.dob             = metadata.get("dob", "")
        self.email           = metadata.get("email", "")
        self.current_address = metadata.get("current_address", "")
        self.memory          = metadata.get("memory", "")

        self.customer_interested = None
        self.interest_reason = None
        self.lead_quality = "cold"

        # Collected by collect_all_data at end of call
        self.age = None
        self.collected_address = None
        self.loan_type = None
        self.loan_amount = None
        self.loan_purpose = None
        self.employment_type = None
        self.employer_name = None
        self.qualification = None
        self.designation = None
        self.sector = None
        self.working_experience = None
        self.monthly_income = None
        self.existing_emi = None
        self.business_type = None
        self.business_age = None
        self.monthly_turnover = None

        self.call_outcome = None
        self.form_link_sent = False
        self.call_start_time = datetime.now(IST)

        self.language = (metadata.get("language") or "hindi").lower().strip()
        self.gender   = (metadata.get("gender")   or "male").lower().strip()

        gender_cfg = GENDER_CONFIG.get(self.gender, GENDER_CONFIG["male"])
        lang_cfg   = LANG_CONFIG.get(self.language, LANG_CONFIG["hindi"])

        self.agent_name = gender_cfg["name"]
        self.tts_speaker = gender_cfg["speaker"]
        self.tts_language_code = lang_cfg["tts_lang"]
        self.stt_language = lang_cfg["stt_lang"]

        logger.info(
            f"🏦 Session: {self.customer_name} | Type: {self.customer_type.upper()} | "
            f"Lang: {self.language} | Memory: {'YES' if self.memory else 'NO'}"
        )

    def add_user_message(self, text: str):
        self.last_speech_time = asyncio.get_event_loop().time()
        if not text or not text.strip():
            return
        self.transcript.append({"role": "user", "text": text.strip(), "timestamp": now_ist()})
        logger.info(f"👤 USER: {text}")

    def add_agent_message(self, text: str):
        self.last_speech_time = asyncio.get_event_loop().time()
        if not text or not text.strip():
            return
        self.transcript.append({"role": "agent", "text": text.strip(), "timestamp": now_ist()})
        logger.info(f"🤖 AGENT: {text}")

    def set_lead_quality(self, interest: bool, reason: str = ""):
        self.customer_interested = interest
        self.interest_reason = reason
        self.lead_quality = "hot" if interest and self.form_link_sent else "warm" if interest else "cold"

    def update_collected_data(self, field: str, value: str):
        mapping = {
            "age": "age",
            "loan_type": "loan_type",
            "loan_amount": "loan_amount",
            "loan_purpose": "loan_purpose",
            "employment_type": "employment_type",
            "employer_name": "employer_name",
            "qualification": "qualification",
            "designation": "designation",
            "sector": "sector",
            "working_experience": "working_experience",
            "monthly_income": "monthly_income",
            "existing_emi": "existing_emi",
            "business_type": "business_type",
            "business_age": "business_age",
            "monthly_turnover": "monthly_turnover",
            "address": "collected_address",
        }
        attr = mapping.get(field.lower().strip())
        if attr:
            setattr(self, attr, value)
            logger.info(f"📝 Collected: {attr} = {value}")
        else:
            logger.warning(f"⚠️ Unknown collect_data field: {field}")

    # ===================================================================
    # Recording
    # ===================================================================
    async def start_recording(self):
        await asyncio.sleep(0.3)
        try:
            api = LiveKitAPI(
                url=os.environ.get("LIVEKIT_URL"),
                api_key=os.environ["LIVEKIT_API_KEY"],
                api_secret=os.environ["LIVEKIT_API_SECRET"],
            )
            try:
                res = await api.egress.start_room_composite_egress(
                    RoomCompositeEgressRequest(
                        room_name=self.room_name,
                        audio_only=True,
                        file_outputs=[EncodedFileOutput(filepath=f"/recordings/{self.room_name}.ogg")],
                    )
                )
                self.egress_id = res.egress_id
                logger.info(f"🎙️ Recording started: {self.egress_id}")
            finally:
                await api.aclose()
        except Exception as e:
            logger.error(f"❌ Recording failed: {e}")

    # ===================================================================
    # Graceful disconnect
    # ===================================================================
    async def save_and_disconnect(self, delay: float = 2.0):
        if self.call_ended:
            logger.warning("⚠️ Call already ended, skipping")
            return
        self.call_ended = True

        if self.safety_timeout_task:
            try: self.safety_timeout_task.cancel()
            except: pass
        if self.silence_monitor_task:
            try: self.silence_monitor_task.cancel()
            except: pass
        if self.bg_audio:
            try:
                await self.bg_audio.aclose()
                logger.info("🏢 Office ambience stopped")
            except Exception as e:
                logger.warning(f"⚠️ Background audio close failed: {e}")

        logger.info(f"📴 Ending call in {delay}s...")
        await asyncio.sleep(delay)

        await self._send_transcript()

        if self.egress_id:
            try:
                lk_api = LiveKitAPI(
                    url=os.environ.get("LIVEKIT_URL"),
                    api_key=os.environ["LIVEKIT_API_KEY"],
                    api_secret=os.environ["LIVEKIT_API_SECRET"],
                )
                try:
                    from livekit.protocol.egress import StopEgressRequest
                    await asyncio.wait_for(
                        lk_api.egress.stop_egress(StopEgressRequest(egress_id=self.egress_id)),
                        timeout=5.0,
                    )
                    logger.info("🎙️ Recording stopped")
                except asyncio.TimeoutError:
                    logger.warning("⚠️ Egress stop timed out (5s)")
                finally:
                    await lk_api.aclose()
            except Exception as e:
                logger.warning(f"⚠️ Recording stop failed: {e}")

        try:
            await self.job_ctx.api.room.delete_room(DeleteRoomRequest(room=self.room_name))
            logger.info("✅ Room deleted")
        except Exception as e:
            logger.error(f"❌ Room delete failed: {e}")
        finally:
            self.shutdown_event.set()

    # ===================================================================
    # Transcript save (idempotent)
    # ===================================================================
    async def _send_transcript(self):
        if self.transcript_sent:
            logger.info("📤 Transcript already sent, skipping duplicate POST")
            return

        recording_path = f"/recordings/{self.room_name}.ogg" if self.egress_id else None
        payload = {
            "room": self.room_name,
            "call_id": self.call_id,
            "transcript": self.transcript,
            "message_count": len(self.transcript),
            "recording_path": recording_path,
            "customer_interested": self.customer_interested or False,
            "customer_type": self.customer_type,
            "lead_quality": self.lead_quality or "cold",
            "loan_type": self.loan_type,
            "loan_amount": str(self.loan_amount) if self.loan_amount else None,
            "employment_type": self.employment_type,
            "business_type": self.business_type,
            "monthly_income": self.monthly_income,
            "interest_reason": self.interest_reason,
            "whatsapp_form_sent": self.form_link_sent,
            "age": self.age,
            "loan_purpose": self.loan_purpose,
            "employer_name": self.employer_name,
            "qualification": self.qualification,
            "designation": self.designation,
            "sector": self.sector,
            "working_experience": self.working_experience,
            "existing_emi": self.existing_emi,
            "business_age": self.business_age,
            "monthly_turnover": self.monthly_turnover,
            "collected_address": self.collected_address,
        }

        logger.info(
            f"📤 Sending transcript to {BACKEND_URL}/api/agent/transcript | "
            f"call_id={self.call_id}, msgs={len(self.transcript)}"
        )
        if not self.transcript:
            logger.warning(f"⚠️ Sending EMPTY transcript for {self.room_name}")

        for attempt in range(3):
            try:
                async with aiohttp.ClientSession() as http:
                    async with http.post(
                        f"{BACKEND_URL}/api/agent/transcript",
                        json=payload,
                        timeout=aiohttp.ClientTimeout(total=15),
                        ssl=False,
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            self.transcript_sent = True
                            logger.info(f"✅ Transcript saved ({len(self.transcript)} messages) | {data}")
                            return
                        body = await resp.text()
                        logger.error(f"❌ Transcript save returned {resp.status}: {body}")
            except Exception as e:
                logger.error(f"❌ Transcript save failed (attempt {attempt+1}/3): {e}")
                if attempt < 2:
                    await asyncio.sleep(1.0)

        logger.error(f"❌ CRITICAL: All 3 transcript save attempts failed for {self.room_name}")


# ===================================================================
# TOOLS  (only 4 — keep schema small for fast LLM)
# ===================================================================

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
        logger.error(f"❌ send_form_link error: {e}")
        return f"Error: {str(e)}"


@function_tool(
    name="end_call",
    description=(
        "End the call AFTER speaking goodbye. "
        "reason ∈ {interested, not_interested, wrong_number, user_busy, callback_requested, no_response, completed}. "
        "DO NOT speak anything after calling this tool."
    ),
)
async def end_call(context: RunContext, reason: str) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    session.call_outcome = reason
    logger.info(f"📞 END CALL: {reason}")

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
            logger.info(f"📲 WhatsApp form link sent to {session.phone}")
        except Exception as e:
            logger.error(f"❌ WhatsApp send failed: {e}")

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
                    logger.info(f"📅 Callback scheduled: {body}")
                    return f"OK callback set for {body.get('scheduled_callback_at')}"
                txt = await resp.text()
                logger.warning(f"schedule_callback backend {resp.status}: {txt}")
                return f"Failed: {txt}"
    except Exception as e:
        logger.error(f"❌ schedule_callback error: {e}")
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
    logger.info(f"📦 collect_all_data: saved {saved} fields")
    return "ok"


# ===================================================================
# PROMPT BUILDER  (compressed — every line earns its place)
# ===================================================================

def build_loan_enquiry_instructions(session) -> str:
    memory_block = (
        f"\n🧠 PAST CALL CONTEXT: {session.memory}\n"
        if session.memory else ""
    )
    _now = datetime.now(IST)
    _tomorrow = (_now + timedelta(days=1)).strftime("%Y-%m-%d")
    time_ctx = f"NOW(IST): {_now.strftime('%a %d %b %Y, %I:%M %p')} | Tomorrow: {_tomorrow} | Working hrs: 10:00–24:00 IST"

    if session.language == "english":
        return _build_english_prompt(session, memory_block, time_ctx, _tomorrow)
    if session.language == "marathi":
        return _build_marathi_prompt(session, memory_block, time_ctx, _tomorrow)
    return _build_hindi_prompt(session, memory_block, time_ctx, _tomorrow)


def _build_hindi_prompt(session, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    if session.customer_type == "existing":
        intro_line = "आप हमारे valued customer हैं। Business, Personal या Education loan में interest है?"
        eligibility = "Education 8.5–10.5% / Business 10–13% / Personal 11–14.5%"
    else:
        intro_line = (
            "पुसद अर्बन बैंक 30+ साल से Vidarbha में service दे रहा है। "
            "Business, Personal या Education loan में interest है?"
        )
        eligibility = (
            "Education 50K–20L | 8.5–10.5% (पढ़ाई में EMI नहीं) / "
            "Business 1L–50L | 10–13% (2+ साल पुराना business) / "
            "Personal 50K–10L | 11–14.5% (₹25K+ salary, 6 month job stability)"
        )

    return f"""आप {agent} हैं — पुसद अर्बन बैंक की loan specialist। Customer: {name} ({session.customer_type.upper()})।
{time_ctx}{memory_block}
⚠️ Disclaimer + पहचान पहले हो चुकी है। नाम दोबारा मत पूछो।

STYLE: Warm, professional, असली relationship manager जैसी। हर response 1 छोटा वाक्य (<15 शब्द)। एक बार में एक सवाल। जवाब सुनकर कभी-कभी हल्का acknowledgment ("जी", "ठीक है") — हर बार नहीं।

FLOW:
1. हाँ बोले → "{intro_line}"
2. Loan rates एक line में: {eligibility}
3. Interest confirm → "बस कुछ छोटे सवाल, फिर WhatsApp पर form।"
4. एक-एक करके पूछो (किसी tool को call नहीं करना — सीधे अगला सवाल):
   • "आपकी उम्र क्या है?"
   • "आप क्या काम करते हैं और किस कंपनी में?"
   • "आपकी qualifications क्या हैं?"
   • "कितने साल का experience है?"
   • "कोई existing loan या EMI चल रही है?"
   • "लोन किस purpose के लिए और कितना amount चाहिए?"
   • "क्या यही WhatsApp number है?" (नहीं तो नया number लो)
5. WhatsApp number confirm होते ही — TURN A: चुपचाप collect_all_data(...) call करो (सारे fields एक shot में, sector designation से silently infer करो)। फिर बोलो: "ठीक है {name} जी। आप पात्र हैं। मैं अभी WhatsApp पर form link भेज दूँ?"
6. ग्राहक हाँ बोले — TURN B: send_form_link(loan_type, estimated_amount) call करो। फिर बोलो: "form link भेज दिया है। please form भर लीजिए।"
7. TURN C (पक्का करना है — skip मत करो): बोलो: "धन्यवाद {name} जी, आपके समय के लिए। आपका दिन शुभ हो।" — फिर तुरंत उसी response में end_call("interested") call करो।

⚠️ STEPS 5-6-7 अलग-अलग TURN हैं। एक turn में सब नहीं — हर step पर पहले बोलो, फिर tool call (या tool call → फिर बोलो जैसा बताया है)। चुप मत रहो।

RULES:
• Q&A (steps 1-4) में कोई tool call नहीं — सिर्फ बातचीत।
• Customer "नहीं" / interest नहीं → "कोई बात नहीं, धन्यवाद {name} जी।" → end_call("not_interested").
• Customer busy / "बाद में call करो" → पूछो "कब suitable होगा?" → ISO datetime बनाओ (e.g. कल सुबह 10 → "{_tomorrow}T10:00:00+05:30"; unclear तो default कल 10AM) → schedule_callback(iso, "user_busy") → "ठीक है, उस समय call करूँगी।" → end_call("user_busy").
• Off-topic सवाल (मौसम, balance, "AI हो?") → 1 line में deflect करके वही पिछला सवाल repeat करो। बहस नहीं, lecture नहीं।
• Time-waster signals (mockery, repeated dodge, gibberish) → calmly पूछो "क्या आप वाकई loan में interested हैं?" → जवाब के अनुसार end_call.
• Gender: "{name}" से gender infer करो; verbs match (करते/करती, रहा/रही)। आवाज़़ से confirm होने पर consistent रहो।
• end_call() के बाद कुछ मत बोलो। STOP.
• SCRIPT: सिर्फ Devanagari (हिन्दी/मराठी) या Roman script use करो। कभी Cyrillic/Russian/Greek अक्षर मत लिखो।
• TTS: कोई emoji नहीं, कोई em-dash (—) नहीं, कोई empty line नहीं। सिर्फ ?, ., ।
• Tool नाम कभी मत बोलो।"""


def _build_marathi_prompt(session, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    if session.customer_type == "existing":
        intro_line = "तुम्ही आमचे valued customer आहात. Business, Personal किंवा Education loan मध्ये interest आहे का?"
        eligibility = "Education 8.5–10.5% / Business 10–13% / Personal 11–14.5%"
    else:
        intro_line = (
            "पुसद अर्बन बँक 30+ वर्षांपासून Vidarbha मध्ये सेवा देत आहे. "
            "Business, Personal किंवा Education loan मध्ये interest आहे का?"
        )
        eligibility = (
            "Education 50K–20L | 8.5–10.5% (शिक्षणादरम्यान EMI नाही) / "
            "Business 1L–50L | 10–13% (2+ वर्षे जुना व्यवसाय) / "
            "Personal 50K–10L | 11–14.5% (₹25K+ पगार, 6 महिने नोकरी)"
        )

    return f"""तुम्ही {agent} आहात — पुसद अर्बन बँकची loan specialist. Customer: {name} ({session.customer_type.upper()}).
{time_ctx}{memory_block}
⚠️ ओळख आधीच झाली आहे. नाव परत विचारू नका.

STYLE: Warm, professional, खरी relationship manager सारखी. प्रत्येक response 1 छोटे वाक्य (<15 शब्द). एका वेळी एक प्रश्न. कधीकधी हलकी acknowledgment ("हो", "ठीक आहे") — प्रत्येक वेळी नाही.

FLOW:
1. हो म्हणाले → "{intro_line}"
2. Loan rates एका ओळीत: {eligibility}
3. Interest confirm → "फक्त काही छोटे प्रश्न, मग WhatsApp वर form."
4. एक एक करून विचारा (कोणतेही tool call नाही — फक्त संभाषण):
   • "तुमचे वय किती आहे?"
   • "तुम्ही काय काम करता आणि कोणत्या कंपनीत?"
   • "तुमची qualification काय आहे?"
   • "किती वर्षांचा experience आहे?"
   • "कोणता existing loan किंवा EMI चालू आहे का?"
   • "loan कशासाठी हवी आणि किती amount हवी?"
   • "हाच WhatsApp number आहे का?" (नाही तर नवा number घ्या)
5. WhatsApp confirm होताच — TURN A: शांतपणे collect_all_data(...) call करा (सगळे fields एकत्र, sector designation वरून infer करा). मग म्हणा: "ठीक आहे {name}, तुम्ही पात्र आहात. मी आत्ता WhatsApp वर form link पाठवू का?"
6. Customer हो म्हणाले — TURN B: send_form_link(loan_type, estimated_amount) call करा. मग म्हणा: "form link पाठवली आहे. कृपया form भरा."
7. TURN C (नक्की करा — skip करू नका): म्हणा: "धन्यवाद {name}, तुमच्या वेळाबद्दल. तुमचा दिवस चांगला जाऊ दे." — मग त्याच response मध्ये end_call("interested") call करा.

⚠️ STEPS 5-6-7 वेगळ्या TURNS आहेत. एकत्र करू नका — प्रत्येक step वर आधी बोला, मग tool call.

RULES:
• Q&A (steps 1-4) मध्ये कोणतेही tool call नाही — फक्त संभाषण.
• Customer "नाही" / interest नाही → "काही हरकत नाही, धन्यवाद {name}." → end_call("not_interested").
• Customer busy / "नंतर call करा" → विचारा "कधी suitable होईल?" → ISO datetime बनवा (उद्या सकाळी 10 → "{_tomorrow}T10:00:00+05:30"; unclear असल्यास उद्या 10AM) → schedule_callback(iso, "user_busy") → "ठीक आहे, त्या वेळी call करतो/करते." → end_call("user_busy").
• Off-topic प्रश्न (हवामान, balance, "तुम्ही AI आहात का?") → 1 ओळीत deflect करा, मग शेवटचा प्रश्न repeat करा.
• Time-waster → शांतपणे विचारा "तुम्हाला खरोखर loan हवी आहे का?" → उत्तरानुसार end_call.
• end_call() नंतर काहीही बोलू नका. STOP.
• TTS: कोणतेही emoji नाही, em-dash नाही. फक्त ?, ., ।
• Tool नावे कधीही बोलू नका."""


def _build_english_prompt(session, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    if session.customer_type == "existing":
        intro_line = "You are our valued customer. Are you interested in a Business, Personal, or Education loan?"
        eligibility = "Education 8.5–10.5% / Business 10–13% / Personal 11–14.5%"
    else:
        intro_line = (
            "Pusad Urban Bank has been serving Vidarbha for over 30 years. "
            "Are you interested in a Business, Personal, or Education loan?"
        )
        eligibility = (
            "Education 50K–20L | 8.5–10.5% (no EMI during studies) / "
            "Business 1L–50L | 10–13% (business 2+ years old) / "
            "Personal 50K–10L | 11–14.5% (salary ₹25K+, 6-month job stability)"
        )

    return f"""You are {agent} — loan specialist at Pusad Urban Bank. Customer: {name} ({session.customer_type.upper()}).
{time_ctx}{memory_block}
⚠️ Introduction and identity already done. Do NOT ask the name again.

STYLE: Warm, professional, like a real relationship manager. Max 15 words per response. One question at a time. Occasional light acknowledgment ("I see", "Got it") — not every turn.

FLOW:
1. Customer says yes → "{intro_line}"
2. Rates in one line: {eligibility}
3. Interest confirmed → "Just a few quick questions, then I'll send a form to your WhatsApp."
4. Ask one by one (no tool calls during Q&A — conversation only):
   • "How old are you?"
   • "What is your occupation and which company do you work for?"
   • "What are your educational qualifications?"
   • "How many years of work experience do you have?"
   • "Do you have any existing loans or EMIs?"
   • "What is the loan for, and how much amount do you need?"
   • "Is this your WhatsApp number?" (if no, get the correct number)
5. Once WhatsApp confirmed — TURN A: silently call collect_all_data(...) with all collected fields at once (infer sector from designation). Then say: "Great {name}, you are eligible. Shall I send the application form to your WhatsApp right now?"
6. Customer says yes — TURN B: call send_form_link(loan_type, estimated_amount). Then say: "I have sent the form link. Please fill it in at your convenience."
7. TURN C (mandatory, do not skip): Say "Thank you {name} for your time. Have a great day." — then immediately in the same response call end_call("interested").

⚠️ STEPS 5-6-7 are SEPARATE TURNS. Do not combine — speak first then tool call (or tool call then speak, as instructed above). Do not stay silent.

RULES:
• No tool calls during Q&A (steps 1-4) — conversation only.
• Customer says no / not interested → "No problem at all, thank you {name}." → end_call("not_interested").
• Customer busy / "call later" → ask "When would be a convenient time?" → build ISO datetime (e.g. tomorrow 10am → "{_tomorrow}T10:00:00+05:30"; unclear → default tomorrow 10am) → schedule_callback(iso, "user_busy") → "I'll call you at that time." → end_call("user_busy").
• Off-topic questions (weather, balance, "are you an AI?") → deflect in 1 line, then repeat the last question.
• Time-wasters (repeated dodge, gibberish, mockery) → calmly ask "Are you genuinely interested in a loan?" → end_call based on response.
• After end_call() say NOTHING. STOP.
• TTS: No emojis, no em-dashes, no empty lines. Only ?, ., !
• Never say tool names aloud."""




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
    logger.info("🏦 Loan Enquiry Agent starting")
    session = None

    try:
        await ctx.connect()
        logger.info(f"✅ Connected: {ctx.room.name}")

        metadata = {}
        if ctx.room.metadata:
            try:
                metadata = json.loads(ctx.room.metadata)
                logger.info(f"📋 Room Metadata: {metadata}")
            except Exception as e:
                logger.warning(f"Room metadata parse error: {e}")
        if not metadata and ctx.job.metadata:
            try:
                metadata = json.loads(ctx.job.metadata)
                logger.info(f"📋 Job Metadata: {metadata}")
            except:
                pass

        session = LoanEnquirySession(ctx, metadata)

        async def _flush_transcript_on_shutdown():
            try:
                await session._send_transcript()
            except Exception as e:
                logger.error(f"❌ Shutdown-callback transcript flush failed: {e}")

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
            logger.info(f"📱 Customer answered: {participant.identity}")
        except TimeoutError:
            logger.error("❌ No participant, exiting")
            if session:
                await session._send_transcript()
            return

        @ctx.room.on("participant_disconnected")
        def on_participant_disconnect(participant_info):
            logger.info(f"📞 Participant disconnected: {participant_info.identity}")
            if session is not None and not session.call_ended:
                logger.info("📤 Customer hung up - saving transcript...")
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
            f"🔧 Config: STT={session.stt_language} | TTS={session.tts_language_code} | Speaker={session.tts_speaker}"
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
                    google.LLM(model="gemini-2.5-flash", temperature=0.4),
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
                logger.error(f"❌ Transcript capture error: {e}")

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
                logger.error(f"❌ Agent speech capture error: {e}")

        session.agent_session = agent_session

        await agent_session.start(
            room=ctx.room,
            agent=LoanEnquiryAgent(session),
        )
        logger.info("✅ Session started with production settings")

        asyncio.create_task(session.start_recording())

        bg_audio = None
        if _BACKGROUND_AUDIO_AVAILABLE:
            try:
                bg_audio = BackgroundAudioPlayer(
                    ambient_sound=AudioConfig(BuiltinAudioClip.OFFICE_AMBIENCE, volume=0.15),
                )
                await bg_audio.start(room=ctx.room, agent_session=agent_session)
                logger.info("🏢 Office ambience started")
            except Exception as e:
                logger.warning(f"⚠️ Background audio failed: {e}")
                bg_audio = None
        session.bg_audio = bg_audio

        try:
            logger.info("🔊 Triggering hardcoded split greeting")

            if session.language == "english":
                part1 = f"Hello, this is {session.agent_name} calling from Pusad Urban Bank. This call is being recorded for security and quality purposes."
                part2 = f"Am I speaking with {session.customer_name}?"
            elif session.language == "marathi":
                bolte = "बोलतेय" if session.gender == "female" else "बोलतोय"
                part1 = f"नमस्कार, मी {session.agent_name}, पुसद अर्बन बँक मधून {bolte}. ही कॉल सुरक्षेसाठी रेकॉर्ड केली जात आहे."
                part2 = f"मी {session.customer_name} जींशी बोलतोय का?"
            else:
                bol = "रही" if session.gender == "female" else "रहा"
                part1 = f"Hello, मैं {session.agent_name} बोल {bol} हूँ पुसद अर्बन बैंक से। यह कॉल सुरक्षा के लिए रिकॉर्ड की जा रही है।"
                part2 = f"क्या मेरी बात {session.customer_name} जी से हो रही है?"

            handle1 = agent_session.say(part1, allow_interruptions=False, add_to_chat_ctx=False)
            await handle1
            await asyncio.sleep(0.2)
            handle2 = agent_session.say(part2, allow_interruptions=True, add_to_chat_ctx=False)
            await handle2
        except Exception as e:
            logger.warning(f"⚠️ Greeting failed: {e}")

        async def silence_monitor():
            while not session.call_ended:
                await asyncio.sleep(3)
                gap = asyncio.get_event_loop().time() - session.last_speech_time
                if gap > 20 and not session.call_ended:
                    logger.warning("🕒 Over 25s silence — hanging up.")
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
                logger.warning("⚠️ SAFETY TIMEOUT: 360s exceeded — force-ending stuck call")
                session.call_outcome = "safety_timeout"
                await session.save_and_disconnect(delay=0)

        session.safety_timeout_task = asyncio.create_task(safety_timeout())

    except Exception as e:
        logger.error(f"❌ CRITICAL ERROR in entrypoint: {e}", exc_info=True)
        if session and not session.call_ended:
            try:
                await session.save_and_disconnect(delay=0)
            except Exception as e2:
                logger.error(f"❌ Save after error also failed: {e2}")
    except BaseException as e:
        logger.error(f"❌ AGENT CRASH (BaseException): {type(e).__name__}: {e}")
        if session and not session.call_ended:
            try:
                session.call_ended = True
                await session._send_transcript()
            except Exception as e2:
                logger.error(f"❌ Emergency save failed: {e2}")

    finally:
        if session:
            logger.info("⏳ Waiting for transcript save to complete...")
            try:
                await session.shutdown_event.wait()
                logger.info("✅ Agent shutdown complete")
            except Exception as e:
                logger.error(f"❌ Error waiting for shutdown: {e}")


# ===================================================================
# MAIN
# ===================================================================

if __name__ == "__main__":
    while True:
        try:
            logger.info("🏦 Starting Loan Enquiry Agent Worker...")
            cli.run_app(
                WorkerOptions(
                    entrypoint_fnc=entrypoint,
                    # Override via env so local dev (e.g. AGENT_NAME=pusad-bank-loan-enquiry-local)
                    # doesn't fight the cloud worker for the same dispatch.
                    agent_name=os.getenv("AGENT_NAME", "pusad-bank-loan-enquiry-enhanced"),
                )
            )
        except Exception as e:
            logger.error(f"❌ Worker crashed: {e}")
            logger.info("🔄 Restarting worker in 5 seconds...")
            import time
            time.sleep(5)
        except KeyboardInterrupt:
            logger.info("👋 Worker stopped by user")
            break
