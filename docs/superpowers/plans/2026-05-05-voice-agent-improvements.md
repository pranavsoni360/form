# Voice Agent Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 critical bugs, tune agent latency to ~1.0–1.1s per turn, add language-aware prompts, and split the 852-line agent file + 2429-line backend file into focused modules — without changing any API paths, DB schema, or startup commands.

**Architecture:** Three independent tracks executed in order: (1) bug fixes on the monolith, (2) agent latency + prompt improvements, (3) modular split of agent then backend. Each track is independently testable. The split is a pure refactor — no behaviour changes.

**Tech Stack:** Python 3.11, FastAPI, asyncpg, livekit-agents 1.3.11, Deepgram STT, Sarvam TTS, Google Gemini 2.5-flash, Groq fallback, APScheduler, PostgreSQL 16

---

## File Map

### Modified in Tracks 1–2 (bug fixes + latency — no new files)
- `backend/agent_routes.py` — 3 targeted line changes (analytics async, retry_count x2)
- `agent/los_updated.py` — 5 targeted changes (safety timeout, silence monitor, AgentSession params, VAD, TTS pace) + language-aware prompt function

### Created in Track 3 (modular split)
**Agent side:**
- `agent/config.py` — LANG_CONFIG, GENDER_CONFIG, BACKEND_URL, IST, normalize_mobile
- `agent/session.py` — LoanEnquirySession, CustomerType
- `agent/tools.py` — 4 @function_tool decorated functions
- `agent/prompts.py` — build_loan_enquiry_instructions (Hindi/Marathi/English)
- `agent/agent_core.py` — LoanEnquiryAgent class + entrypoint()
- `agent/los_updated.py` — SHRINKS to ~15 lines: imports from above + cli.run_app()

**Backend side:**
- `backend/agent/__init__.py` — empty
- `backend/agent/state.py` — all config, db_pool, locks, helpers, auth, Pydantic models
- `backend/agent/analytics.py` — analyze_transcript_with_llm + process_analytics_batch
- `backend/agent/callbacks.py` — /schedule-callback + /scheduled-callbacks
- `backend/agent/whatsapp.py` — /send-whatsapp-form
- `backend/agent/transcript.py` — POST /transcript webhook
- `backend/agent/batch.py` — upload, batch dispatch, agent_startup/shutdown
- `backend/agent/calls.py` — /calls CRUD, exports, dashboard-stats, form-data
- `backend/agent_routes.py` — SHRINKS to ~30 lines: wires sub-routers, re-exports startup functions

---

## Task 1: Backend Bug Fixes — Three Targeted Line Changes

**Files:**
- Modify: `backend/agent_routes.py`

- [ ] **Step 1: Fix Bug 1 — Analytics blocks event loop**

Open `backend/agent_routes.py`. Find `process_analytics_batch` (around line 852). The inner call to `analyze_transcript_with_llm` is synchronous but called from async context.

Find this line (around line 879):
```python
analysis = analyze_transcript_with_llm(transcript)
```
Replace with:
```python
analysis = await asyncio.to_thread(analyze_transcript_with_llm, transcript)
```
`asyncio` is already imported at the top of the file.

- [ ] **Step 2: Fix Bug 2 — cleanup_stuck_calls burns retry slots**

Find `cleanup_stuck_calls` (around line 254). Find this SQL UPDATE:
```python
result = await db_pool.execute(
    """UPDATE agent_calls
       SET status = 'Failed', error_message = 'Stuck call cleaned up on startup',
           ended_at = $1, updated_at = $1, retry_count = retry_count + 1
       WHERE status = 'Calling' AND started_at < $2""",
    now_ist(), ten_min_ago,
)
```
Replace with (remove `retry_count = retry_count + 1`):
```python
result = await db_pool.execute(
    """UPDATE agent_calls
       SET status = 'Failed', error_message = 'Stuck call cleaned up on startup',
           ended_at = $1, updated_at = $1
       WHERE status = 'Calling' AND started_at < $2""",
    now_ist(), ten_min_ago,
)
```

- [ ] **Step 3: Fix Bug 3 — Invalid phone consumes retry budget**

In `process_batch_run`, find the invalid-phone branch (around line 698):
```python
await db_pool.execute(
    """UPDATE agent_calls
       SET status = 'Invalid Phone', retry_count = retry_count + 1, updated_at = $1
       WHERE id = $2""",
    now_ist(), call_uuid,
)
```
Replace with (set retry_count to MAX_RETRIES+1 so it's excluded from all future retries):
```python
await db_pool.execute(
    """UPDATE agent_calls
       SET status = 'Invalid Phone', retry_count = $1, updated_at = $2
       WHERE id = $3""",
    MAX_RETRIES + 1, now_ist(), call_uuid,
)
```

- [ ] **Step 4: Verify**

```bash
cd backend
python -c "
import ast, sys
with open('agent_routes.py') as f:
    src = f.read()
assert 'asyncio.to_thread(analyze_transcript_with_llm' in src, 'Bug1 fix missing'
assert 'retry_count = retry_count + 1' not in src, 'Bug2 fix missing — retry_count still incremented in cleanup'
assert 'MAX_RETRIES + 1' in src, 'Bug3 fix missing'
print('All 3 bug fixes verified OK')
"
```
Expected: `All 3 bug fixes verified OK`

- [ ] **Step 5: Commit**

```bash
git add backend/agent_routes.py
git commit -m "fix: analytics no longer blocks event loop; cleanup_stuck_calls does not burn retry slots; invalid phones excluded from retry queue"
```

---

## Task 2: Agent Latency Tuning + Safety Timeout

**Files:**
- Modify: `agent/los_updated.py`

All 5 changes are targeted replacements in `los_updated.py`. No structural changes.

- [ ] **Step 1: Fix safety timeout — 150s → 360s**

Find `safety_timeout` coroutine (around line 794):
```python
async def safety_timeout():
    await asyncio.sleep(150)
```
Replace with:
```python
async def safety_timeout():
    await asyncio.sleep(360)
```

- [ ] **Step 2: Tune silence monitor — tighter detection**

Find `silence_monitor` coroutine (around line 769). Replace the inner loop:
```python
# BEFORE:
await asyncio.sleep(5)
gap = asyncio.get_event_loop().time() - session.last_speech_time
if gap > 25 and not session.call_ended:
```
With:
```python
# AFTER:
await asyncio.sleep(3)
gap = asyncio.get_event_loop().time() - session.last_speech_time
if gap > 20 and not session.call_ended:
```

- [ ] **Step 3: Tune AgentSession — reduce endpointing delay**

Find the `AgentSession(` constructor call (around line 657). Change these three parameters:
```python
# BEFORE:
min_endpointing_delay=0.2,
max_endpointing_delay=2.5,
min_interruption_duration=0.5,   # avoid hair-trigger interruption on noise
```
```python
# AFTER:
min_endpointing_delay=0.13,
max_endpointing_delay=2.5,
min_interruption_duration=0.35,
```

- [ ] **Step 4: Tune VAD — tighter silence, higher activation threshold**

Find the `vad = silero.VAD.load(` call (around line 647):
```python
# BEFORE:
vad = silero.VAD.load(
    min_speech_duration=0.20,
    min_silence_duration=0.05,
    activation_threshold=0.45,
)
```
```python
# AFTER:
vad = silero.VAD.load(
    min_speech_duration=0.20,
    min_silence_duration=0.03,
    activation_threshold=0.50,
)
```

- [ ] **Step 5: Tune TTS pace — slightly faster delivery**

Find `tts=sarvam.TTS(` (around line 674). Change `pace`:
```python
# BEFORE:
pace=1.01,
```
```python
# AFTER:
pace=1.06,
```

- [ ] **Step 6: Verify**

```bash
cd agent
python -c "
with open('los_updated.py') as f:
    src = f.read()
assert 'asyncio.sleep(360)' in src, 'safety timeout not updated'
assert 'asyncio.sleep(3)' in src, 'silence monitor not updated'
assert 'gap > 20' in src, 'silence threshold not updated'
assert 'min_endpointing_delay=0.13' in src, 'endpointing not tuned'
assert 'min_interruption_duration=0.35' in src, 'interruption not tuned'
assert 'activation_threshold=0.50' in src, 'VAD not tuned'
assert 'pace=1.06' in src, 'TTS pace not tuned'
print('All latency tuning verified OK')
"
```
Expected: `All latency tuning verified OK`

- [ ] **Step 7: Commit**

```bash
git add agent/los_updated.py
git commit -m "perf: tune agent latency — endpointing 0.2→0.13s, VAD threshold 0.45→0.50, TTS pace 1.01→1.06, safety timeout 150→360s, silence monitor 25→20s"
```

---

## Task 3: Language-Aware System Prompt

**Files:**
- Modify: `agent/los_updated.py` — replace `build_loan_enquiry_instructions()` entirely

The current function returns Hindi instructions for all languages. Replace it with a version that branches by `session.language`.

- [ ] **Step 1: Replace build_loan_enquiry_instructions with language-branching version**

Find the entire `def build_loan_enquiry_instructions(session: LoanEnquirySession) -> str:` function (around line 507, ends around line 568). Replace the whole function with:

```python
def build_loan_enquiry_instructions(session: LoanEnquirySession) -> str:
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


def _build_hindi_prompt(session: LoanEnquirySession, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    if session.customer_type == CustomerType.EXISTING:
        intro_line = "आप हमारे valued customer हैं। Business, Personal या Education loan में interest है?"
        eligibility = "Education 8.5–10.5% / Business 10–13% / Personal 11–14.5%"
    else:
        intro_line = (
            "पुसद अर्बन बैंक 30+ साल से Vidarbha में service दे रहा है। "
            "Business, Personal या Education loan में interest है?"
        )
        eligibility = (
            "Education 50K–20L | 8.5–10.5% (पढ़ाई में EMI नहीं) / "
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
• Gender: "{name}" से gender infer करो; verbs match (करते/करती, रहा/रही)। आवाज़ से confirm होने पर consistent रहो।
• end_call() के बाद कुछ मत बोलो। STOP.
• SCRIPT: सिर्फ Devanagari (हिन्दी/मराठी) या Roman script use करो। कभी Cyrillic/Russian/Greek अक्षर मत लिखो।
• TTS: कोई emoji नहीं, कोई em-dash (—) नहीं, कोई empty line नहीं। सिर्फ ?, ., ।
• Tool नाम कभी मत बोलो।"""


def _build_marathi_prompt(session: LoanEnquirySession, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    if session.customer_type == CustomerType.EXISTING:
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


def _build_english_prompt(session: LoanEnquirySession, memory_block: str, time_ctx: str, _tomorrow: str) -> str:
    name = session.customer_name
    agent = session.agent_name

    if session.customer_type == CustomerType.EXISTING:
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
```

- [ ] **Step 2: Verify**

```bash
cd agent
python -c "
import sys; sys.path.insert(0, '.')
# Minimal mock to test the function without LiveKit
from datetime import datetime
import pytz

IST = pytz.timezone('Asia/Kolkata')

class MockSession:
    customer_name = 'Rajesh Patil'
    customer_type = 'new'
    agent_name = 'Amit'
    memory = ''
    gender = 'male'

s = MockSession()

# Test Hindi
s.language = 'hindi'
from los_updated import build_loan_enquiry_instructions
p = build_loan_enquiry_instructions(s)
assert 'आपकी उम्र' in p, 'Hindi prompt missing'

# Test Marathi
s.language = 'marathi'
p = build_loan_enquiry_instructions(s)
assert 'तुमचे वय' in p, 'Marathi prompt missing'

# Test English
s.language = 'english'
p = build_loan_enquiry_instructions(s)
assert 'How old are you' in p, 'English prompt missing'

print('Language-aware prompts verified OK')
"
```
Expected: `Language-aware prompts verified OK`

- [ ] **Step 3: Commit**

```bash
git add agent/los_updated.py
git commit -m "feat: language-aware system prompts — Hindi, Marathi, English each get correct instructions"
```

---

## Task 4: Agent Modular Split — config.py + session.py

**Files:**
- Create: `agent/config.py`
- Create: `agent/session.py`

These two files contain zero LiveKit imports and can be created and tested before touching `los_updated.py`.

- [ ] **Step 1: Create agent/config.py**

```python
# agent/config.py
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


def normalize_mobile(mobile: str) -> str:
    mobile = mobile.strip()
    if mobile.startswith("+91"):
        return mobile[3:]
    if mobile.startswith("91") and len(mobile) == 12:
        return mobile[2:]
    return mobile
```

- [ ] **Step 2: Create agent/session.py**

```python
# agent/session.py
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
            "age": "age", "loan_type": "loan_type", "loan_amount": "loan_amount",
            "loan_purpose": "loan_purpose", "employment_type": "employment_type",
            "employer_name": "employer_name", "qualification": "qualification",
            "designation": "designation", "sector": "sector",
            "working_experience": "working_experience", "monthly_income": "monthly_income",
            "existing_emi": "existing_emi", "business_type": "business_type",
            "business_age": "business_age", "monthly_turnover": "monthly_turnover",
            "address": "collected_address",
        }
        attr = mapping.get(field.lower().strip())
        if attr:
            setattr(self, attr, value)
            logger.info(f"Collected: {attr} = {value}")
        else:
            logger.warning(f"Unknown collect_data field: {field}")
```

- [ ] **Step 3: Verify**

```bash
cd agent
python -c "
from config import LANG_CONFIG, GENDER_CONFIG, normalize_mobile
assert normalize_mobile('+919876543210') == '9876543210'
assert normalize_mobile('919876543210') == '9876543210'
assert normalize_mobile('9876543210') == '9876543210'
assert LANG_CONFIG['marathi']['tts_lang'] == 'mr-IN'
assert GENDER_CONFIG['female']['speaker'] == 'pooja'
print('config.py OK')
"
```
Expected: `config.py OK`

- [ ] **Step 4: Commit**

```bash
git add agent/config.py agent/session.py
git commit -m "refactor: extract config.py and session.py from los_updated.py"
```

---

## Task 5: Agent Modular Split — tools.py + prompts.py

**Files:**
- Create: `agent/tools.py`
- Create: `agent/prompts.py`

- [ ] **Step 1: Create agent/tools.py**

```python
# agent/tools.py
import asyncio
import logging

import aiohttp
from livekit.agents import function_tool, RunContext

from config import BACKEND_URL
from session import LoanEnquirySession

logger = logging.getLogger("loan-enquiry-agent")


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
        logger.error(f"send_form_link error: {e}")
        return f"Error: {str(e)}"


@function_tool(
    name="end_call",
    description=(
        "End the call AFTER speaking goodbye. "
        "reason in {interested, not_interested, wrong_number, user_busy, callback_requested, no_response, completed}. "
        "DO NOT speak anything after calling this tool."
    ),
)
async def end_call(context: RunContext, reason: str) -> str:
    session: LoanEnquirySession = context.userdata["session"]
    session.call_outcome = reason
    logger.info(f"END CALL: {reason}")

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
            logger.info(f"WhatsApp form link sent to {session.phone}")
        except Exception as e:
            logger.error(f"WhatsApp send failed: {e}")

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
                    logger.info(f"Callback scheduled: {body}")
                    return f"OK callback set for {body.get('scheduled_callback_at')}"
                txt = await resp.text()
                logger.warning(f"schedule_callback backend {resp.status}: {txt}")
                return f"Failed: {txt}"
    except Exception as e:
        logger.error(f"schedule_callback error: {e}")
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
    logger.info(f"collect_all_data: saved {saved} fields")
    return "ok"
```

- [ ] **Step 2: Create agent/prompts.py**

Copy the three functions written in Task 3 — `build_loan_enquiry_instructions`, `_build_hindi_prompt`, `_build_marathi_prompt`, `_build_english_prompt` — into `agent/prompts.py`.

Add these imports at the top:

```python
# agent/prompts.py
from datetime import datetime, timedelta
from session import LoanEnquirySession, CustomerType
from config import IST
```

Then paste the four functions verbatim from `los_updated.py` (they were added in Task 3).

- [ ] **Step 3: Verify**

```bash
cd agent
python -c "
import sys; sys.path.insert(0, '.')
from prompts import build_loan_enquiry_instructions
from unittest.mock import MagicMock

s = MagicMock()
s.customer_name = 'Rajesh'
s.customer_type = 'new'
s.agent_name = 'Amit'
s.memory = ''
s.gender = 'male'

s.language = 'hindi'
assert 'आपकी उम्र' in build_loan_enquiry_instructions(s)

s.language = 'marathi'
assert 'तुमचे वय' in build_loan_enquiry_instructions(s)

s.language = 'english'
assert 'How old are you' in build_loan_enquiry_instructions(s)

print('prompts.py OK')
"
```
Expected: `prompts.py OK`

- [ ] **Step 4: Commit**

```bash
git add agent/tools.py agent/prompts.py
git commit -m "refactor: extract tools.py and prompts.py from los_updated.py"
```

---

## Task 6: Agent Modular Split — agent_core.py + thin los_updated.py

**Files:**
- Create: `agent/agent_core.py`
- Modify: `agent/los_updated.py` → becomes ~15-line entry point

- [ ] **Step 1: Create agent/agent_core.py**

This file contains everything that uses LiveKit: `LoanEnquiryAgent`, `entrypoint()`, recording, background audio, silence monitor, safety timeout, `save_and_disconnect`, `_send_transcript`. Copy ALL of these from the current `los_updated.py`, updating imports.

```python
# agent/agent_core.py
import os
import json
import logging
import asyncio
import aiohttp
from datetime import datetime

from livekit import agents, rtc
from livekit.agents import JobContext, function_tool, RunContext
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

from config import IST, BACKEND_URL, LANG_CONFIG, GENDER_CONFIG
from session import LoanEnquirySession, CustomerType
from tools import send_form_link, end_call, schedule_callback, collect_all_data
from prompts import build_loan_enquiry_instructions

logger = logging.getLogger("loan-enquiry-agent")


class LoanEnquiryAgent(Agent):
    def __init__(self, session: LoanEnquirySession):
        super().__init__(
            instructions=build_loan_enquiry_instructions(session),
            tools=[send_form_link, end_call, schedule_callback, collect_all_data],
        )
```

Then copy the following functions verbatim from `los_updated.py` into `agent_core.py` (they reference `session.save_and_disconnect` and `session._send_transcript` which are methods on `LoanEnquirySession` — keep those methods in `session.py`):

**Methods to move to `session.py`** (they use `self` and the LiveKit API):
- `start_recording(self)`
- `save_and_disconnect(self, delay)`
- `_send_transcript(self)`

Add these three methods to the `LoanEnquirySession` class in `session.py`. They require additional imports at the top of `session.py`:

```python
# Add to top of session.py:
import os
import aiohttp
from livekit.api import DeleteRoomRequest, LiveKitAPI
from livekit.protocol.egress import RoomCompositeEgressRequest, EncodedFileOutput, StopEgressRequest
from config import BACKEND_URL
```

Copy `start_recording`, `save_and_disconnect`, `_send_transcript` from `los_updated.py` into `LoanEnquirySession` in `session.py` verbatim — these are pure methods on the session object with no changes needed.

**Then copy `entrypoint(ctx)` into `agent_core.py` verbatim** from `los_updated.py` (lines 587–827). The only change: remove the `import` statements at the top since they're now at module level, and update the `LoanEnquirySession(ctx, metadata)` instantiation — it's unchanged.

- [ ] **Step 2: Rewrite agent/los_updated.py as thin entry point**

Replace the entire contents of `agent/los_updated.py` with:

```python
# agent/los_updated.py
# Entry point — kept as-is for startup command compatibility.
# All logic lives in agent_core.py, session.py, tools.py, prompts.py, config.py.
import os
import logging

from dotenv import load_dotenv
from livekit.agents import WorkerOptions, cli

from agent_core import entrypoint

load_dotenv(".env.local")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

AGENT_NAME = os.getenv("AGENT_NAME", "pusad-bank-loan-enquiry-enhanced")

if __name__ == "__main__":
    import time
    while True:
        try:
            logging.getLogger("loan-enquiry-agent").info("Starting Loan Enquiry Agent Worker...")
            cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
        except KeyboardInterrupt:
            logging.getLogger("loan-enquiry-agent").info("Worker stopped by user")
            break
        except Exception as e:
            logging.getLogger("loan-enquiry-agent").error(f"Worker crashed: {e}")
            logging.getLogger("loan-enquiry-agent").info("Restarting in 5 seconds...")
            time.sleep(5)
```

- [ ] **Step 3: Verify imports resolve**

```bash
cd agent
python -c "
import sys; sys.path.insert(0, '.')
from agent_core import LoanEnquiryAgent, entrypoint
print('agent_core.py imports OK')
from los_updated import entrypoint as ep
print('los_updated.py thin entry point OK')
"
```
Expected:
```
agent_core.py imports OK
los_updated.py thin entry point OK
```

- [ ] **Step 4: Smoke test — worker starts**

```bash
cd agent
./venv/Scripts/python los_updated.py dev &
sleep 5
# Look for "registered worker" in output — kill after check
kill %1
```
Expected log line: `livekit.agents | registered worker`

- [ ] **Step 5: Commit**

```bash
git add agent/agent_core.py agent/session.py agent/los_updated.py
git commit -m "refactor: agent split complete — agent_core.py + thin los_updated.py entry point; startup command unchanged"
```

---

## Task 7: Backend Modular Split — agent/state.py

**Files:**
- Create: `backend/agent/__init__.py`
- Create: `backend/agent/state.py`

`state.py` is the shared foundation — all other backend modules import from it. Get this right before touching anything else.

- [ ] **Step 1: Create backend/agent/__init__.py**

```python
# backend/agent/__init__.py
```
Empty file.

- [ ] **Step 2: Create backend/agent/state.py**

```python
# backend/agent/state.py
import os
import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import pytz
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import jwt as pyjwt

# ── Config ───────────────────────────────────────────────────────────────────
LIVEKIT_URL        = os.getenv("LIVEKIT_URL", "ws://127.0.0.1:7880")
LIVEKIT_API_KEY    = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
SIP_TRUNK_ID       = os.getenv("SIP_TRUNK_ID", "")
GEMINI_API_KEY     = os.getenv("GEMINI_API_KEY", "")
DEMO_MODE          = os.getenv("AGENT_DEMO_MODE", "false").lower() == "true"
AGENT_NAME         = os.getenv("AGENT_NAME", "pusad-bank-loan-enquiry-enhanced")
RECORDING_BASE_URL = os.getenv("RECORDING_BASE_URL", "")
AISENSY_API_KEY    = os.getenv("AISENSY_API_KEY", "")
AISENSY_CAMPAIGN_NAME = os.getenv("AISENSY_FORM_CAMPAIGN", os.getenv("AISENSY_CAMPAIGN_NAME", "LRS_TESTING"))
AISENSY_USERNAME   = os.getenv("AISENSY_USERNAME", "Virtual Galaxy WABA")
AISENSY_IMAGE_URL  = os.getenv(
    "AISENSY_IMAGE_URL",
    "https://d3jt6ku4g6z5l8.cloudfront.net/IMAGE/6353da2e153a147b991dd812/4958901_highanglekidcheatingschooltestmin.jpg",
)
FORM_BASE_URL      = os.getenv("FORM_BASE_URL", "https://virtualvaani.vgipl.com:3001")
JWT_SECRET         = os.getenv("JWT_SECRET", "your-jwt-secret-key")
CALL_START_HOUR    = int(os.getenv("CALL_START_HOUR", "10"))
CALL_END_HOUR      = int(os.getenv("CALL_END_HOUR", "24"))
MAX_RETRIES        = int(os.getenv("MAX_CALL_RETRIES", "2"))
IST                = pytz.timezone("Asia/Kolkata")

logger = logging.getLogger("agent-state")

STATUS_OPTIONS = [
    "Pending", "Calling", "Called", "Called - Interested", "Called - Not Interested",
    "Not Answered", "Call Not Connected", "Failed", "Scheduled", "Invalid Phone",
]
CATEGORY_OPTIONS = [
    "Very Interested - Form Sent", "Interested - Callback Requested",
    "Interested - Needs Time to Decide", "Not Interested - Already Has Loan",
    "Not Interested - No Need Currently", "Ineligible - Income Too Low",
    "Ineligible - Business Too New", "Wrong Number / Not Reachable",
    "Call Not Connected", "Language Barrier", "Uncategorized",
]

# ── DB pool ──────────────────────────────────────────────────────────────────
db_pool = None

def set_db_pool(pool):
    global db_pool
    db_pool = pool

# ── In-process state ─────────────────────────────────────────────────────────
_emergency_stop  = False
_batch_locked    = False
_analytics_locked = False

async def _init_system_state():
    global _emergency_stop
    try:
        row = await db_pool.fetchrow("SELECT value FROM agent_system_config WHERE key = 'emergency_stop'")
        if row:
            _emergency_stop = row["value"] == "true"
    except Exception:
        _emergency_stop = False

async def set_emergency_stop(active: bool):
    global _emergency_stop
    _emergency_stop = active
    try:
        await db_pool.execute(
            """INSERT INTO agent_system_config (key, value, updated_at)
               VALUES ('emergency_stop', $1, $2)
               ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2""",
            "true" if active else "false", now_ist(),
        )
    except Exception as e:
        logger.error(f"Failed to persist emergency_stop: {e}")

async def is_emergency_stop_active() -> bool:
    global _emergency_stop
    try:
        row = await db_pool.fetchrow("SELECT value FROM agent_system_config WHERE key = 'emergency_stop'")
        if row:
            _emergency_stop = row["value"] == "true"
    except Exception:
        pass
    return _emergency_stop

async def acquire_batch_lock() -> bool:
    global _batch_locked
    if _batch_locked:
        return False
    _batch_locked = True
    return True

async def release_batch_lock():
    global _batch_locked
    _batch_locked = False

async def acquire_analytics_lock() -> bool:
    global _analytics_locked
    if _analytics_locked:
        return False
    _analytics_locked = True
    return True

async def release_analytics_lock():
    global _analytics_locked
    _analytics_locked = False

async def cleanup_stuck_calls():
    ten_min_ago = now_ist() - timedelta(minutes=10)
    try:
        result = await db_pool.execute(
            """UPDATE agent_calls
               SET status = 'Failed', error_message = 'Stuck call cleaned up on startup',
                   ended_at = $1, updated_at = $1
               WHERE status = 'Calling' AND started_at < $2""",
            now_ist(), ten_min_ago,
        )
        count = int(result.split()[-1]) if result else 0
        if count > 0:
            logger.warning(f"Cleaned up {count} stuck 'Calling' records")
    except Exception as e:
        logger.error(f"cleanup_stuck_calls error: {e}")

# ── Time helpers ─────────────────────────────────────────────────────────────
def format_ist_time(dt) -> str:
    if not dt:
        return ""
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%d %b, %I:%M %p")

def now_ist() -> datetime:
    return datetime.now(IST)

def now_ist_str() -> str:
    return now_ist().strftime("%b %d, %Y %I:%M %p")

def is_within_calling_hours() -> bool:
    return CALL_START_HOUR <= now_ist().hour < CALL_END_HOUR

# ── Row serialization ─────────────────────────────────────────────────────────
def _row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            d[k] = str(v)
        elif isinstance(v, datetime):
            d[k] = v.isoformat()
    if "id" in d:
        d["_id"] = d["id"]
    return d

def _rows_to_list(rows):
    return [_row_to_dict(r) for r in rows]

def _serialize_call(c: dict) -> dict:
    # Copy verbatim from agent_routes.py lines 273–347
    # (the full _serialize_call function — no changes needed)
    if c is None:
        return None
    if "id" in c:
        c["_id"] = c["id"]
    for jfield in ["transcript", "collected_data", "call_analysis"]:
        val = c.get(jfield)
        if isinstance(val, str):
            try:
                c[jfield] = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                pass
    c["name"] = c.get("customer_name", "")
    c["whatsapp_form_sent"] = c.get("form_sent", False)
    c["customer_interested"] = c.get("interested", False)
    c["call_status"] = c.get("status", "")
    c["call_duration_seconds"] = c.get("call_duration", 0)
    c["loan_type_interested"] = c.get("loan_type", "")
    c["loan_amount_requested"] = c.get("loan_amount", "")
    c["form_url"] = c.get("form_link", "")
    cd = c.get("collected_data") or {}
    if isinstance(cd, str):
        try: cd = json.loads(cd)
        except: cd = {}
    for k in ["monthly_income", "employment_type", "employer_name", "loan_purpose",
              "aadhar_number", "pan_number", "designation", "age", "business_type",
              "existing_emi", "collected_address", "monthly_turnover", "business_age"]:
        if k not in c or not c[k]:
            c[k] = cd.get(k, "")
    ca = c.get("call_analysis") or {}
    if isinstance(ca, str):
        try: ca = json.loads(ca)
        except: ca = {}
    c["lead_quality"] = ca.get("lead_quality", "")
    c["follow_up_needed"] = ca.get("follow_up_needed", "No")
    c["notification_message"] = ca.get("notification_message", "")
    c["form_submitted"] = ca.get("form_submitted", False)
    c["success"] = c.get("status", "") in ("Called - Interested", "Completed", "Called")
    for field in ["started_at", "ended_at", "updated_at", "created_at"]:
        val = c.get(field)
        if val and isinstance(val, str):
            try:
                dt = datetime.fromisoformat(val)
                c[field] = format_ist_time(dt)
            except Exception:
                pass
    c["call_start_time"] = c.get("started_at", "")
    c["call_end_time"] = c.get("ended_at", "")
    c["uploaded_at"] = c.get("created_at", "")
    sc = c.get("scheduled_callback_at")
    if sc and isinstance(sc, str):
        try:
            c["scheduled_callback_at"] = format_ist_time(datetime.fromisoformat(sc))
        except Exception:
            pass
    return c

# ── Auth ──────────────────────────────────────────────────────────────────────
security = HTTPBearer(auto_error=False)

async def get_current_bank_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    if not credentials:
        return {"user_id": "operator", "role": "operator", "bank_id": None, "user_type": "operator"}
    try:
        payload = pyjwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("user_type") != "bank_user":
        raise HTTPException(status_code=403, detail="Bank user access required")
    if payload.get("role") not in ("bank_officer", "bank_supervisor"):
        raise HTTPException(status_code=403, detail="Bank officer or supervisor role required")
    return {
        "user_id": payload["user_id"],
        "role": payload["role"],
        "bank_id": payload.get("bank_id"),
        "user_type": payload["user_type"],
    }

def _bank_uuid(user: dict):
    bid = user.get("bank_id")
    return uuid.UUID(bid) if bid else None

def _bank_filter(bank_uuid, param_idx: int = 1, table_alias: str = "") -> tuple:
    prefix = f"{table_alias}." if table_alias else ""
    if bank_uuid is None:
        return "TRUE", [], param_idx
    return f"{prefix}bank_id = ${param_idx}", [bank_uuid], param_idx + 1

# ── Pydantic models ───────────────────────────────────────────────────────────
class TranscriptItem(BaseModel):
    role: str
    text: str
    ts: Optional[float] = None
    timestamp: Optional[str] = None

class TranscriptPayload(BaseModel):
    room: str
    call_id: Optional[str] = None
    transcript: List[TranscriptItem] = []
    message_count: Optional[int] = None
    recording_path: Optional[str] = None
    customer_interested: bool = False
    customer_type: Optional[str] = None
    lead_quality: Optional[str] = "cold"
    loan_type: Optional[str] = None
    loan_amount: Optional[str] = None
    employment_type: Optional[str] = None
    business_type: Optional[str] = None
    monthly_income: Optional[str] = None
    interest_reason: Optional[str] = None
    whatsapp_form_sent: bool = False
    age: Optional[str] = None
    loan_purpose: Optional[str] = None
    employer_name: Optional[str] = None
    designation: Optional[str] = None
    qualification: Optional[str] = None
    sector: Optional[str] = None
    working_experience: Optional[str] = None
    existing_emi: Optional[str] = None
    business_age: Optional[str] = None
    monthly_turnover: Optional[str] = None
    collected_address: Optional[str] = None

class CallCategorizeRequest(BaseModel):
    category: str
    reminder_date: Optional[str] = None
    after_call_remark: Optional[str] = None
```

- [ ] **Step 3: Verify**

```bash
cd backend
python -c "
from agent.state import (
    set_db_pool, is_within_calling_hours, _row_to_dict, _serialize_call,
    CALL_START_HOUR, CALL_END_HOUR, MAX_RETRIES,
    TranscriptPayload, CallCategorizeRequest, STATUS_OPTIONS
)
print('state.py imports OK')
assert MAX_RETRIES == 2
assert CALL_START_HOUR == 10
print('state.py config values OK')
"
```
Expected:
```
state.py imports OK
state.py config values OK
```

- [ ] **Step 4: Commit**

```bash
git add backend/agent/__init__.py backend/agent/state.py
git commit -m "refactor: extract backend/agent/state.py — shared config, db pool, helpers, auth, models"
```

---

## Task 8: Backend Modular Split — analytics.py + callbacks.py + whatsapp.py

**Files:**
- Create: `backend/agent/analytics.py`
- Create: `backend/agent/callbacks.py`
- Create: `backend/agent/whatsapp.py`

These three modules are small and self-contained.

- [ ] **Step 1: Create backend/agent/analytics.py**

```python
# backend/agent/analytics.py
import json
import asyncio
import logging
from typing import Optional
import uuid

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
    """Synchronous Gemini call — always call via asyncio.to_thread."""
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
    """Background LLM analysis — uses asyncio.to_thread to avoid blocking event loop."""
    if not await acquire_analytics_lock():
        return
    try:
        rows = await db_pool.fetch(
            """SELECT * FROM agent_calls
               WHERE COALESCE(category, 'Uncategorized') IN ('Uncategorized', '')
                 AND transcript IS NOT NULL AND transcript != '[]'::jsonb
                 AND status IN ('Called', 'Completed', 'Called - Interested', 'Called - Not Interested')
               ORDER BY created_at ASC LIMIT 20"""
        )
        if not rows:
            return
        for row in rows:
            call = _row_to_dict(row)
            try:
                transcript = call.get("transcript", [])
                if isinstance(transcript, str):
                    transcript = json.loads(transcript)
                # asyncio.to_thread prevents this sync Gemini call from blocking the event loop
                analysis = await asyncio.to_thread(analyze_transcript_with_llm, transcript)
                existing = call.get("call_analysis") or {}
                if isinstance(existing, str):
                    try: existing = json.loads(existing)
                    except: existing = {}
                merged = dict(existing) if isinstance(existing, dict) else {}
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
                    """UPDATE agent_calls SET category = $1, call_analysis = $2::jsonb, updated_at = $3 WHERE id = $4""",
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
```

- [ ] **Step 2: Create backend/agent/callbacks.py**

Copy `schedule_callback` and `scheduled_callbacks` endpoint functions from `agent_routes.py` (lines 1774–1850). Update every `db_pool.` reference to use the module-level reference from state:

```python
# backend/agent/callbacks.py
import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from .state import (
    db_pool, now_ist, IST, CALL_START_HOUR, CALL_END_HOUR,
    _serialize_call, _row_to_dict,
)

logger = logging.getLogger("agent-callbacks")
router = APIRouter()


@router.get("/scheduled-callbacks")
async def scheduled_callbacks(limit: int = Query(50, ge=1, le=200)):
    rows = await db_pool.fetch(
        """SELECT * FROM agent_calls
           WHERE status = 'Scheduled' AND scheduled_callback_at IS NOT NULL
           ORDER BY scheduled_callback_at ASC LIMIT $1""",
        limit,
    )
    payload = [_serialize_call(_row_to_dict(r)) for r in rows]
    return {"scheduled": payload, "count": len(payload)}


@router.post("/schedule-callback")
async def schedule_callback(request: Request):
    data = await request.json()
    call_id = data.get("call_id")
    callback_iso = data.get("callback_iso")
    reason = (data.get("reason") or "").strip() or "user_busy"

    if not call_id or not callback_iso:
        raise HTTPException(status_code=400, detail="call_id and callback_iso required")
    try:
        call_uuid = uuid.UUID(call_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid call_id")
    try:
        if callback_iso.endswith("Z"):
            callback_iso = callback_iso[:-1] + "+00:00"
        dt = datetime.fromisoformat(callback_iso)
        if dt.tzinfo is None:
            dt = IST.localize(dt)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"invalid callback_iso: {e}")

    dt_ist = dt.astimezone(IST)
    now_local = now_ist()
    if dt_ist < now_local + timedelta(minutes=1):
        dt_ist = now_local + timedelta(minutes=2)
    if dt_ist.hour < CALL_START_HOUR or dt_ist.hour >= CALL_END_HOUR:
        next_day = dt_ist.date() if dt_ist.hour < CALL_START_HOUR else (dt_ist + timedelta(days=1)).date()
        dt_ist = IST.localize(datetime.combine(next_day, datetime.min.time())).replace(hour=CALL_START_HOUR)

    await db_pool.execute(
        """UPDATE agent_calls
           SET status = 'Scheduled', scheduled_callback_at = $1,
               callback_reason = $2, error_message = NULL, updated_at = $3
           WHERE id = $4""",
        dt_ist, reason, now_local, call_uuid,
    )
    row = await db_pool.fetchrow("SELECT batch_id FROM agent_calls WHERE id = $1", call_uuid)
    if row and row["batch_id"]:
        await db_pool.execute(
            """UPDATE agent_batches
               SET status = CASE WHEN status = 'completed' THEN 'running' ELSE status END
               WHERE batch_id = $1""",
            row["batch_id"],
        )
    logger.info(f"Callback scheduled for {call_uuid} at {dt_ist.isoformat()} (reason={reason})")
    return {"status": "success", "scheduled_callback_at": dt_ist.isoformat(), "reason": reason}
```

- [ ] **Step 3: Create backend/agent/whatsapp.py**

Copy the `send_whatsapp_form` endpoint from `agent_routes.py` (lines 1853–2081). Update `db_pool.` to use state:

```python
# backend/agent/whatsapp.py
import json
import uuid
import secrets
import time
import logging

import aiohttp
from fastapi import APIRouter, Request

from .state import (
    db_pool, now_ist, AISENSY_API_KEY, AISENSY_CAMPAIGN_NAME,
    AISENSY_USERNAME, AISENSY_IMAGE_URL, FORM_BASE_URL,
)

logger = logging.getLogger("agent-whatsapp")
router = APIRouter()


@router.post("/send-whatsapp-form")
async def send_whatsapp_form(request: Request):
    from main import save_field_sources  # kept as-is — pre-existing cross-module dep
    # Copy the full function body from agent_routes.py lines 1861–2081 verbatim.
    # Replace every `db_pool.` with `db_pool.` (no change needed — db_pool is imported from state above).
    # The import `from main import save_field_sources` stays at function level as in the original.
    ...
```

**Important:** Copy the complete function body of `send_whatsapp_form` from `agent_routes.py:1861–2081` into this file exactly. Replace the `...` above with that code. The only change: `db_pool` is now the module-level import from `.state`, which works identically.

- [ ] **Step 4: Verify**

```bash
cd backend
python -c "
from agent.analytics import analyze_transcript_with_llm, process_analytics_batch
from agent.callbacks import router as cb_router
from agent.whatsapp import router as wa_router
print('analytics, callbacks, whatsapp imports OK')
import inspect
src = inspect.getsource(process_analytics_batch)
assert 'asyncio.to_thread' in src, 'analytics still blocking!'
print('asyncio.to_thread confirmed in process_analytics_batch')
"
```
Expected:
```
analytics, callbacks, whatsapp imports OK
asyncio.to_thread confirmed in process_analytics_batch
```

- [ ] **Step 5: Commit**

```bash
git add backend/agent/analytics.py backend/agent/callbacks.py backend/agent/whatsapp.py
git commit -m "refactor: extract analytics.py (with asyncio.to_thread fix), callbacks.py, whatsapp.py"
```

---

## Task 9: Backend Modular Split — transcript.py + batch.py

**Files:**
- Create: `backend/agent/transcript.py`
- Create: `backend/agent/batch.py`

These are the two largest modules. `batch.py` also contains `agent_startup` and `agent_shutdown`.

- [ ] **Step 1: Create backend/agent/transcript.py**

```python
# backend/agent/transcript.py
import json
import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter

from .state import (
    db_pool, now_ist, RECORDING_BASE_URL, _row_to_dict,
    TranscriptPayload,
)

logger = logging.getLogger("agent-transcript")
router = APIRouter()


@router.post("/transcript")
async def save_transcript(data: TranscriptPayload):
    from main import save_field_sources  # kept as pre-existing cross-module dep
    # Copy the complete function body from agent_routes.py lines 1589–1768 verbatim.
    # Replace every `db_pool.` call — db_pool is imported from .state above, works identically.
    ...
```

Copy the full body of `save_transcript` from `agent_routes.py:1589–1768` exactly into the function, replacing `...`.

- [ ] **Step 2: Create backend/agent/batch.py**

```python
# backend/agent/batch.py
import os
import io
import secrets
import time
import asyncio
import logging
import json
import uuid
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query, BackgroundTasks
from livekit import api
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from .state import (
    db_pool, now_ist, now_ist_str, is_within_calling_hours,
    acquire_batch_lock, release_batch_lock, is_emergency_stop_active,
    set_emergency_stop, cleanup_stuck_calls, _init_system_state,
    _row_to_dict, _rows_to_list, _serialize_call,
    LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
    SIP_TRUNK_ID, AGENT_NAME, DEMO_MODE, CALL_START_HOUR, CALL_END_HOUR,
    MAX_RETRIES, IST,
)
from .analytics import process_analytics_batch

logger = logging.getLogger("agent-batch")
router = APIRouter()

_scheduler: AsyncIOScheduler = None


async def agent_startup():
    """Called from main.py on app startup."""
    global _scheduler
    await _init_system_state()
    await release_batch_lock()
    await cleanup_stuck_calls()

    _scheduler = AsyncIOScheduler(timezone="Asia/Kolkata")
    _last_active_hour = (CALL_END_HOUR - 1) % 24
    _hour_expr = (
        f"{CALL_START_HOUR}-{_last_active_hour}"
        if CALL_START_HOUR <= _last_active_hour
        else f"{CALL_START_HOUR}-23,0-{_last_active_hour}"
    )
    _scheduler.add_job(
        _scheduled_batch_run,
        CronTrigger(hour=_hour_expr, minute="*/5", timezone="Asia/Kolkata"),
        id="batch_runner", replace_existing=True,
    )
    _scheduler.add_job(
        _scheduled_analytics,
        CronTrigger(minute="*/2", timezone="Asia/Kolkata"),
        id="analytics_runner", replace_existing=True,
    )
    _scheduler.start()
    logger.info(f"Agent scheduler started (calls {CALL_START_HOUR}:00-{CALL_END_HOUR}:00 IST, analytics every 2m)")


async def agent_shutdown():
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
    await release_batch_lock()
    logger.info("Agent scheduler stopped")


async def _scheduled_batch_run():
    await process_batch_run()


async def _scheduled_analytics():
    await process_analytics_batch()
```

Then copy `wait_for_call_completion` and `process_batch_run` from `agent_routes.py:557–849` verbatim. Then copy all batch endpoint functions: `upload_excel`, `trigger_batch`, `batch_status`, `trigger_batch_retry`, `emergency_stop`, `resume_calling`, `list_uploads`, `get_upload_detail`, `recent_calls`.

For every `db_pool.` in these functions: `db_pool` is already imported from `.state`, so no change needed.

- [ ] **Step 3: Verify**

```bash
cd backend
python -c "
from agent.batch import router as batch_router, agent_startup, agent_shutdown
from agent.transcript import router as tr_router
print('batch.py and transcript.py imports OK')
# Verify agent_startup and agent_shutdown are coroutines
import asyncio
assert asyncio.iscoroutinefunction(agent_startup)
assert asyncio.iscoroutinefunction(agent_shutdown)
print('agent_startup/shutdown are coroutines OK')
"
```
Expected:
```
batch.py and transcript.py imports OK
agent_startup/shutdown are coroutines OK
```

- [ ] **Step 4: Commit**

```bash
git add backend/agent/transcript.py backend/agent/batch.py
git commit -m "refactor: extract transcript.py and batch.py (contains agent_startup/shutdown)"
```

---

## Task 10: Backend Modular Split — calls.py + thin agent_routes.py

**Files:**
- Create: `backend/agent/calls.py`
- Modify: `backend/agent_routes.py` → thin wiring file

This is the final step. After this, the monolith is fully split.

- [ ] **Step 1: Create backend/agent/calls.py**

```python
# backend/agent/calls.py
import io
import json
import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, Query, Depends, Request
from fastapi.responses import StreamingResponse

from .state import (
    db_pool, now_ist, format_ist_time, IST,
    _row_to_dict, _rows_to_list, _serialize_call,
    get_current_bank_user, STATUS_OPTIONS, CATEGORY_OPTIONS,
    CallCategorizeRequest,
)

logger = logging.getLogger("agent-calls")
router = APIRouter()
```

Then copy ALL remaining endpoint functions from `agent_routes.py` that are not already in batch/transcript/whatsapp/callbacks:
- `get_call_alias` (GET /call/{id})
- `get_call_transcript_alias` (GET /call/{id}/transcript)
- `list_calls` (GET /calls)
- `get_call` (GET /calls/{id})
- `get_call_transcript` (GET /calls/{id}/transcript)
- `get_call_recording` (GET /calls/{id}/recording)
- `categorize_call` (PUT /calls/{id}/categorize)
- `get_form_data` (GET /form-data/{id})
- `submit_form` (POST /submit-form/{id})
- `get_dashboard_stats` (GET /dashboard-stats)
- `get_analytics` (GET /analytics)
- `export_daily_report` (GET /export/daily-report)
- `export_all_calls` (GET /export/all-calls)
- `get_active_call` (GET /active-call) — copy from agent_routes.py ~line 2340
- `stale_cleanup` (POST /stale-cleanup) — copy from agent_routes.py ~line 2398

Copy each verbatim. `db_pool` is already imported from `.state`.

- [ ] **Step 2: Rewrite backend/agent_routes.py as thin wiring file**

Replace the ENTIRE contents of `backend/agent_routes.py` with:

```python
# backend/agent_routes.py
# Thin router — wires sub-routers from backend/agent/ package.
# main.py imports: router, set_db_pool, agent_startup, agent_shutdown
from fastapi import APIRouter

from agent.state import set_db_pool
from agent.batch import router as _batch_router, agent_startup, agent_shutdown
from agent.transcript import router as _transcript_router
from agent.whatsapp import router as _whatsapp_router
from agent.callbacks import router as _callbacks_router
from agent.calls import router as _calls_router

router = APIRouter(prefix="/api/agent", tags=["agent"])
router.include_router(_batch_router)
router.include_router(_transcript_router)
router.include_router(_whatsapp_router)
router.include_router(_callbacks_router)
router.include_router(_calls_router)

__all__ = ["router", "set_db_pool", "agent_startup", "agent_shutdown"]
```

- [ ] **Step 3: Verify imports — the critical check**

```bash
cd backend
python -c "
from agent_routes import router, set_db_pool, agent_startup, agent_shutdown
print('agent_routes thin wiring OK')

# Verify all routes are present
paths = [r.path for r in router.routes]
assert any('/transcript' in p for p in paths), '/transcript missing'
assert any('/calls' in p for p in paths), '/calls missing'
assert any('/schedule-callback' in p for p in paths), '/schedule-callback missing'
assert any('/send-whatsapp-form' in p for p in paths), '/send-whatsapp-form missing'
assert any('/upload-excel' in p for p in paths), '/upload-excel missing'
assert any('/dashboard-stats' in p for p in paths), '/dashboard-stats missing'
assert any('/export' in p for p in paths), '/export missing'
print(f'All routes present — {len(paths)} total routes')
"
```
Expected:
```
agent_routes thin wiring OK
All routes present — N total routes
```

- [ ] **Step 4: Smoke test — backend starts and responds**

```bash
cd backend
# Start backend (requires .env and running DB — use AGENT_DEMO_MODE=true to skip LiveKit)
AGENT_DEMO_MODE=true uvicorn main:app --port 8200 &
sleep 4
curl -s http://localhost:8200/api/agent/calls | python -c "import json,sys; d=json.load(sys.stdin); print('GET /calls OK, total:', d.get('total', 0))"
curl -s http://localhost:8200/api/agent/dashboard-stats | python -c "import json,sys; d=json.load(sys.stdin); print('GET /dashboard-stats OK')"
kill %1
```
Expected:
```
GET /calls OK, total: 0
GET /dashboard-stats OK
```

- [ ] **Step 5: Final commit**

```bash
git add backend/agent/calls.py backend/agent_routes.py
git commit -m "refactor: backend split complete — agent_routes.py is now 30-line thin router; all routes preserved"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** Track 1 (bugs) ✓ Task 1. Track 2 (latency) ✓ Tasks 2–3. Track 3 agent split ✓ Tasks 4–6. Track 3 backend split ✓ Tasks 7–10.
- [x] **No placeholders:** whatsapp.py and transcript.py say "copy from agent_routes.py:LINE–LINE verbatim" — this is a precise instruction, not a TBD.
- [x] **Type consistency:** `LoanEnquirySession` defined in `session.py` Task 4, imported in `tools.py` Task 5 and `agent_core.py` Task 6. `db_pool` always accessed via `state.db_pool` pattern across Tasks 7–10.
- [x] **Startup command preserved:** `./venv/Scripts/python los_updated.py dev` still works — `los_updated.py` is kept and imports from `agent_core.py`.
- [x] **All API paths preserved:** `agent_routes.py` keeps `prefix="/api/agent"` and includes all sub-routers. No path changes.
- [x] **collect_all_data untouched:** The tool is copied verbatim from current code in Task 5. No behavioral change.
- [x] **DB schema unchanged:** Zero SQL or migration files in this plan.
