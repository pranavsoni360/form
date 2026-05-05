import os
import pytz

BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8002")
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


UNION_BANK_NAME = "Union Bank of India"


def normalize_mobile(mobile: str) -> str:
    mobile = mobile.strip()
    if mobile.startswith("+91"):
        return mobile[3:]
    if mobile.startswith("91") and len(mobile) == 12:
        return mobile[2:]
    return mobile
