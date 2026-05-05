import asyncio
import logging
from datetime import datetime

from config import IST, LANG_CONFIG, GENDER_CONFIG, normalize_mobile

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
        }
        attr = mapping.get(field.lower().strip())
        if attr:
            setattr(self, attr, value)
            logger.info(f"Collected: {attr} = {value}")
        else:
            logger.warning(f"Unknown collect_data field: {field}")
