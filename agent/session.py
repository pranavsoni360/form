import asyncio
import logging
import os
from datetime import datetime

import aiohttp
from livekit.api import DeleteRoomRequest, LiveKitAPI
from livekit.protocol.egress import RoomCompositeEgressRequest, EncodedFileOutput, StopEgressRequest

from config import IST, LANG_CONFIG, GENDER_CONFIG, normalize_mobile, BACKEND_URL

logger = logging.getLogger("loan-enquiry-agent")


def now_ist() -> str:
    return datetime.now(IST).strftime("%b %d, %Y %I:%M %p")


class CustomerType:
    EXISTING = "existing"
    NEW = "new"


class LoanEnquirySession:
    def __init__(self, job_ctx, metadata: dict):
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
        self.agent_purpose   = metadata.get("agent_purpose", "loan_enquiry")
        self.bank_name       = metadata.get("bank_name", "Pusad Urban Bank")

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

        self.initial_deposit = None

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
            f"Session: {self.customer_name} | Type: {self.customer_type.upper()} | "
            f"Lang: {self.language} | Memory: {'YES' if self.memory else 'NO'}"
        )

    def add_user_message(self, text: str):
        self.last_speech_time = asyncio.get_event_loop().time()
        if not text or not text.strip():
            return
        self.transcript.append({"role": "user", "text": text.strip(), "timestamp": now_ist()})
        logger.info(f"USER: {text}")

    def add_agent_message(self, text: str):
        self.last_speech_time = asyncio.get_event_loop().time()
        if not text or not text.strip():
            return
        self.transcript.append({"role": "agent", "text": text.strip(), "timestamp": now_ist()})
        logger.info(f"AGENT: {text}")

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
            "account_type": "account_type",
            "initial_deposit": "initial_deposit",
        }
        attr = mapping.get(field.lower().strip())
        if attr:
            setattr(self, attr, value)
            logger.info(f"Collected: {attr} = {value}")
        else:
            logger.warning(f"Unknown collect_data field: {field}")

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
                logger.info(f"Recording started: {self.egress_id}")
            finally:
                await api.aclose()
        except Exception as e:
            logger.error(f"Recording failed: {e}")

    # ===================================================================
    # Graceful disconnect
    # ===================================================================
    async def save_and_disconnect(self, delay: float = 2.0):
        if self.call_ended:
            logger.warning("Call already ended, skipping")
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
                logger.info("Office ambience stopped")
            except Exception as e:
                logger.warning(f"Background audio close failed: {e}")

        logger.info(f"Ending call in {delay}s...")
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
                    await asyncio.wait_for(
                        lk_api.egress.stop_egress(StopEgressRequest(egress_id=self.egress_id)),
                        timeout=5.0,
                    )
                    logger.info("Recording stopped")
                except asyncio.TimeoutError:
                    logger.warning("Egress stop timed out (5s)")
                finally:
                    await lk_api.aclose()
            except Exception as e:
                logger.warning(f"Recording stop failed: {e}")

        try:
            await self.job_ctx.api.room.delete_room(DeleteRoomRequest(room=self.room_name))
            logger.info("Room deleted")
        except Exception as e:
            logger.error(f"Room delete failed: {e}")
        finally:
            self.shutdown_event.set()

    # ===================================================================
    # Transcript save (idempotent)
    # ===================================================================
    async def _send_transcript(self):
        if self.transcript_sent:
            logger.info("Transcript already sent, skipping duplicate POST")
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
            "account_type": self.account_type,
            "initial_deposit": self.initial_deposit,
        }

        logger.info(
            f"Sending transcript to {BACKEND_URL}/api/agent/transcript | "
            f"call_id={self.call_id}, msgs={len(self.transcript)}"
        )
        if not self.transcript:
            logger.warning(f"Sending EMPTY transcript for {self.room_name}")

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
                            logger.info(f"Transcript saved ({len(self.transcript)} messages) | {data}")
                            return
                        body = await resp.text()
                        logger.error(f"Transcript save returned {resp.status}: {body}")
            except Exception as e:
                logger.error(f"Transcript save failed (attempt {attempt+1}/3): {e}")
                if attempt < 2:
                    await asyncio.sleep(1.0)

        logger.error(f"CRITICAL: All 3 transcript save attempts failed for {self.room_name}")
