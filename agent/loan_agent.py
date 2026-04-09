# -*- coding: utf-8 -*-
"""
Loan Enquiry Agent - Pusad Urban Bank 🏦
=========================================
Updated: Natural friendly flow + Recording disclaimer at very start
Production-hardened with clean shutdown, transcript-first save, and error recovery.
Author: Tanvi Shrivastava - Vaani Team
Date: March 2026
"""

import os
import json
import logging
import asyncio
import aiohttp
from datetime import datetime
import pytz
from dotenv import load_dotenv

from livekit import agents, rtc
from livekit.agents import JobContext, WorkerOptions, cli, function_tool, RunContext
from livekit.agents.voice import AgentSession, Agent
from livekit.plugins import deepgram, silero, sarvam, google
from livekit.api import DeleteRoomRequest, LiveKitAPI
from livekit.protocol.egress import RoomCompositeEgressRequest, EncodedFileOutput

load_dotenv(".env.local")

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s")
logger = logging.getLogger("loan-enquiry-agent")

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8002")
if "localhost" in BACKEND_URL:
    import warnings
    warnings.warn(
        f"BACKEND_URL={BACKEND_URL} — set correct server URL in .env.local or transcripts will fail.",
        stacklevel=1
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
# CALL SESSION - Per-call state management
# ===================================================================

class LoanEnquirySession:
    def __init__(self, job_ctx: JobContext, metadata: dict):
        self.job_ctx = job_ctx
        self.room_name = job_ctx.room.name
        self.call_ended = False
        self.transcript = []
        self.egress_id = None
        self.agent_session = None          # ✅ Store agent session for clean shutdown
        self.safety_timeout_task = None    # ✅ Store task reference for cancellation
        self.silence_monitor_task = None   # ✅ Store task reference for cancellation
        self.shutdown_event = asyncio.Event()  # ✅ Event to signal process shutdown
        self.last_speech_time = asyncio.get_event_loop().time()  # ✅ Monitor silence

        self.customer_name = metadata.get("customer_name", "Customer")
        self.phone = normalize_mobile(metadata.get("phone", ""))
        self.call_id = metadata.get("call_id")
        self.customer_type = metadata.get("customer_type", "new").lower()

        self.customer_since  = metadata.get("customer_since", "")
        self.account_type    = metadata.get("account_type", "Savings")
        self.dob             = metadata.get("dob", "")
        self.email           = metadata.get("email", "")
        self.current_address = metadata.get("current_address", "")
        self.memory = metadata.get("memory", "")  # RAG memory from previous calls

        self.customer_interested = None
        self.interest_reason = None
        self.lead_quality = "cold"

        # ── collected by collect_data tool during call ──────────────
        self.age = None
        self.collected_address = None
        self.loan_type = None
        self.loan_amount = None
        self.loan_purpose = None
        self.employment_type = None
        self.employer_name = None
        self.designation = None
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

        logger.info(f"🏦 Session: {self.customer_name} | Type: {self.customer_type.upper()} | Lang: {self.language} | Memory: {'YES' if self.memory else 'NO'}")

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
        """Called by collect_data tool to persist info extracted from conversation."""
        mapping = {
            "age":             "age",
            "loan_type":       "loan_type",
            "loan_amount":     "loan_amount",
            "loan_purpose":    "loan_purpose",
            "employment_type": "employment_type",
            "employer_name":   "employer_name",
            "designation":     "designation",
            "monthly_income":  "monthly_income",
            "existing_emi":    "existing_emi",
            "business_type":   "business_type",
            "business_age":    "business_age",
            "monthly_turnover":"monthly_turnover",
            "address":         "collected_address",
        }
        attr = mapping.get(field.lower().strip())
        if attr:
            setattr(self, attr, value)
            logger.info(f"📝 Collected: {attr} = {value}")
        else:
            logger.warning(f"⚠️ Unknown collect_data field: {field}")

    # ===================================================================
    # Recording - with proper try/finally for API cleanup
    # ===================================================================
    async def start_recording(self):
        """Start recording with 1s delay for audio stabilization"""
        await asyncio.sleep(1.0)
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
                        file_outputs=[
                            EncodedFileOutput(filepath=f"/recordings/{self.room_name}.ogg")
                        ],
                    )
                )
                self.egress_id = res.egress_id
                logger.info(f"🎙️ Recording started: {self.egress_id}")
            finally:
                await api.aclose()
        except Exception as e:
            logger.error(f"❌ Recording failed: {e}")

    # ===================================================================
    # Graceful Disconnect - transcript-first, cancel tasks, timeout egress
    # ===================================================================
    async def save_and_disconnect(self, delay: float = 2.0):
        """Gracefully end call with transcript save"""
        if self.call_ended:
            logger.warning("⚠️ Call already ended, skipping")
            return

        self.call_ended = True

        # ✅ Cancel safety timeout to prevent resource leak
        if hasattr(self, 'safety_timeout_task') and self.safety_timeout_task:
            try:
                self.safety_timeout_task.cancel()
                logger.info("🛑 Safety timeout cancelled")
            except:
                pass

        # ✅ Cancel silence monitor
        if hasattr(self, 'silence_monitor_task') and self.silence_monitor_task:
            try:
                self.silence_monitor_task.cancel()
                logger.info("🛑 Silence monitor cancelled")
            except:
                pass

        logger.info(f"📴 Ending call in {delay}s...")

        # Wait for final speech/transcript to complete
        logger.info(f"⏳ Waiting {delay}s for agent's final message/STT to complete...")
        await asyncio.sleep(delay)

        # ✅ CRITICAL: Save transcript FIRST (most important data)
        await self._send_transcript()

        # Stop recording if active (non-blocking, with timeout)
        if self.egress_id:
            try:
                lk_api = LiveKitAPI(
                    url=os.environ.get("LIVEKIT_URL"),
                    api_key=os.environ["LIVEKIT_API_KEY"],
                    api_secret=os.environ["LIVEKIT_API_SECRET"],
                )
                try:
                    from livekit.protocol.egress import StopEgressRequest
                    # Add 5s timeout so this doesn't block forever
                    await asyncio.wait_for(
                        lk_api.egress.stop_egress(StopEgressRequest(egress_id=self.egress_id)),
                        timeout=5.0
                    )
                    logger.info(f"🎙️ Recording stopped")
                except asyncio.TimeoutError:
                    logger.warning("⚠️ Egress stop timed out (5s)")
                finally:
                    await lk_api.aclose()
            except Exception as e:
                logger.warning(f"⚠️ Recording stop failed (non-critical): {e}")

        # Delete room (disconnects all participants)
        try:
            await self.job_ctx.api.room.delete_room(
                DeleteRoomRequest(room=self.room_name)
            )
            logger.info(f"✅ Room deleted")
        except Exception as e:
            logger.error(f"❌ Room delete failed: {e}")
        finally:
            self.shutdown_event.set()  # ✅ Signal main process to exit

    # ===================================================================
    # Transcript Save - with retries and proper timeout
    # ===================================================================
    async def _send_transcript(self):
        call_duration = (datetime.now(IST) - self.call_start_time).total_seconds()
        recording_path = f"/recordings/{self.room_name}.ogg" if self.egress_id else None
        
        # ── Payload matches backend PusadTranscriptPayload schema exactly ──
        payload = {
            "room": self.room_name,  # REQUIRED by backend
            "call_id": self.call_id,
            "transcript": self.transcript,
            "message_count": len(self.transcript),
            "recording_path": recording_path,
            # Qualification fields
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
            # Collected during conversation
            "age": self.age,
            "loan_purpose": self.loan_purpose,
            "employer_name": self.employer_name,
            "designation": self.designation,
            "existing_emi": self.existing_emi,
            "business_age": self.business_age,
            "monthly_turnover": self.monthly_turnover,
            "collected_address": self.collected_address,
        }

        logger.info(f"📤 Sending transcript to {BACKEND_URL}/api/agent/transcript | call_id={self.call_id}, msgs={len(self.transcript)}")

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
                            logger.info(f"✅ Transcript saved ({len(self.transcript)} messages) | Response: {data}")
                            return
                        else:
                            body = await resp.text()
                            logger.error(f"❌ Transcript save returned {resp.status}: {body}")
            except Exception as e:
                logger.error(f"❌ Transcript save failed (attempt {attempt+1}/3): {e}")
                if attempt < 2:
                    await asyncio.sleep(1.0)

        logger.error(f"❌ CRITICAL: All 3 transcript save attempts failed for {self.room_name}")


# ===================================================================
# TOOLS
# ===================================================================

@function_tool(name="send_form_link", description="Send loan form link via WhatsApp. Call ONLY when customer is interested and agrees.")
async def send_form_link(context: RunContext, loan_type: str, estimated_amount: int, delivery_method: str = "whatsapp") -> str:
    session: LoanEnquirySession = context.userdata["session"]
    try:
        # ── 1. Send via your backend (existing) ──────────────────────
        payload = {
            "phone": session.phone,
            "customer_name": session.customer_name,
            "customer_type": session.customer_type,
            "call_id": session.call_id,
            "loan_type": loan_type,
            "estimated_amount": estimated_amount,
            "delivery_method": delivery_method
        }
        async with aiohttp.ClientSession() as http:
            async with http.post(
                f"{BACKEND_URL}/api/agent/send-whatsapp-form",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10),
                ssl=False,
            ) as resp:
                backend_ok = resp.status == 200

        # ── 2. Update session state (AiSensy is handled by backend, no duplicate) ──
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
    description="""
End the call naturally. Call this AFTER speaking your goodbye message.

Use when:
- interested: Customer interested, form sent
- not_interested: Customer declined
- wrong_number: Wrong person
- user_busy: Customer busy, asked to call later
- callback_requested: Customer asked to call back later
- no_response: No clear response
- completed: Call completed normally

IMPORTANT: After calling this tool, do NOT generate any more text or speech."""
)
async def end_call(context: RunContext, reason: str) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    session.call_outcome = reason
    logger.info(f"📞 END CALL: {reason}")

    # Schedule graceful disconnect with extra time for final speech
    asyncio.create_task(session.save_and_disconnect(delay=8.0))

    # ✅ CRITICAL: Return explicit stop instruction to LLM
    # This is the tool result seen by the LLM, NOT spoken via TTS directly.
    # An empty string caused the LLM to generate extra speech.
    return "SUCCESS: User hanging up. Stop generating anything."


@function_tool(
    name="collect_data",
    description=(
        "Silently save a detail the customer just shared. "
        "Call immediately whenever the customer mentions their age, income, "
        "employer, address, business type, loan amount, or any other qualifying detail. "
        "Never tell the customer you are saving data — just call this tool and continue."
    ),
)
async def collect_data(context: RunContext, field: str, value: str) -> str:
    """
    Args:
        field: age | loan_type | loan_amount | loan_purpose | employment_type |
               employer_name | designation | monthly_income | existing_emi |
               business_type | business_age | monthly_turnover | address
        value: what the customer said, as a string
    """
    session: LoanEnquirySession = context.userdata["session"]
    session.update_collected_data(field, value)
    return "ok"


# ===================================================================
# PROMPT BUILDER
# ===================================================================

def get_recording_disclaimer(lang: str) -> str:
    return {
        "hindi":   "यह कॉल आपकी सुरक्षा और गुणवत्ता के लिए रिकॉर्ड की जा रही है।",
        "marathi": "ही कॉल तुमच्या सुरक्षेसाठी आणि गुणवत्तेसाठी रेकॉर्ड केली जात आहे।",
        "english": "This call is being recorded for security and quality purposes.",
    }.get(lang, "This call is being recorded for security and quality purposes.")


def build_loan_enquiry_instructions(session: LoanEnquirySession) -> str:

    memory_block = f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🧠 RAG MEMORY (PAST CALL DETAILS)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n{session.memory}\n" if session.memory else ""

    if session.customer_type == CustomerType.EXISTING:
        return f"""ROLE: {session.agent_name}, पुसद अर्बन बैंक का loan specialist। मौजूदा ग्राहक।
GOAL: पहचान पुष्टि → Loan offer → Interest check → Details collect → Form भेजो → Call end।
STYLE: Helper, professional. छोटे वाक्य। एक बार में एक सवाल।

DATA:
Customer:{session.customer_name} | Type:EXISTING {memory_block}

⚠️ सिस्टम नोट: परिचय, disclaimer, पहचान पुष्टि पहले ही हो चुकी है। दोबारा मत बोलो। सीधे जवाब से शुरू करो।

FLOW:
1. ग्राहक हाँ बोले तो: "आप हमारे valued customer हैं। आपके लिए Business, Personal या Education loan के options हैं। क्या आप इनमें से कोई loan लेना चाहेंगे?"
2. Loan details बताओ:
   Education: 50K-20L | 8.5-10.5% | 15Y | पढ़ाई में no EMI
   Business: 1L-50L | 10-13% | 7Y | business 2Y+ पुराना
   Personal: 50K-10L | 11-14.5% | 5Y | min 25K salary
3. Strong interest पर transition: "बहुत अच्छा! बस कुछ छोटे-छोटे सवाल पूछने हैं, उसके बाद WhatsApp पर form भेजूँगा। शुरू करते हैं —"
4. एक-एक करके पूछो:
   - "आपकी उम्र क्या है?"
   - "आप क्या काम करते हैं?"
   - "किस कंपनी में काम करते हैं?"
   - "आपकी salary किस range में आती है?"
   - "लोन के लिए कितना amount चाहिए?"
5. Eligible: "आप पात्र हैं। WhatsApp पर form link भेज दूँ?"
6. Link भेजने के बाद: "link भेज दिया है। form भर लीजिए।"

RULES:
1. If RAG MEMORY is available, use past call context naturally — reference previous interest, skip already-collected info, continue from where last call ended.
2. हर बार सिर्फ एक सवाल पूछो।
3. जब भी ग्राहक कोई जानकारी दें (उम्र, आय, नियोक्ता, पता, loan राशि) तुरंत collect_data(field, value) tool call करो — चुपचाप।
4. end_call() से पहले हमेशा यह बोलें: "धन्यवाद [ग्राहक का नाम देवनागरी लिपि में] जी, आपके समय के लिए। आपका दिन शुभ हो!" (उदाहरण: 'Tanvi' की जगह 'तन्वी' लिखें)।
5. यह बोलने के बाद उसी response में end_call() tool call करें।
6. NEVER SPEAK AGAIN AFTER end_call(). SILENT. STOP.
7. Tool नाम कभी मत बोलो।
8. ⚠️ STRICT TTS RULE: DO NOT use ANY emojis (like 😊, 🙏). Use ONLY standard punctuation (?, .). Avoid long dashes (—). DO NOT output empty lines.
"""

    else:  # नया ग्राहक
        return f"""ROLE: {session.agent_name}, पुसद अर्बन बैंक का loan specialist। नया ग्राहक।
GOAL: पहचान पुष्टि → Bank intro → Loan offer → Interest check → Details collect → Form भेजो → Call end।
STYLE: Helper, professional. छोटे वाक्य। एक बार में एक सवाल।

DATA:
Customer:{session.customer_name} | Type:NEW {memory_block}

⚠️ सिस्टम नोट: परिचय, disclaimer, पहचान पुष्टि पहले ही हो चुकी है। दोबारा मत बोलो। ग्राहक का नाम {session.customer_name} है — दोबारा नाम मत पूछो।

LOAN ELIGIBILITY CRITERIA (नए ग्राहकों को clearly बताओ):
   Education: 50K-20L | 8.5-10.5% | 15Y | पढ़ाई के दौरान कोई EMI नहीं | admission letter ज़रूरी
   Business: 1L-50L | 10-13% | 7Y | business 2+ साल पुराना | GST registration preferred
   Personal: 50K-10L | 11-14.5% | 5Y | min ₹25,000/month salary | 6 महीने की job stability ज़रूरी

FLOW:
1. ग्राहक हाँ बोले तो — पहले bank का brief intro दो:
   "पुसद अर्बन बैंक Vidarbha में 30+ सालों से सेवा कर रहा है — सबसे कम interest rates और fast approval के साथ।"
   फिर loan offer: "आपके लिए Business, Personal या Education loan के options हैं। क्या आप कोई loan लेना चाहेंगे?"
2. Loan details और eligibility criteria clearly बताओ (ऊपर देखो)।
3. ग्राहक का bank account status पूछो:
   "क्या आपका पुसद अर्बन बैंक में पहले से कोई account है?"
   → अगर नहीं: "कोई बात नहीं — loan के साथ-साथ हम account खोलने में भी help कर सकते हैं।"
4. Strong interest पर transition: "बहुत अच्छा! बस कुछ छोटे-छोटे सवाल पूछने हैं, उसके बाद WhatsApp पर form भेजूँगा। शुरू करते हैं —"
6. एक-एक करके पूछो:
   - "आपकी उम्र क्या है?"
   - "आप क्या काम करते हैं?"
   - "किस कंपनी में / किस जगह काम करते हैं?"
   - "आपकी monthly salary किस range में आती है?"
   - "कोई existing loan या EMI चल रही है? कितनी?"
   - "लोन के लिए कितना amount चाहिए?"
   - "आप कहाँ के रहने वाले हैं?"
7. Eligible: "आप पात्र हैं। WhatsApp पर form link भेज दूँ?"
8. Link भेजने के बाद: "link भेज दिया है। form भर लीजिए।"

RULES:
1. If RAG MEMORY is available, use past call context naturally — reference previous interest, skip already-collected info, continue from where last call ended.
2. हर बार सिर्फ एक सवाल पूछो।
3. ग्राहक का नाम दोबारा मत पूछो — पहले से पता है: {session.customer_name}
4. जब भी ग्राहक कोई जानकारी दें (उम्र, आय, नियोक्ता, पता, loan राशि, existing EMI) तुरंत collect_data(field, value) tool call करो — चुपचाप।
5. end_call() से पहले बोलो: "धन्यवाद {session.customer_name} जी, आपके समय के लिए। आपका दिन शुभ हो!" फिर उसी response में end_call() करो।
6. NEVER SPEAK AGAIN AFTER end_call(). SILENT. STOP.
7. Tool नाम कभी मत बोलो।
"""


# ===================================================================
# AGENT
# ===================================================================

class LoanEnquiryAgent(Agent):
    def __init__(self, session: LoanEnquirySession):
        super().__init__(
            instructions=build_loan_enquiry_instructions(session),
            tools=[send_form_link, end_call, collect_data],
        )


# ===================================================================
# ENTRYPOINT - Production-hardened with proper error recovery
# ===================================================================

async def entrypoint(ctx: JobContext):
    logger.info("🏦 Loan Enquiry Agent starting")
    session = None  # Define early for finally block

    try:
        await ctx.connect()
        logger.info(f"✅ Connected: {ctx.room.name}")

        # Parse metadata - Try room metadata first, then job metadata
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

        # Wait for participant with timeout
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
            # Send empty transcript so backend knows call failed
            if session:
                await session._send_transcript()
            return

        # ===================================================================
        # Participant Disconnect Handler - CRITICAL for production
        # When customer hangs up, always save transcript
        # ===================================================================
        @ctx.room.on("participant_disconnected")
        def on_participant_disconnect(participant_info):
            logger.info(f"📞 Participant disconnected: {participant_info.identity}")
            # ✅ Check session exists before accessing
            if session is not None and not session.call_ended:
                logger.info("📤 Customer hung up - saving transcript...")
                asyncio.create_task(session.save_and_disconnect(delay=1.0))

        # Brief delay for call stabilization
        await asyncio.sleep(0.5)

        # ===================================================================
        # Production VAD - Balanced for noisy phone calls
        # ===================================================================
        vad = silero.VAD.load(
            min_speech_duration=0.20,
            min_silence_duration=0.05,
            activation_threshold=0.35,
        )

        # ===================================================================
        # Agent Session - Dynamic STT/TTS based on language & gender
        # ===================================================================
        logger.info(f"🔧 Config: STT={session.stt_language} | TTS={session.tts_language_code} | Speaker={session.tts_speaker}")

        agent_session = AgentSession(
            stt=deepgram.STT(
                model="nova-3",
                language=session.stt_language,
                detect_language=False,
                interim_results=True,
            ),
            llm=google.LLM(
                model="gemini-2.5-flash",
                temperature=0.4,
            ),
            tts=sarvam.TTS(
                model="bulbul:v3",
                target_language_code=session.tts_language_code,
                speaker=session.tts_speaker,
                pace=1.01,
                speech_sample_rate=22050,
                enable_preprocessing=True,
            ),
            vad=vad,
            userdata={"session": session},
        )

        # ===================================================================
        # Transcript Capture
        # ===================================================================
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
                # item.content is a LIST
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

        # ===================================================================
        # Start Session
        # ===================================================================
        # ✅ Store agent_session reference for clean shutdown in save_and_disconnect
        session.agent_session = agent_session

        await agent_session.start(
            room=ctx.room,
            agent=LoanEnquiryAgent(session),
        )

        logger.info("✅ Session started with production settings")

        # ✅ Await recording start with error handling
        try:
            await session.start_recording()
            logger.info("🎙️ Recording started successfully")
        except Exception as e:
            logger.error(f"❌ Recording start failed: {e}")
            # Continue anyway - recording is optional

        # Small delay for audio to stabilize
        await asyncio.sleep(0.3)

        try:
            # ===================================================================
            # DIRECT SPLIT GREETING TO BYPASS LIVEKIT'S 3s AEC DELAY
            # ===================================================================
            logger.info("🔊 Triggering hardcoded split greeting")

            # Order: 1) Intro  2) Recording disclaimer  3) Identity check
            if session.language == "english":
                part1 = f"Hello, this is {session.agent_name} calling from Pusad Urban Bank. This call is being recorded for security and quality purposes."
                part2 = f"Am I speaking with {session.customer_name}?"
            elif session.language == "marathi":
                bolte = "बोलतेय" if session.gender == "female" else "बोलतोय"
                part1 = f"नमस्कार, मी {session.agent_name}, पुसद अर्बन बँक मधून {bolte}. ही कॉल सुरक्षेसाठी रेकॉर्ड केली जात आहे."
                part2 = f"मी {session.customer_name} जींशी बोलतोय का?"
            else:  # Hindi
                bol = "रही" if session.gender == "female" else "रहा"
                part1 = f"Hello, मैं {session.agent_name} बोल {bol} हूँ पुसद अर्बन बैंक से। यह कॉल सुरक्षा के लिए रिकॉर्ड की जा रही है।"
                part2 = f"क्या मेरी बात {session.customer_name} जी से हो रही है?"

            # Say intro+disclaimer first (non-interruptible, covers AEC warmup)
            handle1 = agent_session.say(
                part1,
                allow_interruptions=False,
                add_to_chat_ctx=False,
            )
            await handle1

            await asyncio.sleep(0.4)

            # Identity check (interruptible — customer may respond)
            handle2 = agent_session.say(
                part2,
                allow_interruptions=True,
                add_to_chat_ctx=False,
            )
            await handle2
        except Exception as e:
            logger.warning(f"⚠️ Greeting failed: {e}")

        # ===================================================================
        # Silence Monitor (hang up after 30s silence)
        # ===================================================================
        async def silence_monitor():
            while not session.call_ended:
                await asyncio.sleep(5)
                time_since_last_speech = asyncio.get_event_loop().time() - session.last_speech_time

                if time_since_last_speech > 30 and not session.call_ended:
                    logger.warning("🕒 Over 30s silence detected. Hanging up.")
                    if session.agent_session:
                        try:
                            farewell = {
                                "hindi": "लगता है आप अभी व्यस्त हैं, धन्यवाद।",
                                "marathi": "तुम्ही व्यस्त आहात असे वाटते, धन्यवाद.",
                                "english": "It seems you are busy right now, thank you.",
                            }.get(session.language, "Thank you!")
                            await session.agent_session.say(farewell)

                            # Give TTS a moment, then save and disconnect
                            await asyncio.sleep(3.0)
                            session.call_outcome = "silence_timeout"
                            await session.save_and_disconnect(delay=0)
                        except Exception as e:
                            logger.error(f"Error triggering silence end_call: {e}")
                            session.call_outcome = "silence_timeout"
                            await session.save_and_disconnect(delay=3.0)
                    break

        # ✅ Store task reference for cancellation
        session.silence_monitor_task = asyncio.create_task(silence_monitor())

        # ===================================================================
        # Safety Timeout (3 minutes max)
        # ===================================================================
        async def safety_timeout():
            await asyncio.sleep(180)
            if not session.call_ended:
                logger.warning("⚠️ SAFETY TIMEOUT: 180s exceeded")
                session.call_outcome = "safety_timeout"
                await session.save_and_disconnect(delay=0)

        # ✅ Store task reference for cancellation
        session.safety_timeout_task = asyncio.create_task(safety_timeout())

    except Exception as e:
        logger.error(f"❌ CRITICAL ERROR in entrypoint: {e}", exc_info=True)
        # Always try to save transcript on error
        if session and not session.call_ended:
            logger.info("📤 Saving transcript after error...")
            try:
                await session.save_and_disconnect(delay=0)
            except Exception as e2:
                logger.error(f"❌ Save after error also failed: {e2}")
    except BaseException as e:
        # Catch DuplexClosed, CancelledError, etc.
        logger.error(f"❌ AGENT CRASH (BaseException): {type(e).__name__}: {e}")
        if session and not session.call_ended:
            logger.info("📤 Emergency transcript save...")
            try:
                session.call_ended = True
                await session._send_transcript()
            except Exception as e2:
                logger.error(f"❌ Emergency save failed: {e2}")

    finally:
        # ✅ Wait for shutdown event if session was created
        if session:
            logger.info("⏳ Waiting for transcript save to complete...")
            try:
                # Wait for clean shutdown without timeout to prevent premature call cuts
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
                    agent_name="pusad-bank-loan-enquiry-enhanced",
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
