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
from datetime import datetime, timedelta
import pytz
from dotenv import load_dotenv

from livekit import agents, rtc
from livekit.agents import JobContext, WorkerOptions, cli, function_tool, RunContext
from livekit.agents.voice import AgentSession, Agent
from livekit.plugins import deepgram, silero, sarvam, google
from livekit.api import DeleteRoomRequest, LiveKitAPI
from livekit.protocol.egress import RoomCompositeEgressRequest, EncodedFileOutput

# Optional: background office ambience (available in recent livekit-agents)
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
        self.bg_audio = None               # ✅ BackgroundAudioPlayer handle
        self.safety_timeout_task = None    # ✅ Store task reference for cancellation
        self.silence_monitor_task = None   # ✅ Store task reference for cancellation
        self.shutdown_event = asyncio.Event()  # ✅ Event to signal process shutdown
        self.transcript_sent = False           # ✅ Idempotent guard for transcript POST
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
        self.qualification = None    # ✅ educational qualification
        self.designation = None
        self.sector = None           # ✅ auto-inferred from designation
        self.working_experience = None  # ✅ years of experience
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
            "qualification":   "qualification",
            "designation":     "designation",
            "sector":          "sector",
            "working_experience": "working_experience",
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
        """Start recording with a short delay for audio stabilization"""
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

        # ✅ Stop office ambience
        if self.bg_audio:
            try:
                await self.bg_audio.aclose()
                logger.info("🏢 Office ambience stopped")
            except Exception as e:
                logger.warning(f"⚠️ Background audio close failed: {e}")

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
        # Idempotent — never send twice. Both save_and_disconnect (normal flow) and
        # the JobContext shutdown callback (user-hangup race) call this; whichever
        # wins first sets the flag and the other becomes a no-op.
        if self.transcript_sent:
            logger.info("📤 Transcript already sent, skipping duplicate POST")
            return
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
            "qualification": self.qualification,        # ✅ NEW
            "designation": self.designation,
            "sector": self.sector,                      # ✅ NEW
            "working_experience": self.working_experience,  # ✅ NEW
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
                            self.transcript_sent = True
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

    # Send WhatsApp form link if customer was interested
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

    # Schedule graceful disconnect with extra time for final speech
    asyncio.create_task(session.save_and_disconnect(delay=8.0))

    # ✅ CRITICAL: Return explicit stop instruction to LLM
    # This is the tool result seen by the LLM, NOT spoken via TTS directly.
    # An empty string caused the LLM to generate extra speech.
    return "SUCCESS: User hanging up. Stop generating anything."


@function_tool(
    name="schedule_callback",
    description=(
        "Schedule a callback when the customer says they are busy / asks to be "
        "called later. Pass an ISO 8601 datetime in IST (e.g. '2026-04-30T10:00:00+05:30'). "
        "Resolve relative phrases like 'कल सुबह 10 बजे', 'शाम 5 बजे', 'Sunday' from the "
        "current IST time given in your context. After this returns, say a short polite "
        "confirmation (e.g. 'ठीक है, उस समय call करूँगा/करूँगी') and then call end_call('user_busy')."
    ),
)
async def schedule_callback(context: RunContext, callback_iso: str, reason: str = "user_busy") -> str:
    """
    Args:
        callback_iso: ISO 8601 datetime in IST when the customer is available.
        reason: one of user_busy, in_meeting, traveling, will_call_later (free text OK).
    """
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
    name="collect_data",
    description=(
        "Silently save a SINGLE detail the customer just shared. "
        "Use ONLY for one-off mid-conversation corrections or re-captures. "
        "For saving all details together at the end of the Q&A, prefer collect_all_data instead. "
        "Never tell the customer you are saving data."
    ),
)
async def collect_data(context: RunContext, field: str, value: str) -> str:
    """
    Args:
        field: age | loan_type | loan_amount | loan_purpose | employment_type |
               employer_name | qualification | designation | sector |
               working_experience | existing_emi | business_type | business_age |
               monthly_turnover | address
        value: what the customer said, as a string
    """
    session: LoanEnquirySession = context.userdata["session"]
    session.update_collected_data(field, value)
    return "ok"


@function_tool(
    name="collect_all_data",
    description=(
        "Save ALL collected customer details in one single call — call this ONCE, "
        "right before calling send_form_link or end_call, after all questions are answered. "
        "Pass only the fields that were actually collected; leave the rest as empty string. "
        "This replaces calling collect_data repeatedly and avoids response latency during Q&A."
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
    loan_amount: str = "",
    loan_type: str = "",
    loan_purpose: str = "",
    business_type: str = "",
    business_age: str = "",
    monthly_turnover: str = "",
    address: str = "",
) -> str:
    """Batch-save all qualification data collected during the call in one tool call."""
    session: LoanEnquirySession = context.userdata["session"]
    fields = {
        "age": age,
        "employment_type": employment_type,
        "employer_name": employer_name,
        "qualification": qualification,
        "designation": designation,
        "sector": sector,
        "working_experience": working_experience,
        "existing_emi": existing_emi,
        "loan_amount": loan_amount,
        "loan_type": loan_type,
        "loan_purpose": loan_purpose,
        "business_type": business_type,
        "business_age": business_age,
        "monthly_turnover": monthly_turnover,
        "address": address,
    }
    for field, value in fields.items():
        if value and value.strip():
            session.update_collected_data(field, value)
    logger.info(f"📦 collect_all_data: saved {sum(1 for v in fields.values() if v and v.strip())} fields in one shot")
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


SECTOR_INFERENCE_GUIDE = """
SECTOR auto-mapping (use the customer's job/designation to silently fill sector — never ask):
- Software Engineer / Developer / Programmer / DevOps / QA Engineer / Data Scientist / SDE → IT
- Bank Clerk / Bank Officer / Cashier / Teller / Loan Officer / Branch Manager → Banking
- Nurse / Doctor / Pharmacist / Lab Technician / Hospital staff / Compounder → Healthcare
- Teacher / Professor / Lecturer / Principal / Tutor / Headmaster → Education
- Police / Defence / Soldier / Government clerk / Tehsildar / Patwari / Postman / Railway employee → Government
- Farmer / Krishi / खेती / Dairy / Poultry / Agriculture worker → Agriculture
- Shopkeeper / Dukandar / Kirana / Retailer / Salesperson / Showroom staff → Retail
- Mechanic / Electrician / Plumber / Carpenter / Welder / Factory worker / Operator / Fitter → Manufacturing
- Driver / Auto-rickshaw / Truck driver / Tempo / Cab driver / Transport → Transportation
- Accountant / CA / CS / Auditor / Tax consultant / Financial Advisor / Insurance agent → Finance
- Construction worker / Mason / राजमिस्त्री / Contractor / Civil engineer (site) → Construction
- Hotel / Restaurant / Chef / Waiter / Cook / Caterer → Hospitality
- Tailor / Boutique / Beautician / Barber / Salon → Services
- Lawyer / Advocate / Vakil / Notary → Legal
- Self-employed / Business owner / Trader / Wholesaler → use customer's business_type if known, else Business
"""


def build_loan_enquiry_instructions(session: LoanEnquirySession) -> str:

    memory_block = f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🧠 RAG MEMORY (PAST CALL DETAILS)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n{session.memory}\n" if session.memory else ""

    # Time context for the LLM so it can resolve "कल सुबह 10 बजे" → ISO datetime.
    # Working hours come from backend env (default 10 AM – midnight IST).
    _now_ist = datetime.now(IST)
    time_context = (
        f"CURRENT TIME (IST): {_now_ist.strftime('%A, %d %b %Y, %I:%M %p')} | "
        f"Today's date: {_now_ist.strftime('%Y-%m-%d')} | "
        f"Working hours: 10:00 - 24:00 IST (कॉल सिर्फ इस window में होते हैं)"
    )

    # Common rules — kept short & directive so the LLM doesn't pad replies
    COMMON_RULES = f"""
RULES (पालन ज़रूरी):
0. CUSTOMER GENDER — ग्राहक के नाम ({session.customer_name}) और आवाज़ से gender infer करो (Indian male: Adil, Rohan, Suresh, Vikram, Amit, etc.; female: Priya, Pooja, Tanvi, Sneha, Ananya, etc.; ambiguous तो आवाज़ से judge करो)। Conversation में सही gendered forms use करो:
   • HINDI — Male customer: "आप क्या काम करते हैं?", "आपका नाम", "आपके पास", "उन्होंने बताया"। Female customer: "आप क्या काम करती हैं?", "आपका नाम" (same), "आपके पास" (same), "उन्होंने बताया" (same — honorific plural is gender-neutral in तीसरा purush)। Verb conjugation MAIN difference: "करते/करती", "रहते/रहती", "जानते/जानती", "बताते/बताती"।
   • MARATHI — Male: "तुम्ही काय करता?", "तुम्हाला". Female: "तुम्ही काय करता?" (formal Marathi "तुम्ही" same for both). Address: "साहेब" (male) / "मॅडम" (female)।
   • ENGLISH — Male: "Sir", "his", "he". Female: "Ma'am", "her", "she"।
   अगर gender clear नहीं तो safe neutral form use करो ("आप क्या काम करते हैं?" default)। एक बार आवाज़ सुनकर gender confirm हो जाए तो उस पर consistent रहो — call के बीच मत बदलो।
1. हर response 1 छोटा वाक्य। 12 शब्दों से कम।
2. एक बार में सिर्फ एक सवाल। बार-बार "जी", "अच्छा", "नोट कर लिया" मत बोलो — 4 में से 1 बार OK।
3. ग्राहक के हर जवाब पर तुरंत collect_data(field, value) चुपचाप call करो। Tool नाम कभी मत बोलो।
4. Designation/employer सुनकर sector खुद infer करो (नीचे SECTOR table) — कभी मत पूछो।
5. ग्राहक "नहीं" बोले या interest नहीं — तुरंत polite goodbye फिर end_call("not_interested")। बहस मत करो।
6. Form भेजने के बाद end_call("interested")। goodbye एक छोटी line: "धन्यवाद {session.customer_name} जी।"
7. end_call() के बाद कुछ मत बोलो। STOP.
8. TTS: कोई emoji नहीं, कोई — (em-dash) नहीं, कोई empty line नहीं। सिर्फ ?, .।
9. RAG MEMORY available है तो past context use करो — पहले से collected info दोबारा मत पूछो।

12. BUSY / CALLBACK HANDLING:
    Customer कहे "अभी busy हूँ", "बाद में call करो", "अभी time नहीं है", "meeting में हूँ", "drive कर रहा हूँ", "नहीं अभी नहीं" — तुरंत polite होकर पूछो: "कोई बात नहीं। कब call करूँ — आपको कब suitable होगा?" (एक छोटा वाक्य)।
    Customer का जवाब सुनो (e.g. "कल सुबह 10 बजे", "शाम 5 बजे", "Sunday", "2 बजे")।
    Resolve to ISO 8601 IST format using {time_context.split('|')[0].strip()}:
      - "कल सुबह 10 बजे" → tomorrow 10:00 → e.g. "{(_now_ist + timedelta(days=1)).strftime('%Y-%m-%d')}T10:00:00+05:30"
      - "शाम 5 बजे" / "5 बजे" → today 17:00 if before 17:00, else tomorrow 17:00
      - "Sunday" → next Sunday 10:00
      - कुछ unclear / customer ने clear time नहीं दिया → "कल सुबह 10 बजे" default लो।
    Working hours 10:00-24:00 IST के बाहर हो तो backend automatically clamp कर देगा — आप बस नज़दीकी time दो।
    फिर तुरंत schedule_callback(callback_iso=<ISO>, reason="user_busy") tool call करो।
    Tool succeed होने पर एक छोटी polite line कहो: "ठीक है, मैं उस समय call करूँगा/करूँगी। धन्यवाद {session.customer_name} जी।" फिर end_call("user_busy")।
    अगर customer specific time देने से मना करे ("बाद में बता दूँगा") → "ठीक है, कल फिर try करूँगा/करूँगी" → schedule_callback कल 10 AM के लिए → end_call("user_busy")।
10. OFF-TOPIC HANDLING: ग्राहक loan के अलावा कुछ पूछे (मौसम, news, account balance, FD rate, branch timing, खुद के बारे में, random चर्चा, joke, etc.) — एक छोटी polite line में deflect करो फिर तुरंत वही question repeat करो जिस पर रुके थे। Examples:
   - Customer: "आज मौसम कैसा है?" → "उसकी जानकारी मेरे पास नहीं है। आपकी उम्र क्या है?"
   - Customer: "मेरा account balance बताओ?" → "Balance के लिए हमारी customer care team से बात करें। फिलहाल loan के लिए — कितने साल का experience है?"
   - Customer: "तुम कौन हो / AI हो?" → "मैं {session.agent_name}, पुसद बैंक की loan assistant। आपकी qualifications क्या हैं?"
   कभी debate मत करो, कभी off-topic answer मत दो, कभी lecture मत दो — सिर्फ acknowledge + redirect।

11. SERIOUS-PROSPECT DETECTION (बहुत important — calmly और politely handle करो):
    Time-waster signals (इनमें से 2 दिखें तो customer serious नहीं है):
    a. लगातार off-topic जवाब, हँसी-मज़ाक, "हा हा", "तू बता ना", "तुम क्या करती हो" जैसे flirt/joke
    b. सवाल का सीधा जवाब टाल रहा है (3 बार vague: "अरे यार", "सोचेंगे", "बाद में बताऊँगा", "क्या फरक पड़ता है")
    c. गिबरिश, contradictions, या दूसरे काम कर रहा (TV chal raha, आसपास से बोल रहा "अभी busy हूँ रुक")
    d. Loan की baat ही नहीं कर रहा — सिर्फ general बात, gossip, या आपको परख रहा है
    e. Customer "मज़ाक कर रहा हूँ", "टाइम पास", "बस ऐसे ही" जैसी कोई admission

    जब signal दिखे — पहली बार: 1 calm polite redirect (Rule 10)। दूसरी बार signal दिखे → respectful, customer-first tone में पूछो (कभी threatening या "call end करूँ" मत बोलो — disrespectful लगता है)। इन में से कोई एक line use करो:
    - "क्या आप वाकई loan के बारे में जानकारी लेना चाहते हैं? आपका समय कीमती है।"
    - "अगर अभी सही समय नहीं है तो कोई बात नहीं, बाद में call कर लूँगा/लूँगी।"
    - "मैं समझ सकता/सकती हूँ — क्या loan में आपकी अभी interest है, या किसी और समय बात करें?"

    फिर customer के जवाब पर:
    - "हाँ interested हूँ / continue करो / sorry जी" → सीधा अगले question पर वापस। कोई lecture नहीं।
    - "नहीं / interest नहीं / मज़ाक कर रहा था" → "कोई बात नहीं, धन्यवाद {session.customer_name} जी।" → end_call("not_interested")।
    - "बाद में / अभी busy / फिर बात करेंगे" → "बिल्कुल, फिर कभी connect करते हैं। धन्यवाद {session.customer_name} जी।" → end_call("user_busy")।
    - फिर भी टाल-मटोल → "ठीक है, धन्यवाद {session.customer_name} जी।" → end_call("user_busy") (silently end, कोई accusation नहीं)।

    Tone: सख्त नहीं, judge मत करो, सिर्फ professional और शांत — जैसे एक senior banker time-waster को gracefully exit देता है। आवाज़ में irritation बिल्कुल मत आए।
"""

    if session.customer_type == CustomerType.EXISTING:
        return f"""ROLE: {session.agent_name}, पुसद अर्बन बैंक का loan specialist। मौजूदा valued customer से बात।
DATA: Customer:{session.customer_name} | EXISTING
{time_context}{memory_block}

⚠️ Disclaimer + पहचान पहले हो चुकी है। सीधे step 1 से शुरू।

FLOW (छोटे वाक्यों में):
1. "आप हमारे valued customer हैं। Business, Personal, या Education loan लेना चाहेंगे?"
2. हाँ बोले तो — एक line में rates: Education 8.5-10.5% / Business 10-13% / Personal 11-14.5%।
3. Interest confirm होते ही: "बस कुछ छोटे सवाल पूछने हैं, फिर WhatsApp पर form।"
4. एक-एक करके पूछो (हर जवाब पर तुरंत collect_data चुपचाप call करो):
   Q1: "आपकी उम्र क्या है?" → collect_data("age", value)
   Q2: "आप क्या काम करते हैं और किस कंपनी में?" — एक ही सवाल। जवाब से तीनों निकालो: collect_data("designation", role); collect_data("employer_name", company); sector खुद infer करके collect_data("sector", inferred)। Sector कभी मत पूछो।
   Q3: "आपकी qualifications क्या हैं?" → collect_data("qualification", value)
   Q4: "कितने साल का experience है?" → collect_data("working_experience", value)
   Q5: "कोई existing loan या EMI चल रही है?" → collect_data("existing_emi", value)
   Q6: "लोन किस purpose के लिए चाहिए?" → collect_data("loan_purpose", value)
   Q7: "कितना loan amount चाहिए?" → collect_data("loan_amount", value); loan_type भी collect_data करो।
   Q8: "क्या यही number आपका WhatsApp number है?" — हाँ → collect_data("whatsapp_same", "yes")। नहीं तो "WhatsApp number बताइए" → collect_data("whatsapp_number", value)।
5. "आप पात्र हैं। WhatsApp पर form भेज दूँ?" → हाँ → send_form_link → "form link भेज दिया है।"
6. "धन्यवाद {session.customer_name} जी।" → end_call("interested")।
{COMMON_RULES}
{SECTOR_INFERENCE_GUIDE}"""

    else:  # नया ग्राहक
        return f"""ROLE: {session.agent_name}, पुसद अर्बन बैंक का loan specialist। नया ग्राहक।
DATA: Customer:{session.customer_name} | NEW
{time_context}{memory_block}

⚠️ Disclaimer + पहचान पहले हो चुकी है। नाम दोबारा मत पूछो।

LOAN ELIGIBILITY (नए ग्राहकों को clearly बताओ):
   Education: 50K-20L | 8.5-10.5% | 15Y | पढ़ाई में EMI नहीं | admission letter ज़रूरी
   Business: 1L-50L | 10-13% | 7Y | business 2+ साल पुराना | GST registration preferred
   Personal: 50K-10L | 11-14.5% | 5Y | min ₹25,000/month salary | 6 महीने job stability ज़रूरी

FLOW (छोटे वाक्यों में):
1. "पुसद अर्बन बैंक 30 साल से Vidarbha में service दे रहा है। Business, Personal, या Education loan में interest है?"
2. हाँ बोले तो eligibility एक line में बताओ (ऊपर देखो)।
3. Interest confirm: "बस कुछ छोटे सवाल, फिर WhatsApp पर form।"
4. एक-एक करके पूछो (हर जवाब पर तुरंत collect_data चुपचाप call करो):
   Q1: "आपकी उम्र क्या है?" → collect_data("age", value)
   Q2: "आप क्या काम करते हैं और किस कंपनी में?" — एक ही सवाल। जवाब से तीनों निकालो: collect_data("designation", role); collect_data("employer_name", company); sector खुद infer करके collect_data("sector", inferred)। Sector कभी मत पूछो।
   Q3: "आपकी qualifications क्या हैं?" → collect_data("qualification", value)
   Q4: "कितने साल का experience है?" → collect_data("working_experience", value)
   Q5: "कोई existing loan या EMI चल रही है?" → collect_data("existing_emi", value)
   Q6: "लोन किस purpose के लिए चाहिए?" → collect_data("loan_purpose", value)
   Q7: "कितना loan amount चाहिए?" → collect_data("loan_amount", value); loan_type भी collect_data करो।
   Q8: "क्या यही number आपका WhatsApp number है?" — हाँ → collect_data("whatsapp_same", "yes")। नहीं तो "WhatsApp number बताइए" → collect_data("whatsapp_number", value)।
5. "आप पात्र हैं। WhatsApp पर form भेज दूँ?" → हाँ → send_form_link → "form link भेज दिया है।"
6. "धन्यवाद {session.customer_name} जी।" → end_call("interested")।
{COMMON_RULES}
{SECTOR_INFERENCE_GUIDE}"""


# ===================================================================
# AGENT
# ===================================================================

class LoanEnquiryAgent(Agent):
    def __init__(self, session: LoanEnquirySession):
        super().__init__(
            instructions=build_loan_enquiry_instructions(session),
            tools=[send_form_link, end_call, collect_data, collect_all_data, schedule_callback],
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

        # CRITICAL: register transcript flush as a JobContext shutdown callback.
        # If the customer hangs up, livekit-agents tears the worker down and any
        # asyncio.create_task we scheduled in participant_disconnected may be
        # cancelled mid-HTTP. Shutdown callbacks are awaited by the framework
        # before the process exits, guaranteeing transcript delivery.
        # _send_transcript is idempotent (transcript_sent flag), so coexisting
        # with the normal save_and_disconnect path is safe.
        async def _flush_transcript_on_shutdown():
            try:
                await session._send_transcript()
            except Exception as e:
                logger.error(f"❌ Shutdown-callback transcript flush failed: {e}")

        ctx.add_shutdown_callback(_flush_transcript_on_shutdown)

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
            if session is not None and not session.call_ended:
                logger.info("📤 Customer hung up - saving transcript...")
                # delay=0: no point waiting, customer is gone. Shutdown-callback
                # will also flush transcript if this task gets cancelled.
                asyncio.create_task(session.save_and_disconnect(delay=0))

        # Brief delay for call stabilization (tuned down for latency)
        await asyncio.sleep(0.2)

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
            # Start LLM generation as soon as final STT arrives, before VAD end-of-speech.
            # Biggest single latency win — trims 300–700ms off turn response.
            preemptive_generation=True,
            # Default min_endpointing_delay is 0.5s, far too long for natural phone
            # conversation. Drop to 0.2s — agent starts responding ~300ms sooner.
            min_endpointing_delay=0.2,
            max_endpointing_delay=2.5,
            # User can interrupt with a short word (3 letters) — feels human.
            min_interruption_duration=0.3,
            discard_audio_if_uninterruptible=True,
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

        # ✅ Fire recording in the background — don't block the greeting.
        # Saves ~1s on time-to-first-word. First ~0.3s of audio may be missed.
        asyncio.create_task(session.start_recording())

        # ✅ Start subtle office ambience so the call feels like a real bank call centre.
        # Low volume so it doesn't interfere with TTS clarity.
        bg_audio = None
        if _BACKGROUND_AUDIO_AVAILABLE:
            try:
                bg_audio = BackgroundAudioPlayer(
                    ambient_sound=AudioConfig(BuiltinAudioClip.OFFICE_AMBIENCE, volume=0.18),
                )
                await bg_audio.start(room=ctx.room, agent_session=agent_session)
                logger.info("🏢 Office ambience started")
            except Exception as e:
                logger.warning(f"⚠️ Background audio failed (non-critical): {e}")
                bg_audio = None
        session.bg_audio = bg_audio  # keep reference for cleanup

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

            # Short natural pause between sentences (was 0.4s).
            await asyncio.sleep(0.2)

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
        # Silence Monitor (hang up after 20s silence — was 30s)
        # ===================================================================
        async def silence_monitor():
            while not session.call_ended:
                await asyncio.sleep(5)
                time_since_last_speech = asyncio.get_event_loop().time() - session.last_speech_time

                if time_since_last_speech > 20 and not session.call_ended:
                    logger.warning("🕒 Over 20s silence detected. Hanging up.")
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
        # Safety Timeout (2 minutes max — calls should be ~90s with 5 questions)
        # ===================================================================
        async def safety_timeout():
            await asyncio.sleep(120)
            if not session.call_ended:
                logger.warning("⚠️ SAFETY TIMEOUT: 120s exceeded — force-ending stuck call")
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