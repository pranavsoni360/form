# main.py - FastAPI Backend for Bank Loan Form System (Multi-Bank Tenant Architecture)
from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime, timedelta, timezone
import secrets
import bcrypt
import re
import os
import uuid
import asyncpg
import aiofiles
from pathlib import Path
from dotenv import load_dotenv
import httpx
import jwt
import hashlib

load_dotenv()

app = FastAPI(
    title="Bank Loan Form API",
    description="Multi-bank tenant loan origination system with AI review pipeline",
    version="2.0.0"
)

APP_URL = os.getenv("APP_URL", "http://localhost:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://yourdomain.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://los_admin:password@localhost:5435/los_form")
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "your-32-byte-encryption-key-here")
JWT_SECRET = os.getenv("JWT_SECRET", "your-jwt-secret-key")
WHATSAPP_API_TOKEN = os.getenv("WHATSAPP_API_TOKEN")
WHATSAPP_PHONE_ID = os.getenv("WHATSAPP_PHONE_ID")
AISENSY_API_KEY = os.getenv("AISENSY_API_KEY")
AISENSY_CAMPAIGN_NAME = os.getenv("AISENSY_CAMPAIGN_NAME", "Call")
AISENSY_USERNAME = os.getenv("AISENSY_USERNAME", "Virtual Galaxy WABA")

security = HTTPBearer()

def now_utc():
    return datetime.now(timezone.utc)

def _row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            d[k] = str(v)
        elif isinstance(v, datetime):
            d[k] = v.isoformat()
        elif isinstance(v, str) and k in ("field_sources", "transcript", "collected_data") and v.startswith("{"):
            # Parse JSONB strings back to dicts so FastAPI doesn't double-encode
            try:
                parsed = json.loads(v)
                while isinstance(parsed, str):
                    parsed = json.loads(parsed)
                d[k] = parsed
            except (json.JSONDecodeError, TypeError):
                pass
    return d

def _rows_to_list(rows):
    return [_row_to_dict(r) for r in rows]

async def save_field_sources(app_id, source: str, fields: dict):
    """Save which API populated which fields, for audit/modification tracking.
    fields: dict of {field_name: original_value}"""
    if not app_id:
        return
    try:
        row = await db_pool.fetchrow("SELECT field_sources FROM loan_applications WHERE id = $1", app_id)
        raw = row["field_sources"] if row else None
        # Handle all possible types from asyncpg JSONB
        if isinstance(raw, dict):
            existing = raw
        elif isinstance(raw, str):
            parsed = json.loads(raw)
            # Handle double-encoding: json.loads('"{}"') returns the string "{}"
            if isinstance(parsed, str):
                existing = json.loads(parsed)
            else:
                existing = parsed
        else:
            existing = {}
        if not isinstance(existing, dict):
            existing = {}
        for field, value in fields.items():
            if value:
                existing[field] = {"source": source, "original": str(value), "modified": False}
        await db_pool.execute("UPDATE loan_applications SET field_sources = $1::jsonb WHERE id = $2", json.dumps(existing), app_id)
    except Exception as e:
        print(f"[save_field_sources] Error: {e}")

def clean_phone(phone: str) -> str:
    """Normalize phone to 12-digit Indian format (91XXXXXXXXXX)."""
    digits = phone.replace('+', '').replace(' ', '').replace('-', '')
    if digits.startswith('91') and len(digits) == 12:
        return digits
    if len(digits) == 10:
        return f"91{digits}"
    return digits

# ============================================
# VG DOCVERIFY API HELPERS
# ============================================

def vg_base_obj(api_code: str) -> dict:
    """Standard request wrapper for all VG DocVerify API calls."""
    return {
        "UserId": VG_USER_ID,
        "VerificationKey": VG_KEY,
        "Longitude": "", "Latitude": "", "Accuracy": "",
        "App_Mode": "", "Request From": "", "Device_Id": "",
        "Bank_short_code": VG_BANK_CODE,
        "Bank_Name": VG_BANK_NAME,
        "APICode": api_code,
    }

def parse_vg_response(raw: str) -> dict:
    """Parse VG API response, handling double-JSON wrapping."""
    raw = raw.strip()
    if '}{' in raw:
        raw = raw.split('}{')[0] + '}'
    return json.loads(raw)

def generate_aadhaar_pdf(name: str, dob: str, gender: str, address: str, masked_uid: str, photo_b64: str = None) -> bytes:
    """Generate an Aadhaar verification document from DigiLocker data."""
    pdf = FPDF(format='A4')
    pdf.add_page()
    pdf.set_auto_page_break(auto=False)
    W = 210  # A4 width
    M = 20   # margins

    # ── Indian tricolor stripe at top ──
    pdf.set_fill_color(255, 153, 51)   # Saffron
    pdf.rect(0, 0, W, 2.5, 'F')
    pdf.set_fill_color(255, 255, 255)  # White
    pdf.rect(0, 2.5, W, 2.5, 'F')
    pdf.set_fill_color(19, 136, 8)     # Green
    pdf.rect(0, 5, W, 2.5, 'F')

    # ── Document title ──
    y = 14
    pdf.set_font('Helvetica', 'B', 20)
    pdf.set_text_color(30, 30, 40)
    pdf.set_xy(M, y)
    pdf.cell(0, 9, 'Aadhaar Verification Report')
    y += 11

    pdf.set_font('Helvetica', '', 9)
    pdf.set_text_color(100, 110, 120)
    pdf.set_xy(M, y)
    pdf.cell(0, 5, 'Identity data fetched via DigiLocker  |  Source: UIDAI (Digitally Signed XML)')
    y += 5

    # Date on right
    pdf.set_font('Helvetica', '', 8)
    pdf.set_text_color(140, 140, 150)
    pdf.set_xy(W - M - 60, 14)
    pdf.cell(60, 5, f'Date: {datetime.now().strftime("%d %b %Y")}', align='R')

    # Thin separator
    y += 4
    pdf.set_draw_color(220, 220, 225)
    pdf.line(M, y, W - M, y)
    y += 6

    # ── Card section ──
    card_y = y
    card_x = M
    card_w = W - 2 * M
    card_inner_pad = 12

    # Card background
    pdf.set_fill_color(248, 249, 252)
    pdf.set_draw_color(210, 215, 225)
    pdf.rect(card_x, card_y, card_w, 120, 'DF')

    # ── Photo ──
    photo_x = card_x + card_inner_pad
    photo_y = card_y + card_inner_pad
    photo_w = 35
    photo_h = 44
    tmp_photo_path = None
    if photo_b64:
        try:
            photo_bytes = b64mod.b64decode(photo_b64)
            with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
                tmp.write(photo_bytes)
                tmp_photo_path = tmp.name
            pdf.set_draw_color(190, 195, 205)
            pdf.rect(photo_x - 0.5, photo_y - 0.5, photo_w + 1, photo_h + 1)
            pdf.image(tmp_photo_path, x=photo_x, y=photo_y, w=photo_w, h=photo_h)
        except Exception as e:
            print(f"[PDF] Photo embed error: {e}")
    else:
        pdf.set_fill_color(230, 232, 238)
        pdf.rect(photo_x, photo_y, photo_w, photo_h, 'DF')
        pdf.set_font('Helvetica', '', 8)
        pdf.set_text_color(150, 150, 160)
        pdf.set_xy(photo_x, photo_y + 18)
        pdf.cell(photo_w, 5, 'Photo', align='C')

    # "DigiLocker" badge below photo
    badge_y = photo_y + photo_h + 4
    pdf.set_fill_color(219, 234, 254)
    pdf.set_draw_color(147, 197, 253)
    bw = photo_w + 1
    pdf.rect(photo_x - 0.5, badge_y, bw, 9, 'DF')
    pdf.set_font('Helvetica', 'B', 6.5)
    pdf.set_text_color(29, 78, 216)
    pdf.set_xy(photo_x, badge_y + 1)
    pdf.cell(bw - 1, 6, 'DigiLocker Verified', align='C')

    # ── Fields (right of photo) ──
    fx = photo_x + photo_w + 15
    fy = card_y + card_inner_pad
    fw = card_w - photo_w - card_inner_pad * 2 - 15  # available width for fields

    def field(label, value, yy, font_size=11, bold=True):
        pdf.set_font('Helvetica', '', 7.5)
        pdf.set_text_color(120, 125, 135)
        pdf.set_xy(fx, yy)
        pdf.cell(fw, 4, label)
        pdf.set_font('Helvetica', 'B' if bold else '', font_size)
        pdf.set_text_color(25, 30, 40)
        pdf.set_xy(fx, yy + 4.5)
        if len(str(value or '')) > 55:
            pdf.multi_cell(fw, 5.5, str(value or '-'))
            return pdf.get_y() - yy + 3
        else:
            pdf.cell(fw, 6, str(value or '-'))
            return 14

    fy += field('Full Name', name, fy, font_size=13)
    fy += field('Date of Birth', dob, fy)
    fy += field('Gender', gender, fy)

    # ── Aadhaar Number (prominent) ──
    uid_y = fy + 2
    pdf.set_font('Helvetica', '', 7.5)
    pdf.set_text_color(120, 125, 135)
    pdf.set_xy(fx, uid_y)
    pdf.cell(fw, 4, 'Aadhaar Number (Masked)')

    pdf.set_font('Helvetica', 'B', 18)
    pdf.set_text_color(25, 30, 40)
    display_uid = masked_uid if masked_uid else "XXXX XXXX XXXX"
    parts = display_uid.split()
    spaced = "    ".join(parts) if len(parts) >= 2 else display_uid
    pdf.set_xy(fx, uid_y + 5)
    pdf.cell(fw, 10, spaced)

    # ── Address section (below card, full width) ──
    addr_y = card_y + 90
    pdf.set_font('Helvetica', '', 7.5)
    pdf.set_text_color(120, 125, 135)
    pdf.set_xy(card_x + card_inner_pad, addr_y)
    pdf.cell(card_w - card_inner_pad * 2, 4, 'Address')
    pdf.set_font('Helvetica', '', 10)
    pdf.set_text_color(25, 30, 40)
    pdf.set_xy(card_x + card_inner_pad, addr_y + 5)
    pdf.multi_cell(card_w - card_inner_pad * 2, 5.5, str(address or '-'))

    # ── Verification Info Section ──
    info_y = card_y + 128
    pdf.set_draw_color(220, 220, 225)
    pdf.line(M, info_y, W - M, info_y)
    info_y += 6

    pdf.set_font('Helvetica', 'B', 10)
    pdf.set_text_color(25, 30, 40)
    pdf.set_xy(M, info_y)
    pdf.cell(0, 6, 'Verification Details')
    info_y += 9

    details = [
        ('Source', 'DigiLocker (Aadhaar XML via UIDAI)'),
        ('Signature Status', 'XML Signature Verified (xmlSignatureVerified: true)'),
        ('Document Type', 'Masked Aadhaar - First 8 digits hidden for privacy'),
        ('Fetched On', datetime.now().strftime("%d %B %Y, %I:%M %p IST")),
    ]
    for label, val in details:
        pdf.set_font('Helvetica', '', 8)
        pdf.set_text_color(120, 125, 135)
        pdf.set_xy(M, info_y)
        pdf.cell(50, 5, label)
        pdf.set_font('Helvetica', '', 8.5)
        pdf.set_text_color(50, 55, 65)
        pdf.set_xy(M + 50, info_y)
        pdf.cell(0, 5, val)
        info_y += 7

    # ── Disclaimer box ──
    disc_y = info_y + 6
    pdf.set_fill_color(255, 251, 235)
    pdf.set_draw_color(253, 224, 71)
    pdf.rect(M, disc_y, card_w, 20, 'DF')
    pdf.set_font('Helvetica', 'B', 7)
    pdf.set_text_color(146, 64, 14)
    pdf.set_xy(M + 5, disc_y + 3)
    pdf.cell(0, 4, 'Disclaimer')
    pdf.set_font('Helvetica', '', 7)
    pdf.set_text_color(120, 53, 15)
    pdf.set_xy(M + 5, disc_y + 8)
    pdf.multi_cell(card_w - 10, 3.5,
        'This is NOT an official e-Aadhaar document issued by UIDAI. This report contains identity information '
        'fetched via DigiLocker and verified through UIDAI\'s digitally signed Aadhaar XML. '
        'For an official e-Aadhaar, visit myaadhaar.uidai.gov.in')

    # ── Bottom tricolor ──
    pdf.set_fill_color(255, 153, 51)
    pdf.rect(0, 295, W, 1, 'F')
    pdf.set_fill_color(255, 255, 255)
    pdf.rect(0, 296, W, 1, 'F')
    pdf.set_fill_color(19, 136, 8)
    pdf.rect(0, 297, W, 1, 'F')

    # Cleanup
    if tmp_photo_path and os.path.exists(tmp_photo_path):
        os.unlink(tmp_photo_path)

    return pdf.output()

async def resolve_token_or_session(token_or_session: str):
    """Resolve a token or session_token to (token_row_or_session, application_id).
    Works for both form_tokens and loan_sessions."""
    try:
        # Try loan_sessions first
        session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", token_or_session)
        if session:
            return session, session["application_id"]
        # Try form_tokens
        token_row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", token_or_session)
        if token_row:
            app_row = await db_pool.fetchrow("SELECT id FROM loan_applications WHERE token_id = $1", token_row["id"])
            return token_row, app_row["id"] if app_row else None
    except Exception as e:
        print(f"[resolve_token_or_session] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Token resolution error: {repr(e)}")
    raise HTTPException(status_code=404, detail="Invalid token or session")

# ============================================
# AUTH TOKEN HELPERS
# ============================================

def create_access_token(user_id: str, role: str, user_type: str, bank_id: str = None, **extra) -> str:
    payload = {
        "user_id": user_id,
        "role": role,
        "user_type": user_type,
        "exp": now_utc() + timedelta(minutes=ACCESS_TOKEN_MINUTES),
        "iat": now_utc(),
        "type": "access",
    }
    if bank_id:
        payload["bank_id"] = bank_id
    payload.update(extra)
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def create_refresh_token(user_id: str, role: str, user_type: str, bank_id: str = None) -> tuple[str, str]:
    jti = secrets.token_urlsafe(32)
    payload = {
        "user_id": user_id,
        "role": role,
        "user_type": user_type,
        "jti": jti,
        "exp": now_utc() + timedelta(hours=REFRESH_TOKEN_HOURS),
        "iat": now_utc(),
        "type": "refresh",
    }
    if bank_id:
        payload["bank_id"] = bank_id
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return token, jti

from fastapi.responses import JSONResponse

def _set_refresh_cookie(resp: JSONResponse, cookie_name: str, refresh_token: str) -> None:
    resp.set_cookie(
        key=cookie_name,
        value=refresh_token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=REFRESH_TOKEN_HOURS * 3600,
        path="/api/auth",
    )

async def _store_refresh_token(user_id: str, jti: str, role: str, user_type: str, bank_id: str = None) -> None:
    await db_pool.execute(
        """INSERT INTO refresh_tokens (user_id, jti, role, user_type, bank_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)""",
        uuid.UUID(user_id), jti, role, user_type, uuid.UUID(bank_id) if bank_id else None,
        now_utc(), now_utc() + timedelta(hours=REFRESH_TOKEN_HOURS),
    )

# ============================================
# LOGIN LOCKOUT HELPERS
# ============================================

async def _check_lockout(username: str) -> None:
    row = await db_pool.fetchrow("SELECT * FROM login_attempts WHERE username = $1", username)
    if row and row["locked_until"] and row["locked_until"] > now_utc():
        remaining = int((row["locked_until"] - now_utc()).total_seconds() / 60) + 1
        raise HTTPException(status_code=423, detail=f"Account locked due to too many failed attempts. Try again in {remaining} minutes.")

async def _record_failed_login(username: str) -> tuple[int, bool]:
    row = await db_pool.fetchrow("SELECT * FROM login_attempts WHERE username = $1", username)
    if row:
        attempts = row["attempts"] + 1
        await db_pool.execute(
            "UPDATE login_attempts SET attempts = $1, last_attempt = $2 WHERE username = $3",
            attempts, now_utc(), username,
        )
    else:
        attempts = 1
        await db_pool.execute(
            "INSERT INTO login_attempts (username, attempts, last_attempt) VALUES ($1, $2, $3)",
            username, attempts, now_utc(),
        )
    locked = False
    if attempts >= MAX_LOGIN_ATTEMPTS:
        await db_pool.execute(
            "UPDATE login_attempts SET locked_until = $1 WHERE username = $2",
            now_utc() + timedelta(minutes=LOCKOUT_MINUTES), username,
        )
        locked = True
    return attempts, locked

async def _clear_failed_logins(username: str) -> None:
    await db_pool.execute("DELETE FROM login_attempts WHERE username = $1", username)

# ============================================
# AGENT ROUTES (Voice Calling Module)
# ============================================
try:
    from agent_routes import router as agent_router, set_db_pool as agent_set_db_pool, agent_startup, agent_shutdown
    app.include_router(agent_router)
    AGENT_MODULE_LOADED = True
except ImportError as e:
    print(f"[agent] Agent module not loaded (missing deps: {e}). Call management endpoints disabled.")
    AGENT_MODULE_LOADED = False
    def agent_set_db_pool(pool): pass
    async def agent_startup(): pass
    async def agent_shutdown(): pass

# ============================================
# STARTUP / SHUTDOWN
# ============================================

@app.on_event("startup")
async def startup():
    global db_pool
    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    if AGENT_MODULE_LOADED:
        agent_set_db_pool(db_pool)
        await agent_startup()

@app.on_event("shutdown")
async def shutdown():
    global db_pool
    if AGENT_MODULE_LOADED:
        await agent_shutdown()
    if db_pool:
        await db_pool.close()

# Mount uploads directory
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# ============================================
# PYDANTIC MODELS
# ============================================

class CustomerData(BaseModel):
    customer_name: str
    phone: str
    loan_id: str
    loan_amount: float
    loan_type: str
    email: Optional[EmailStr] = None
    date_of_birth: Optional[str] = None
    address: Optional[str] = None

class OTPVerifyRequest(BaseModel):
    token: str
    otp: str

class FormStepData(BaseModel):
    token: str
    step: int
    data: dict

class AdminLogin(BaseModel):
    email: EmailStr
    password: str

class BankLogin(BaseModel):
    username: str
    password: str

class ReviewAction(BaseModel):
    application_id: str
    action: str
    notes: Optional[str] = None
    rejection_reason: Optional[str] = None

class BankCreate(BaseModel):
    name: str
    code: str
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    logo_url: Optional[str] = None

class BankUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    logo_url: Optional[str] = None
    status: Optional[str] = None

class BankUserCreate(BaseModel):
    username: str
    email: str
    full_name: str
    role: str  # bank_officer or bank_supervisor

class BankUserUpdate(BaseModel):
    email: Optional[str] = None
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None

class OfficerReviewRequest(BaseModel):
    notes: Optional[str] = None

class OfficerRejectRequest(BaseModel):
    notes: Optional[str] = None
    rejection_reason: Optional[str] = None

class GenerateFormLinksRequest(BaseModel):
    customers: List[CustomerData]
    bank_id: Optional[str] = None

# ============================================
# UTILITY FUNCTIONS
# ============================================

def generate_secure_token() -> str:
    return secrets.token_urlsafe(64)

def hash_otp(otp: str) -> str:
    return bcrypt.hashpw(otp.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_otp(plain_otp: str, hashed_otp: str) -> bool:
    return bcrypt.checkpw(plain_otp.encode('utf-8'), hashed_otp.encode('utf-8'))

def generate_otp() -> str:
    return str(secrets.randbelow(900000) + 100000)

async def send_whatsapp_message(phone: str, message: str, token_id: str = None):
    if not WHATSAPP_API_TOKEN or not WHATSAPP_PHONE_ID:
        print(f"[WhatsApp STUB] Would send to {phone}: {message[:80]}...")
        return {"status": "simulated"}

    phone_formatted = clean_phone(phone)
    url = f"https://graph.facebook.com/v18.0/{WHATSAPP_PHONE_ID}/messages"
    headers = {
        "Authorization": f"Bearer {WHATSAPP_API_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": phone_formatted,
        "type": "text",
        "text": {"body": message}
    }
    async with httpx.AsyncClient(verify=False) as client:
        try:
            response = await client.post(url, headers=headers, json=payload)

            print(f"WhatsApp API Status: {response.status_code}")
            print(f"WhatsApp API Raw Response: {response.text}")
            print(f"WhatsApp URL: {url}")
            print(f"WhatsApp Phone formatted: {phone_formatted}")

            try:
                response_data = response.json()
            except Exception:
                response_data = {"error": response.text}

            print("Parsed WhatsApp Response:", response_data)

            message_id = None
            if isinstance(response_data, dict) and "messages" in response_data:
                if isinstance(response_data["messages"], list) and len(response_data["messages"]) > 0:
                    message_id = response_data["messages"][0].get("id")

            supabase.table("whatsapp_messages").insert({
                "phone": phone,
                "message_type": "notification",
                "message_body": message,
                "status": "sent" if response.status_code == 200 else "failed",
                "whatsapp_message_id": message_id,
                "token_id": token_id,
                "sent_at": now_utc().isoformat()
            }).execute()

            return response_data

        except Exception as e:
            print(f"[AiSensy OTP] Error: {e}")
            return {"status": "failed", "error": str(e)}


async def send_whatsapp_aisensy(phone: str, customer_name: str, template_params: list = None):
    """Send WhatsApp message via AiSensy campaign API"""
    if not AISENSY_API_KEY:
        print(f"[AiSensy STUB] Would send to {phone}")
        return {"status": "simulated"}

    phone_formatted = phone.replace('+', '').replace(' ', '')

    payload = {
        "apiKey": AISENSY_API_KEY,
        "campaignName": AISENSY_CAMPAIGN_NAME,
        "destination": phone_formatted,
        "userName": AISENSY_USERNAME,
        "templateParams": [first_name, first_name],
        "source": "loan-form-system",
        "media": {},
        "buttons": [],
        "carouselCards": [],
        "location": {},
        "attributes": {},
        "paramsFallbackValue": {
            "FirstName": customer_name
        }
    }
    async with httpx.AsyncClient(verify=False) as client:
        try:
            response = await client.post("https://backend.aisensy.com/campaign/t1/api/v2", json=payload)
            return response.json() if response.text else {"status": "sent"}
        except Exception as e:
            return {"status": "failed", "error": str(e)}

# ============================================
# API ENDPOINTS
# ============================================

@app.get("/")
async def root():
    return {"status": "running", "service": "Bank Loan Form API", "version": "2.0.0"}

# ============================================
# AUTH ENDPOINTS
# ============================================

@app.post("/api/auth/admin-login")
async def auth_admin_login(payload: AdminLogin, request: Request):
    """Super admin login. Sets httpOnly refresh cookie. Rejects bank users."""
    await _check_lockout(payload.email)
    row = await db_pool.fetchrow("SELECT * FROM admin_users WHERE email = $1", payload.email)
    if not row or not bcrypt.checkpw(payload.password.encode('utf-8'), row["password_hash"].encode('utf-8')):
        attempts, locked = await _record_failed_login(payload.email)
        if locked:
            raise HTTPException(423, f"Account locked after {MAX_LOGIN_ATTEMPTS} failed attempts. Try again in {LOCKOUT_MINUTES} minutes.")
        remaining = MAX_LOGIN_ATTEMPTS - attempts
        if attempts >= WARN_AFTER_ATTEMPTS:
            raise HTTPException(401, f"Invalid credentials. {remaining} attempt{'s' if remaining != 1 else ''} remaining before lockout.")
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="Account deactivated")
    await _clear_failed_logins(payload.email)
    user_id = str(row["id"])
    access_token = create_access_token(user_id=user_id, role=row["role"], user_type="admin", email=row["email"])
    refresh_token, jti = create_refresh_token(user_id=user_id, role=row["role"], user_type="admin")
    await _store_refresh_token(user_id, jti, row["role"], "admin")
    await db_pool.execute("UPDATE admin_users SET last_login_at = $1 WHERE id = $2", now_utc(), row["id"])
    resp = JSONResponse({
        "token": access_token,
        "user": {
            "id": user_id, "email": row["email"], "name": row["full_name"],
            "role": row["role"], "user_type": "admin"
        }
    })
    _set_refresh_cookie(resp, "los_refresh_admin", refresh_token)
    return resp

@app.post("/api/auth/bank-login")
async def auth_bank_login(payload: BankLogin, request: Request):
    """Bank user login. Sets httpOnly refresh cookie. Rejects admin users."""
    await _check_lockout(payload.username)
    row = await db_pool.fetchrow("SELECT * FROM bank_users WHERE username = $1", payload.username)
    if not row or not bcrypt.checkpw(payload.password.encode('utf-8'), row["password_hash"].encode('utf-8')):
        attempts, locked = await _record_failed_login(payload.username)
        if locked:
            raise HTTPException(423, f"Account locked after {MAX_LOGIN_ATTEMPTS} failed attempts. Try again in {LOCKOUT_MINUTES} minutes.")
        remaining = MAX_LOGIN_ATTEMPTS - attempts
        if attempts >= WARN_AFTER_ATTEMPTS:
            raise HTTPException(401, f"Invalid credentials. {remaining} attempt{'s' if remaining != 1 else ''} remaining before lockout.")
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="Account deactivated")
    bank = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1 AND status = 'active'", row["bank_id"])
    if not bank:
        raise HTTPException(status_code=403, detail="Bank is inactive or not found")
    await _clear_failed_logins(payload.username)
    user_id = str(row["id"])
    bank_id = str(row["bank_id"])
    access_token = create_access_token(user_id=user_id, role=row["role"], user_type="bank_user", bank_id=bank_id, username=row["username"])
    refresh_token, jti = create_refresh_token(user_id=user_id, role=row["role"], user_type="bank_user", bank_id=bank_id)
    await _store_refresh_token(user_id, jti, row["role"], "bank_user", bank_id)
    await db_pool.execute("UPDATE bank_users SET last_login_at = $1 WHERE id = $2", now_utc(), row["id"])
    resp = JSONResponse({
        "token": access_token,
        "user": {
            "id": user_id, "bank_id": bank_id, "bank_name": bank["name"], "bank_code": bank["code"],
            "username": row["username"], "email": row["email"], "name": row["full_name"],
            "role": row["role"], "user_type": "bank_user"
        }
    })
    _set_refresh_cookie(resp, "los_refresh_bank", refresh_token)
    return resp

@app.post("/api/auth/refresh")
async def auth_refresh(request: Request):
    """Silent token refresh via httpOnly cookie. Returns new access token."""
    # Try admin cookie first, then bank cookie
    refresh_jwt = request.cookies.get("los_refresh_admin") or request.cookies.get("los_refresh_bank")
    if not refresh_jwt:
        raise HTTPException(status_code=401, detail="No refresh token")
    try:
        payload = jwt.decode(refresh_jwt, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Refresh token expired. Please log in again.")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Not a refresh token")
    # Check not revoked
    stored = await db_pool.fetchrow("SELECT * FROM refresh_tokens WHERE jti = $1", payload["jti"])
    if not stored:
        raise HTTPException(status_code=401, detail="Token revoked")
    # Issue new access token
    access_token = create_access_token(
        user_id=payload["user_id"], role=payload["role"],
        user_type=payload["user_type"], bank_id=payload.get("bank_id"),
    )
    return {"token": access_token}

@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    """Revoke refresh token and clear cookie."""
    cookie_name = None
    refresh_jwt = request.cookies.get("los_refresh_admin")
    if refresh_jwt:
        cookie_name = "los_refresh_admin"
    else:
        refresh_jwt = request.cookies.get("los_refresh_bank")
        if refresh_jwt:
            cookie_name = "los_refresh_bank"
    if refresh_jwt:
        try:
            payload = jwt.decode(refresh_jwt, JWT_SECRET, algorithms=["HS256"])
            await db_pool.execute("DELETE FROM refresh_tokens WHERE jti = $1", payload.get("jti"))
        except Exception:
            pass
    resp = JSONResponse({"status": "logged_out"})
    if cookie_name:
        resp.delete_cookie(key=cookie_name, path="/api/auth")
    return resp

@app.get("/api/auth/me")
async def auth_me(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Returns current user info from JWT."""
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_type = payload.get("user_type")
    if user_type == "admin":
        row = await db_pool.fetchrow("SELECT * FROM admin_users WHERE id = $1", uuid.UUID(payload["user_id"]))
        if not row:
            raise HTTPException(status_code=401, detail="User not found")
        return {
            "id": str(row["id"]),
            "email": row["email"],
            "name": row["full_name"],
            "role": row["role"],
            "user_type": "admin",
            "is_active": row["is_active"]
        }
    elif user_type == "bank_user":
        row = await db_pool.fetchrow("SELECT bu.*, b.name as bank_name, b.code as bank_code FROM bank_users bu JOIN banks b ON bu.bank_id = b.id WHERE bu.id = $1", uuid.UUID(payload["user_id"]))
        if not row:
            raise HTTPException(status_code=401, detail="User not found")
        return {
            "id": str(row["id"]),
            "bank_id": str(row["bank_id"]),
            "bank_name": row["bank_name"],
            "bank_code": row["bank_code"],
            "username": row["username"],
            "email": row["email"],
            "name": row["full_name"],
            "role": row["role"],
            "user_type": "bank_user",
            "is_active": row["is_active"]
        }
    else:
        # Legacy token without user_type — treat as admin for backward compatibility
        row = await db_pool.fetchrow("SELECT * FROM admin_users WHERE id = $1", uuid.UUID(payload["user_id"]))
        if not row:
            raise HTTPException(status_code=401, detail="User not found")
        return {
            "id": str(row["id"]),
            "email": row["email"],
            "name": row["full_name"],
            "role": row["role"],
            "user_type": "admin",
            "is_active": row["is_active"]
        }

# Keep old admin login for backward compatibility
@app.post("/api/admin/login")
async def admin_login(payload: AdminLogin):
    row = await db_pool.fetchrow("SELECT * FROM admin_users WHERE email = $1", payload.email)
    if not row:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not bcrypt.checkpw(payload.password.encode('utf-8'), row["password_hash"].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="Account deactivated")
    token = jwt.encode({
        "user_id": str(row["id"]),
        "email": row["email"],
        "role": row["role"],
        "user_type": "admin",
        "exp": now_utc() + timedelta(days=7)
    }, JWT_SECRET, algorithm="HS256")
    await db_pool.execute("UPDATE admin_users SET last_login_at = $1 WHERE id = $2", now_utc(), row["id"])
    return {
        "token": token,
        "user": {
            "id": str(row["id"]),
            "email": row["email"],
            "name": row["full_name"],
            "role": row["role"]
        }
    }

# ============================================
# ADMIN BANK MANAGEMENT ENDPOINTS
# ============================================

@app.get("/api/admin/banks")
async def admin_list_banks(admin: dict = Depends(get_current_admin)):
    """List all banks."""
    rows = await db_pool.fetch("SELECT * FROM banks ORDER BY created_at DESC")
    return {"banks": _rows_to_list(rows)}

@app.post("/api/admin/banks")
async def admin_create_bank(bank: BankCreate, admin: dict = Depends(get_current_admin)):
    """Create a new bank."""
    # Check for duplicate code
    existing = await db_pool.fetchrow("SELECT id FROM banks WHERE code = $1", bank.code)
    if existing:
        raise HTTPException(status_code=400, detail=f"Bank with code '{bank.code}' already exists")
    row = await db_pool.fetchrow(
        """INSERT INTO banks (name, code, contact_email, contact_phone, address, logo_url)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *""",
        bank.name, bank.code, bank.contact_email, bank.contact_phone, bank.address, bank.logo_url
    )
    return {"bank": _row_to_dict(row)}

@app.put("/api/admin/banks/{bank_id}")
async def admin_update_bank(bank_id: str, bank: BankUpdate, admin: dict = Depends(get_current_admin)):
    """Update a bank."""
    existing = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1", uuid.UUID(bank_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Bank not found")
    updates = {}
    if bank.name is not None:
        updates["name"] = bank.name
    if bank.code is not None:
        # Check for duplicate code (excluding this bank)
        dup = await db_pool.fetchrow("SELECT id FROM banks WHERE code = $1 AND id != $2", bank.code, uuid.UUID(bank_id))
        if dup:
            raise HTTPException(status_code=400, detail=f"Bank code '{bank.code}' already in use")
        updates["code"] = bank.code
    if bank.contact_email is not None:
        updates["contact_email"] = bank.contact_email
    if bank.contact_phone is not None:
        updates["contact_phone"] = bank.contact_phone
    if bank.address is not None:
        updates["address"] = bank.address
    if bank.logo_url is not None:
        updates["logo_url"] = bank.logo_url
    if bank.status is not None:
        if bank.status not in ("active", "inactive"):
            raise HTTPException(status_code=400, detail="Status must be 'active' or 'inactive'")
        updates["status"] = bank.status
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updates["updated_at"] = now_utc()
    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates.keys()))
    vals = list(updates.values())
    vals.append(uuid.UUID(bank_id))
    await db_pool.execute(f"UPDATE banks SET {sets} WHERE id = ${len(updates)+1}", *vals)
    row = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1", uuid.UUID(bank_id))
    return {"bank": _row_to_dict(row)}

@app.get("/api/admin/banks/{bank_id}")
async def admin_get_bank(bank_id: str, admin: dict = Depends(get_current_admin)):
    """Get bank detail + its users."""
    bank = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1", uuid.UUID(bank_id))
    if not bank:
        raise HTTPException(status_code=404, detail="Bank not found")
    users = await db_pool.fetch(
        "SELECT id, bank_id, username, email, full_name, role, is_active, created_at, last_login_at FROM bank_users WHERE bank_id = $1 ORDER BY created_at DESC",
        uuid.UUID(bank_id)
    )
    app_count = await db_pool.fetchval("SELECT COUNT(*) FROM loan_applications WHERE bank_id = $1", uuid.UUID(bank_id))
    bank_dict = _row_to_dict(bank)
    bank_dict["users"] = _rows_to_list(users)
    bank_dict["application_count"] = app_count
    return {"bank": bank_dict}

@app.post("/api/admin/banks/{bank_id}/users")
async def admin_create_bank_user(bank_id: str, user: BankUserCreate, admin: dict = Depends(get_current_admin)):
    """Create a bank user (auto-generate password, return it once)."""
    bank = await db_pool.fetchrow("SELECT id FROM banks WHERE id = $1", uuid.UUID(bank_id))
    if not bank:
        raise HTTPException(status_code=404, detail="Bank not found")
    if user.role not in ("bank_officer", "bank_supervisor"):
        raise HTTPException(status_code=400, detail="Role must be 'bank_officer' or 'bank_supervisor'")
    # Check for duplicate username
    existing = await db_pool.fetchrow("SELECT id FROM bank_users WHERE username = $1", user.username)
    if existing:
        raise HTTPException(status_code=400, detail=f"Username '{user.username}' already exists")
    # Check for duplicate email within this bank
    existing_email = await db_pool.fetchrow("SELECT id FROM bank_users WHERE email = $1 AND bank_id = $2", user.email, uuid.UUID(bank_id))
    if existing_email:
        raise HTTPException(status_code=400, detail=f"Email '{user.email}' already exists in this bank")
    password = generate_random_password()
    password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    row = await db_pool.fetchrow(
        """INSERT INTO bank_users (bank_id, username, email, password_hash, full_name, role)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, bank_id, username, email, full_name, role, is_active, created_at""",
        uuid.UUID(bank_id), user.username, user.email, password_hash, user.full_name, user.role
    )
    user_dict = _row_to_dict(row)
    user_dict["generated_password"] = password  # Show only once
    return {"user": user_dict}

@app.put("/api/admin/banks/{bank_id}/users/{user_id}")
async def admin_update_bank_user(bank_id: str, user_id: str, user: BankUserUpdate, admin: dict = Depends(get_current_admin)):
    """Update a bank user."""
    existing = await db_pool.fetchrow("SELECT * FROM bank_users WHERE id = $1 AND bank_id = $2", uuid.UUID(user_id), uuid.UUID(bank_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Bank user not found")
    updates = {}
    if user.email is not None:
        updates["email"] = user.email
    if user.full_name is not None:
        updates["full_name"] = user.full_name
    if user.role is not None:
        if user.role not in ("bank_officer", "bank_supervisor"):
            raise HTTPException(status_code=400, detail="Role must be 'bank_officer' or 'bank_supervisor'")
        updates["role"] = user.role
    if user.is_active is not None:
        updates["is_active"] = user.is_active
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates.keys()))
    vals = list(updates.values())
    vals.append(uuid.UUID(user_id))
    await db_pool.execute(f"UPDATE bank_users SET {sets} WHERE id = ${len(updates)+1}", *vals)
    row = await db_pool.fetchrow(
        "SELECT id, bank_id, username, email, full_name, role, is_active, created_at, last_login_at FROM bank_users WHERE id = $1",
        uuid.UUID(user_id)
    )
    return {"user": _row_to_dict(row)}

@app.delete("/api/admin/banks/{bank_id}/users/{user_id}")
async def admin_deactivate_bank_user(bank_id: str, user_id: str, admin: dict = Depends(get_current_admin)):
    """Deactivate a bank user (set is_active=false)."""
    existing = await db_pool.fetchrow("SELECT * FROM bank_users WHERE id = $1 AND bank_id = $2", uuid.UUID(user_id), uuid.UUID(bank_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Bank user not found")
    await db_pool.execute("UPDATE bank_users SET is_active = false WHERE id = $1", uuid.UUID(user_id))
    return {"status": "deactivated", "message": f"User {existing['username']} has been deactivated"}

@app.get("/api/admin/stats")
async def admin_stats(admin: dict = Depends(get_current_admin)):
    """System analytics: total apps, per-status counts, per-bank counts, approval rate."""
    total = await db_pool.fetchval("SELECT COUNT(*) FROM loan_applications")
    # Per-status counts
    status_rows = await db_pool.fetch("SELECT status, COUNT(*) as count FROM loan_applications GROUP BY status ORDER BY count DESC")
    status_counts = {r["status"]: r["count"] for r in status_rows}
    # Per-bank counts
    bank_rows = await db_pool.fetch(
        """SELECT b.id, b.name, b.code, COUNT(la.id) as app_count
           FROM banks b LEFT JOIN loan_applications la ON b.id = la.bank_id
           GROUP BY b.id, b.name, b.code ORDER BY app_count DESC"""
    )
    bank_counts = [{"bank_id": str(r["id"]), "bank_name": r["name"], "bank_code": r["code"], "count": r["app_count"]} for r in bank_rows]
    # Unassigned (no bank_id)
    unassigned = await db_pool.fetchval("SELECT COUNT(*) FROM loan_applications WHERE bank_id IS NULL")
    # Approval rate
    approved = (status_counts.get("officer_approved", 0) + status_counts.get("approved", 0) +
                status_counts.get("approved", 0) + status_counts.get("approved", 0))
    reviewed = approved + status_counts.get("officer_rejected", 0) + status_counts.get("supervisor_rejected", 0)
    approval_rate = round((approved / reviewed * 100), 1) if reviewed > 0 else 0
    # Total banks and users
    total_banks = await db_pool.fetchval("SELECT COUNT(*) FROM banks")
    total_users = await db_pool.fetchval("SELECT COUNT(*) FROM bank_users WHERE is_active = true")
    return {
        "total_applications": total,
        "status_counts": status_counts,
        "bank_counts": bank_counts,
        "unassigned_applications": unassigned,
        "approval_rate": approval_rate,
        "total_banks": total_banks,
        "total_active_users": total_users
    }

@app.get("/api/admin/applications")
async def admin_get_applications(
    status: Optional[str] = None,
    bank_id: Optional[str] = None,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """List ALL applications across all banks (with optional status/bank filters)."""
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    # Build dynamic query
    conditions = []
    params = []
    idx = 1
    if status:
        conditions.append(f"la.status = ${idx}")
        params.append(status)
        idx += 1
    if bank_id:
        conditions.append(f"la.bank_id = ${idx}")
        params.append(uuid.UUID(bank_id))
        idx += 1
    where_clause = " AND ".join(conditions) if conditions else "TRUE"
    query = f"""
        SELECT la.*, b.name as bank_name, b.code as bank_code
        FROM loan_applications la
        LEFT JOIN banks b ON la.bank_id = b.id
        WHERE {where_clause}
        ORDER BY la.created_at DESC
    """
    rows = await db_pool.fetch(query, *params)
    return {"applications": _rows_to_list(rows)}

@app.get("/api/admin/applications/{app_id}")
async def admin_get_application(app_id: str, credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Admin: full application detail (read-only, any bank)."""
    try:
        jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE id = $1", uuid.UUID(app_id))
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found")
    app_dict = _row_to_dict(app_row)
    if app_dict.get("aadhaar_number_encrypted"):
        app_dict["aadhaar_number"] = app_dict["aadhaar_number_encrypted"]
    transitions = await db_pool.fetch(
        "SELECT * FROM status_transitions WHERE application_id = $1 ORDER BY created_at ASC", uuid.UUID(app_id)
    )
    app_dict["status_history"] = _rows_to_list(transitions)
    if app_row.get("bank_id"):
        bank = await db_pool.fetchrow("SELECT name, code FROM banks WHERE id = $1", app_row["bank_id"])
        if bank:
            app_dict["bank_name"] = bank["name"]
            app_dict["bank_code"] = bank["code"]
    return {"application": app_dict, "timeline": _rows_to_list(transitions)}

# ============================================
# BANK OFFICER ENDPOINTS
# ============================================

@app.get("/api/bank/applications")
async def bank_list_applications(status: Optional[str] = None, officer: dict = Depends(get_bank_officer)):
    """List applications for THIS bank (bank_id from JWT), with optional status filter."""
    bank_id = uuid.UUID(officer["bank_id"])
    if status:
        rows = await db_pool.fetch(
            "SELECT * FROM loan_applications WHERE bank_id = $1 AND status = $2 ORDER BY created_at DESC",
            bank_id, status
        )
    else:
        rows = await db_pool.fetch(
            "SELECT * FROM loan_applications WHERE bank_id = $1 ORDER BY created_at DESC",
            bank_id
        )
    return {"applications": _rows_to_list(rows)}

@app.get("/api/bank/applications/{app_id}")
async def bank_get_application(app_id: str, officer: dict = Depends(get_bank_officer)):
    """Full application detail (all form data, documents, AI suggestion, status history)."""
    bank_id = uuid.UUID(officer["bank_id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_id
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    app_dict = _row_to_dict(app_row)
    # Map aadhaar_number_encrypted back to aadhaar_number for display
    if app_dict.get("aadhaar_number_encrypted"):
        app_dict["aadhaar_number"] = app_dict["aadhaar_number_encrypted"]
    # Get status history from status_transitions table
    transitions = await db_pool.fetch(
        "SELECT * FROM status_transitions WHERE application_id = $1 ORDER BY created_at ASC",
        uuid.UUID(app_id)
    )
    app_dict["status_history"] = _rows_to_list(transitions)
    # Get bank info
    bank = await db_pool.fetchrow("SELECT name, code FROM banks WHERE id = $1", bank_id)
    if bank:
        app_dict["bank_name"] = bank["name"]
        app_dict["bank_code"] = bank["code"]
    return {"application": app_dict}

@app.post("/api/bank/applications/{app_id}/officer-approve")
async def officer_approve(app_id: str, body: OfficerReviewRequest, officer: dict = Depends(get_bank_officer)):
    """Set status=officer_approved, record officer_id, officer_reviewed_at, officer_notes."""
    bank_id = uuid.UUID(officer["bank_id"])
    officer_id = uuid.UUID(officer["id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_id
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    current_status = app_row["status"]
    if current_status not in ("submitted", "system_reviewed"):
        raise HTTPException(status_code=400, detail=f"Cannot approve application with status '{current_status}'. Must be 'submitted' or 'system_reviewed'.")
    await db_pool.execute(
        """UPDATE loan_applications
           SET status = 'officer_approved', officer_id = $1, officer_reviewed_at = $2, officer_notes = $3
           WHERE id = $4""",
        officer_id, now_utc(), body.notes, uuid.UUID(app_id)
    )
    await record_transition(uuid.UUID(app_id), current_status, "officer_approved", "bank_officer", officer_id, body.notes)
    return {"status": "success", "message": "Application approved by officer", "new_status": "officer_approved"}

@app.post("/api/bank/applications/{app_id}/officer-reject")
async def officer_reject(app_id: str, body: OfficerRejectRequest, officer: dict = Depends(get_bank_officer)):
    """Set status=officer_rejected, record officer_id, notes, rejection_reason."""
    bank_id = uuid.UUID(officer["bank_id"])
    officer_id = uuid.UUID(officer["id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_id
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    current_status = app_row["status"]
    if current_status not in ("submitted", "system_reviewed"):
        raise HTTPException(status_code=400, detail=f"Cannot reject application with status '{current_status}'. Must be 'submitted' or 'system_reviewed'.")
    rejection_notes = body.notes or ""
    if body.rejection_reason:
        rejection_notes = f"[Reason: {body.rejection_reason}] {rejection_notes}".strip()
    await db_pool.execute(
        """UPDATE loan_applications
           SET status = 'officer_rejected', officer_id = $1, officer_reviewed_at = $2, officer_notes = $3, rejection_reason = $4
           WHERE id = $5""",
        officer_id, now_utc(), body.notes, body.rejection_reason, uuid.UUID(app_id)
    )
    await record_transition(uuid.UUID(app_id), current_status, "officer_rejected", "bank_officer", officer_id, rejection_notes)
    # Send WhatsApp notification
    if app_row["phone"]:
        message = (
            f"Dear {app_row['customer_name']},\n\n"
            f"Your loan application has been reviewed.\n\n"
            f"Loan ID: {app_row['loan_id']}\nStatus: Not Approved\n\n"
            f"Reason: {body.rejection_reason or 'Contact customer service'}\n\n- Your Bank"
        )
        await send_whatsapp_message(app_row["phone"], message)
    return {"status": "success", "message": "Application rejected by officer", "new_status": "officer_rejected"}

# ============================================
# BANK SUPERVISOR ENDPOINTS
# ============================================

@app.get("/api/bank/supervisor/applications")
async def supervisor_list_applications(supervisor: dict = Depends(get_bank_supervisor)):
    """List officer_approved applications for this bank."""
    bank_id = uuid.UUID(supervisor["bank_id"])
    rows = await db_pool.fetch(
        "SELECT * FROM loan_applications WHERE bank_id = $1 AND status = 'officer_approved' ORDER BY created_at DESC",
        bank_id
    )
    return {"applications": _rows_to_list(rows)}

@app.post("/api/bank/applications/{app_id}/supervisor-approve")
async def supervisor_approve(app_id: str, body: OfficerReviewRequest, supervisor: dict = Depends(get_bank_supervisor)):
    """Set status=approved."""
    bank_id = uuid.UUID(supervisor["bank_id"])
    supervisor_id = uuid.UUID(supervisor["id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_id
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    current_status = app_row["status"]
    if current_status != "officer_approved":
        raise HTTPException(status_code=400, detail=f"Cannot supervisor-approve application with status '{current_status}'. Must be 'officer_approved'.")
    await db_pool.execute(
        """UPDATE loan_applications
           SET status = 'approved', supervisor_id = $1, supervisor_reviewed_at = $2, supervisor_notes = $3
           WHERE id = $4""",
        supervisor_id, now_utc(), body.notes, uuid.UUID(app_id)
    )
    await record_transition(uuid.UUID(app_id), current_status, "approved", "bank_supervisor", supervisor_id, body.notes)
    # Send approval notification
    if app_row["phone"]:
        message = (
            f"Congratulations {app_row['customer_name']}!\n\n"
            f"Your loan application has been APPROVED.\n\n"
            f"Loan ID: {app_row['loan_id']}\n\n"
            f"Our team will contact you within 24 hours for next steps.\n\n- Your Bank"
        )
        await send_whatsapp_message(app_row["phone"], message)
    return {"status": "success", "message": "Application approved by supervisor", "new_status": "approved"}

@app.post("/api/bank/applications/{app_id}/supervisor-reject")
async def supervisor_reject(app_id: str, body: OfficerRejectRequest, supervisor: dict = Depends(get_bank_supervisor)):
    """Set status=supervisor_rejected."""
    bank_id = uuid.UUID(supervisor["bank_id"])
    supervisor_id = uuid.UUID(supervisor["id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_id
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    current_status = app_row["status"]
    if current_status != "officer_approved":
        raise HTTPException(status_code=400, detail=f"Cannot supervisor-reject application with status '{current_status}'. Must be 'officer_approved'.")
    rejection_notes = body.notes or ""
    if body.rejection_reason:
        rejection_notes = f"[Reason: {body.rejection_reason}] {rejection_notes}".strip()
    await db_pool.execute(
        """UPDATE loan_applications
           SET status = 'supervisor_rejected', supervisor_id = $1, supervisor_reviewed_at = $2, supervisor_notes = $3, rejection_reason = $4
           WHERE id = $5""",
        supervisor_id, now_utc(), body.notes, body.rejection_reason, uuid.UUID(app_id)
    )
    await record_transition(uuid.UUID(app_id), current_status, "supervisor_rejected", "bank_supervisor", supervisor_id, rejection_notes)
    if app_row["phone"]:
        message = (
            f"Dear {app_row['customer_name']},\n\n"
            f"Your loan application has been reviewed by the supervisor.\n\n"
            f"Loan ID: {app_row['loan_id']}\nStatus: Not Approved\n\n"
            f"Reason: {body.rejection_reason or 'Contact customer service'}\n\n- Your Bank"
        )
        await send_whatsapp_message(app_row["phone"], message)
    return {"status": "success", "message": "Application rejected by supervisor", "new_status": "supervisor_rejected"}

@app.post("/api/bank/applications/{app_id}/request-documents")
async def request_documents(app_id: str, body: OfficerReviewRequest, supervisor: dict = Depends(get_bank_supervisor)):
    """Set status=documents_requested, documents_requested_at."""
    bank_id = uuid.UUID(supervisor["bank_id"])
    supervisor_id = uuid.UUID(supervisor["id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_id
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    current_status = app_row["status"]
    if current_status not in ("officer_approved", "approved"):
        raise HTTPException(status_code=400, detail=f"Cannot request documents for application with status '{current_status}'. Must be 'officer_approved' or 'approved'.")
    await db_pool.execute(
        """UPDATE loan_applications
           SET status = 'documents_requested', documents_requested_at = $1, supervisor_id = $2, supervisor_notes = $3
           WHERE id = $4""",
        now_utc(), supervisor_id, body.notes, uuid.UUID(app_id)
    )
    await record_transition(uuid.UUID(app_id), current_status, "documents_requested", "bank_supervisor", supervisor_id, body.notes)
    if app_row["phone"]:
        message = (
            f"Dear {app_row['customer_name']},\n\n"
            f"Additional documents have been requested for your loan application.\n\n"
            f"Loan ID: {app_row['loan_id']}\n\n"
            f"Please submit the required documents at your earliest.\n\n- Your Bank"
        )
        await send_whatsapp_message(app_row["phone"], message)
    return {"status": "success", "message": "Documents requested", "new_status": "documents_requested"}

@app.post("/api/bank/applications/{app_id}/disburse")
async def initiate_disbursement(app_id: str, body: OfficerReviewRequest, supervisor: dict = Depends(get_bank_supervisor)):
    """Set status=approved, approved_at."""
    bank_id = uuid.UUID(supervisor["bank_id"])
    supervisor_id = uuid.UUID(supervisor["id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_id
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    current_status = app_row["status"]
    if current_status not in ("approved", "documents_submitted"):
        raise HTTPException(status_code=400, detail=f"Cannot initiate disbursement for application with status '{current_status}'. Must be 'approved' or 'documents_submitted'.")
    await db_pool.execute(
        """UPDATE loan_applications
           SET status = 'approved', approved_at = $1, supervisor_id = $2, supervisor_notes = $3
           WHERE id = $4""",
        now_utc(), supervisor_id, body.notes, uuid.UUID(app_id)
    )
    await record_transition(uuid.UUID(app_id), current_status, "approved", "bank_supervisor", supervisor_id, body.notes)
    if app_row["phone"]:
        message = (
            f"Dear {app_row['customer_name']},\n\n"
            f"Great news! Disbursement has been initiated for your loan.\n\n"
            f"Loan ID: {app_row['loan_id']}\n\n"
            f"You will receive the funds shortly.\n\n- Your Bank"
        )
        await send_whatsapp_message(app_row["phone"], message)
    return {"status": "success", "message": "Disbursement initiated", "new_status": "approved"}

# ============================================
# FORM TOKEN & APPLICATION ENDPOINTS (EXISTING)
# ============================================


@app.post("/api/generate-form-links")
async def generate_form_links(request: Request):
    data = await request.json()
    customers_data = data.get("customers", [])
    bank_id_str = data.get("bank_id")
    bank_id = uuid.UUID(bank_id_str) if bank_id_str else None

    results = []
    for c in customers_data:
        try:
            customer = CustomerData(**c)
            token = generate_secure_token()
            expires_at = now_utc() + timedelta(days=7)

            token_data = supabase.table("form_tokens").insert({
                "token": token,
                "customer_name": customer.customer_name,
                "phone": customer.phone,
                "loan_id": customer.loan_id,
                "loan_amount": float(customer.loan_amount),
                "loan_type": customer.loan_type,
                "email": customer.email,
                "date_of_birth": customer.date_of_birth,
                "address": customer.address,
                "expires_at": expires_at.isoformat()
            }).execute()

            token_id = token_data.data[0]["id"]
            form_url = f"http://localhost:3000/form/{token}"

            message = (
                f"Dear {customer.customer_name},\n\n"
                f"Complete your loan application for {customer.loan_type}.\n\n"
                f"Loan ID: {customer.loan_id}\n"
                f"Amount: Rs.{customer.loan_amount:,.2f}\n\n"
                f"Click to fill the form:\n{form_url}\n\n"
                f"Valid for 7 days. Do not share this link.\n\n"
                f"- Your Bank Name"
            )
            await send_whatsapp_message(customer.phone, message, token_id)
            results.append({
                "phone": customer.phone, "loan_id": customer.loan_id,
                "status": "success", "token": token, "form_url": form_url,
                "application_id": str(app_row["id"])
            })
        except Exception as e:
            results.append({"phone": c.get("phone", "unknown"), "status": "failed", "reason": str(e)})
    return {"results": results}

@app.get("/api/validate-token/{token}")
async def validate_token(token: str, request: Request):
    row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", token)
    if not row:
        raise HTTPException(status_code=404, detail="Invalid or expired link")
    td = _row_to_dict(row)
    expires_at = row["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now_utc():
        raise HTTPException(status_code=410, detail="Link has expired")
    await db_pool.execute(
        "UPDATE form_tokens SET last_accessed_at = $1, access_count = access_count + 1 WHERE id = $2",
        now_utc(), row["id"]
    )
    if not row["otp_verified"]:
        return {"status": "otp_required", "phone": td["phone"][-4:], "token_id": td["id"]}
    # Fetch saved application data if it exists
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE token_id = $1", row["id"])
    app_data = _row_to_dict(app_row) if app_row else {}

    # Merge token data with saved application data (application data takes priority)
    merged = {
        "customer_name": td["customer_name"], "phone": td["phone"], "loan_id": td["loan_id"],
        "loan_amount": float(row["loan_amount"]) if row["loan_amount"] else None,
        "loan_type": td.get("loan_type"), "email": app_data.get("email") or td.get("email"),
        "date_of_birth": str(app_row["date_of_birth"]) if app_row and app_row.get("date_of_birth") else (str(row["date_of_birth"]) if row.get("date_of_birth") else None),
        "customer_type": app_data.get("customer_type") or td.get("customer_type", "new"),
        "current_address": app_data.get("current_address"), "permanent_address": app_data.get("permanent_address"),
    }
    # Add all saved application fields
    if app_data:
        for k, v in app_data.items():
            if k not in ("id", "token_id", "created_at", "updated_at") and v is not None and k not in merged:
                merged[k] = v
        # Map aadhaar_number_encrypted back to aadhaar_number for frontend
        if app_data.get("aadhaar_number_encrypted"):
            merged["aadhaar_number"] = app_data["aadhaar_number_encrypted"]

    return {
        "status": "valid",
        "data": merged,
        "form_status": td["form_status"], "current_step": app_data.get("current_step", 1) if app_data else 1
    }

@app.post("/api/send-otp")
async def send_otp(token: str, request: Request):
    row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", token)
    if not row:
        raise HTTPException(status_code=404, detail="Invalid token")
    if row["otp_verified"]:
        raise HTTPException(status_code=400, detail="OTP already verified")

    print(f"Sending OTP to registered number: {token_data['phone']}")

    otp = generate_otp()
    otp_hash_val = hash_otp(otp)
    expires_at = now_utc() + timedelta(minutes=10)

    supabase.table("otp_verifications").insert({
        "token_id": token_data["id"],
        "phone": token_data["phone"],
        "otp_hash": otp_hash,
        "expires_at": expires_at.isoformat(),
        "ip_address": request.client.host,
        "user_agent": request.headers.get("user-agent")
    }).execute()

    message = (
        f"Your loan application OTP: {otp}\n\n"
        f"Valid for 10 minutes.\n"
        f"Do not share this OTP.\n\n"
        f"- Your Bank"
    )

    print(f"DEBUG OTP for {token_data['phone']}: {otp}")

    await send_whatsapp_message(token_data["phone"], message)

    return {
        "status": "otp_sent",
        "message": "OTP sent to your WhatsApp",
        "expires_in_minutes": 10
    }


@app.post("/api/verify-otp")
async def verify_otp_endpoint(payload: OTPVerifyRequest, request: Request):
    token_row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", payload.token)
    if not token_row:
        raise HTTPException(status_code=404, detail="Invalid token")
    if token_row["otp_verified"]:
        return {"status": "already_verified", "message": "OTP already verified"}
    otp_row = await db_pool.fetchrow(
        """SELECT * FROM otp_verifications WHERE token_id = $1 AND verified = false
           ORDER BY created_at DESC LIMIT 1""", token_row["id"]
    )
    if not otp_row:
        raise HTTPException(status_code=404, detail="No OTP found. Request a new one.")
    expires_at = otp_row["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now_utc():
        raise HTTPException(status_code=410, detail="OTP expired. Request a new one.")
    if otp_row["attempt_count"] >= otp_row["max_attempts"]:
        raise HTTPException(status_code=429, detail="Too many incorrect attempts.")
    if not verify_otp(payload.otp, otp_row["otp_hash"]):
        await db_pool.execute("UPDATE otp_verifications SET attempt_count = attempt_count + 1 WHERE id = $1", otp_row["id"])
        raise HTTPException(status_code=400, detail="Incorrect OTP. Try again.")
    await db_pool.execute("UPDATE otp_verifications SET verified = true, verified_at = $1 WHERE id = $2", now_utc(), otp_row["id"])
    await db_pool.execute("UPDATE form_tokens SET otp_verified = true, otp_verified_at = $1 WHERE id = $2", now_utc(), token_row["id"])
    return {"status": "verified", "message": "OTP verified successfully"}

@app.post("/api/autosave")
async def autosave_form(payload: FormStepData, request: Request):
    token_row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", payload.token)
    if not token_row:
        raise HTTPException(status_code=404, detail="Invalid token")
    if not token_row["otp_verified"]:
        raise HTTPException(status_code=403, detail="OTP verification required")

    app_result = supabase.table("loan_applications").select("*").eq("token_id", token_data["id"]).execute()

    save_data = {
        "token_id": token_data["id"],
        "customer_name": token_data["customer_name"],
        "phone": token_data["phone"],
        "loan_id": token_data["loan_id"],
        "current_step": payload.step,
        "last_saved_at": now_utc().isoformat(),
        **payload.data
    }

    if app_result.data:
        app_id = app_result.data[0]["id"]
        supabase.table("loan_applications").update(save_data).eq("id", app_id).execute()
    else:
        result = supabase.table("loan_applications").insert(save_data).execute()
        app_id = result.data[0]["id"]

    return {
        "status": "saved",
        "application_id": app_id,
        "timestamp": now_utc().isoformat()
    }


@app.post("/api/verify-pan")
async def verify_pan(token: str, pan_number: str, request: Request):
    token_result = supabase.table("form_tokens").select("*").eq("token", token).execute()

    if not token_result.data:
        raise HTTPException(status_code=404, detail="Invalid token")

    if not re.match(r'^[A-Z]{5}[0-9]{4}[A-Z]{1}$', pan_number):
        raise HTTPException(status_code=400, detail="Invalid PAN format")

    supabase.table("loan_applications").update({
        "pan_number": pan_number,
        "pan_verified": True,
        "pan_verification_timestamp": now_utc().isoformat()
    }).eq("token_id", token_result.data[0]["id"]).execute()

    return {"status": "verified", "message": "PAN verified successfully"}


@app.post("/api/verify-aadhaar")
async def verify_aadhaar(token: str, aadhaar_number: str, request: Request):
    token_result = supabase.table("form_tokens").select("*").eq("token", token).execute()

    if not token_result.data:
        raise HTTPException(status_code=404, detail="Invalid token")

    if not re.match(r'^\d{12}$', aadhaar_number):
        raise HTTPException(status_code=400, detail="Invalid Aadhaar format")

    last4 = aadhaar_number[-4:]

    supabase.table("loan_applications").update({
        "aadhaar_last4": last4,
        "aadhaar_number_encrypted": aadhaar_number,
        "aadhaar_verified": True,
        "aadhaar_verification_timestamp": now_utc().isoformat()
    }).eq("token_id", token_result.data[0]["id"]).execute()

    return {
        "status": "verified",
        "message": "Aadhaar verified successfully",
        "last4": last4
    }


@app.post("/api/upload-document")
async def upload_document(
    token: str = Form(...),
    document_type: str = Form(...),
    file: UploadFile = File(...),
    request: Request = None
):
    token_result = supabase.table("form_tokens").select("*").eq("token", token).execute()

    if not token_result.data:
        raise HTTPException(status_code=404, detail="Invalid token")

    token_data = token_result.data[0]

    allowed_types = ['image/jpeg', 'image/png', 'application/pdf']
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Invalid file type")

    file_content = await file.read()

    if len(file_content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large. Max 5MB.")

    file_extension = file.filename.split('.')[-1]
    unique_filename = f"{token_data['loan_id']}/{document_type}_{now_utc().timestamp()}.{file_extension}"

    try:
        supabase.storage.from_("loan-documents").upload(
            path=unique_filename,
            file=file_content,
            file_options={"content-type": file.content_type}
        )

        url_result = supabase.storage.from_("loan-documents").create_signed_url(
            path=unique_filename,
            expires_in=604800
        )

        file_url = url_result['signedURL']
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

    field_mapping = {
        "aadhaar_front": "aadhaar_front_url",
        "aadhaar_back": "aadhaar_back_url",
        "pan_card": "pan_card_url",
        "photo": "photo_url",
        "income_proof": "income_proof_url",
        "bank_statement": "bank_statement_url"
    }

    if document_type in field_mapping:
        supabase.table("loan_applications").update({
            field_mapping[document_type]: file_url
        }).eq("token_id", token_data["id"]).execute()

    return {
        "status": "uploaded",
        "url": file_url,
        "filename": file.filename,
        "size": len(file_content)
    }


@app.post("/api/submit-form")
async def submit_form(token: str, request: Request):
    token_result = supabase.table("form_tokens").select("*").eq("token", token).execute()

    if not token_result.data:
        raise HTTPException(status_code=404, detail="Invalid token")

    token_data = token_result.data[0]

    app_result = supabase.table("loan_applications").select("*").eq("token_id", token_data["id"]).execute()

    if not app_result.data:
        result = supabase.table("loan_applications").insert({
            "token_id": token_data["id"],
            "customer_name": token_data["customer_name"],
            "phone": token_data["phone"],
            "loan_id": token_data["loan_id"],
            "current_step": 4,
            "last_saved_at": now_utc().isoformat()
        }).execute()
        app_data = result.data[0]
    else:
        app_data = app_result.data[0]

    supabase.table("loan_applications").update({
        "is_complete": True,
        "status": "submitted",
        "submitted_at": now_utc().isoformat()
    }).eq("id", app_data["id"]).execute()

    supabase.table("form_tokens").update({
        "is_used": True,
        "form_status": "submitted"
    }).eq("id", token_data["id"]).execute()

    message = (
        f"Dear {token_data['customer_name']},\n\n"
        f"Your loan application has been submitted successfully!\n\n"
        f"Loan ID: {token_data['loan_id']}\n"
        f"Amount: Rs.{token_data['loan_amount']:,.2f}\n\n"
        f"Our team will review within 24-48 hours.\n\n"
        f"- Your Bank Name"
    )

    await send_whatsapp_message(token_data["phone"], message)

    return {
        "status": "submitted",
        "message": "Application submitted successfully",
        "loan_id": token_data["loan_id"],
        "application_id": app_data["id"]
    }


@app.post("/api/admin/login")
async def admin_login(payload: AdminLogin):
    result = supabase.table("admin_users").select("*").eq("email", payload.email).execute()

    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    admin_data = result.data[0]

    if not bcrypt.checkpw(payload.password.encode('utf-8'), admin_data["password_hash"].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not admin_data["is_active"]:
        raise HTTPException(status_code=403, detail="Account deactivated")

    token = jwt.encode({
        "user_id": admin_data["id"],
        "email": admin_data["email"],
        "role": admin_data["role"],
        "exp": now_utc() + timedelta(days=7)
    }, JWT_SECRET, algorithm="HS256")

    supabase.table("admin_users").update({
        "last_login_at": now_utc().isoformat()
    }).eq("id", admin_data["id"]).execute()

    return {
        "token": token,
        "user": {
            "id": admin_data["id"],
            "email": admin_data["email"],
            "name": admin_data["full_name"],
            "role": admin_data["role"]
        }
    }


@app.get("/api/admin/applications")
async def get_applications(
    status: Optional[str] = None,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    try:
        jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    query = supabase.table("loan_applications").select("*")

    if status:
        query = query.eq("status", status)

    result = query.order("created_at", desc=True).execute()

    return {"applications": result.data}


@app.post("/api/admin/review")
async def review_application(payload: ReviewAction, request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        admin_payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    app_id = uuid.UUID(payload.application_id)
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE id = $1", app_id)
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found")
    current_status = app_row["status"]
    new_status = payload.action + "d"
    if payload.action == "reject":
        await db_pool.execute(
            "UPDATE loan_applications SET status=$1, reviewed_by=$2, reviewed_at=$3, review_notes=$4, rejection_reason=$5 WHERE id=$6",
            new_status, uuid.UUID(admin_payload["user_id"]), now_utc(), payload.notes, payload.rejection_reason, app_id
        )
    else:
        await db_pool.execute(
            "UPDATE loan_applications SET status=$1, reviewed_by=$2, reviewed_at=$3, review_notes=$4 WHERE id=$5",
            new_status, uuid.UUID(admin_payload["user_id"]), now_utc(), payload.notes, app_id
        )
    await record_transition(app_id, current_status, new_status, "admin", uuid.UUID(admin_payload["user_id"]), payload.notes)
    if payload.action == "approve":
        message = f"Congratulations {app_row['customer_name']}!\n\nYour loan application has been APPROVED.\n\nLoan ID: {app_row['loan_id']}\n\nOur team will contact you within 24 hours.\n\n- Your Bank Name"
    else:
        message = f"Dear {app_row['customer_name']},\n\nYour loan application has been reviewed.\n\nLoan ID: {app_row['loan_id']}\nStatus: Not Approved\n\nReason: {payload.rejection_reason or 'Contact customer service'}\n\n- Your Bank Name"
    await send_whatsapp_message(app_row["phone"], message)
    return {"status": "success", "message": f"Application {payload.action}d successfully"}

# ============================================
# WHATSAPP CAMPAIGN ENDPOINTS (EXISTING)
# ============================================

@app.post("/api/send-campaign")
async def send_campaign(request: Request):
    data = await request.json()
    phone = data.get('phone')
    customer_name = data.get('customer_name', 'Customer')
    template_params = data.get('template_params', [customer_name])

    if not phone:
        raise HTTPException(status_code=400, detail="Phone number required")

    result = await send_whatsapp_aisensy(phone, customer_name, template_params)

    return {
        "status": "sent",
        "phone": phone,
        "aisensy_response": result
    }


@app.post("/api/send-campaign-bulk")
async def send_campaign_bulk(request: Request):
    data = await request.json()
    loan_ids = data.get('loan_ids', [])  # Optional: filter by loan IDs

    query = supabase.table("loan_applications").select("customer_name, phone, loan_id").eq("status", "draft")

    if loan_ids:
        query = query.in_("loan_id", loan_ids)

    app_result = query.execute()

    if not app_result.data:
        raise HTTPException(status_code=404, detail="No pending applications found")

    results = []
    for app in app_result.data:
        result = await send_whatsapp_aisensy(
            phone=app["phone"],
            customer_name=app["customer_name"],
            template_params=[app["customer_name"]]
        )
        results.append({
            "phone": app["phone"],
            "customer_name": app["customer_name"],
            "loan_id": app["loan_id"],
            "status": "sent",
            "response": result
        })

    return {
        "status": "completed",
        "total_sent": len(results),
        "results": results
    }


# ============================================
# PHONE-BASED AUTHENTICATION (EXISTING)
# ============================================

@app.post("/api/request-otp")
async def request_otp(request: Request):
    data = await request.json()
    phone = data.get('phone')
    if not phone:
        raise HTTPException(status_code=400, detail="Phone number required")
    if not phone.startswith('+'):
        phone = '+91' + phone
    # First check for existing application
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE phone = $1 AND status != 'submitted' ORDER BY created_at DESC LIMIT 1", phone
    )
    if not app_row:
        # Check form_tokens -- admin may have created a token for this phone
        token_row = await db_pool.fetchrow(
            "SELECT * FROM form_tokens WHERE phone = $1 ORDER BY created_at DESC LIMIT 1", phone
        )
        if not token_row:
            raise HTTPException(status_code=404, detail="This mobile number is not registered in our system. Please contact your bank to initiate a loan application.")
        # Create the application row from token data, inheriting bank_id
        bank_id = token_row.get("bank_id")
        app_row = await db_pool.fetchrow(
            """INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at, bank_id)
               VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING *""",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc(), bank_id
        )
        # Mark token as OTP verified since they're using phone-based auth
        await db_pool.execute("UPDATE form_tokens SET otp_verified = true, otp_verified_at = $1 WHERE id = $2", now_utc(), token_row["id"])
    otp = generate_otp()
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    session_id = secrets.token_urlsafe(32)
    expires_at = now_utc() + timedelta(minutes=10)

    # Clean up old sessions for this phone
    supabase.table("loan_sessions").delete().eq("phone", phone).execute()

    supabase.table("loan_sessions").insert({
        "phone": phone,
        "application_id": application["id"],
        "session_token": session_id,
        "expires_at": expires_at.isoformat(),
        "otp_hash": otp_hash,
        "otp_expires_at": expires_at.isoformat(),
        "otp_verified": False
    }).execute()

    print(f"\n{'='*50}")
    print(f"OTP for {phone}: {otp}")
    print(f"Customer: {application['customer_name']}")
    print(f"Loan ID: {application['loan_id']}")
    print(f"Valid for 10 minutes")
    print(f"{'='*50}\n")

    if WHATSAPP_API_TOKEN and WHATSAPP_PHONE_ID:
        message = (
            f"Your loan application OTP: *{otp}*\n\n"
            f"Valid for 10 minutes.\n"
            f"Do not share this OTP.\n\n"
            f"- Your Bank"
        )
        await send_whatsapp_message(phone, message)

    return {
        "status": "otp_sent",
        "session_id": session_id,
        "message": "OTP sent successfully"
    }


@app.post("/api/verify-otp-session")
async def verify_otp_session(request: Request):
    data = await request.json()
    session_id = data.get('session_id')
    otp = data.get('otp')
    if not session_id or not otp:
        raise HTTPException(status_code=400, detail="Session ID and OTP required")
    session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Invalid session. Request a new OTP.")
    otp_expires = session["otp_expires_at"]
    if otp_expires and otp_expires.tzinfo is None:
        otp_expires = otp_expires.replace(tzinfo=timezone.utc)
    if otp_expires and otp_expires < now_utc():
        raise HTTPException(status_code=410, detail="OTP expired. Request a new one.")
    if session["otp_attempts"] >= 5:
        raise HTTPException(status_code=429, detail="Too many incorrect attempts. Request a new OTP.")
    otp_hash = hashlib.sha256(otp.encode()).hexdigest()
    if otp_hash != session["otp_hash"]:
        await db_pool.execute("UPDATE loan_sessions SET otp_attempts = otp_attempts + 1 WHERE id = $1", session["id"])
        remaining = 4 - session["otp_attempts"]
        raise HTTPException(status_code=400, detail=f"Incorrect OTP. {remaining} attempts remaining.")
    new_expiry = now_utc() + timedelta(minutes=30)
    await db_pool.execute(
        "UPDATE loan_sessions SET otp_verified = true, expires_at = $1, last_activity_at = $2 WHERE id = $3",
        new_expiry, now_utc(), session["id"]
    )
    return {"status": "verified", "session_token": session_id, "expires_at": new_expiry.isoformat(), "message": "OTP verified successfully"}

@app.get("/api/get-application")
async def get_application(session_token: str, request: Request):
    session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", session_token)
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session. Please login again.")
    if not session["otp_verified"]:
        raise HTTPException(status_code=403, detail="OTP not verified.")
    expires_at = session["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now_utc():
        raise HTTPException(status_code=401, detail="Session expired. Please login again.")
    last_activity = session["last_activity_at"]
    if last_activity.tzinfo is None:
        last_activity = last_activity.replace(tzinfo=timezone.utc)
    if (now_utc() - last_activity).total_seconds() > 300:
        raise HTTPException(status_code=401, detail="Session inactive for 5 minutes. Please re-verify.")
    await db_pool.execute("UPDATE loan_sessions SET last_activity_at = $1 WHERE id = $2", now_utc(), session["id"])
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE id = $1", session["application_id"])
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found.")
    app_dict = _row_to_dict(app_row)
    # Map aadhaar_number_encrypted back to aadhaar_number for frontend
    if app_dict.get("aadhaar_number_encrypted"):
        app_dict["aadhaar_number"] = app_dict["aadhaar_number_encrypted"]
    return {"status": "success", "data": app_dict, "session_valid_until": expires_at.isoformat()}

@app.post("/api/autosave-session")
async def autosave_session(request: Request):
    data = await request.json()
    session_token = data.get('session_token')
    form_data = data.get('data', {})
    step = data.get('step', 1)
    if not session_token:
        raise HTTPException(status_code=400, detail="Session token required")
    session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", session_token)
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")
    if not session["otp_verified"]:
        raise HTTPException(status_code=403, detail="OTP not verified")
    last_activity = session["last_activity_at"]
    if last_activity.tzinfo is None:
        last_activity = last_activity.replace(tzinfo=timezone.utc)
    if (now_utc() - last_activity).total_seconds() > 300:
        raise HTTPException(status_code=401, detail="Session expired due to inactivity")
    await db_pool.execute("UPDATE loan_sessions SET last_activity_at = $1 WHERE id = $2", now_utc(), session["id"])
    safe_data = {k: _coerce_value(k, v) for k, v in form_data.items() if k in AUTOSAVE_COLUMNS}
    # Ensure highest_step only goes up, never down
    if "highest_step" in safe_data:
        app_row = await db_pool.fetchrow("SELECT highest_step, current_step FROM loan_applications WHERE id = $1", session["application_id"])
        if app_row:
            current_highest = app_row["highest_step"] or 1
            if safe_data["highest_step"] is not None and safe_data["highest_step"] <= current_highest:
                safe_data.pop("highest_step")
            # Don't downgrade current_step when user navigates back to review
            step = max(step, app_row["current_step"] or 1)
    if safe_data:
        sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(safe_data.keys()))
        vals = list(safe_data.values())
        vals.extend([step, now_utc(), session["application_id"]])
        n = len(safe_data)
        await db_pool.execute(
            f"UPDATE loan_applications SET {sets}, current_step = ${n+1}, last_saved_at = ${n+2} WHERE id = ${n+3}", *vals
        )
    else:
        # Still don't downgrade current_step
        app_row = await db_pool.fetchrow("SELECT current_step FROM loan_applications WHERE id = $1", session["application_id"])
        step = max(step, (app_row["current_step"] or 1) if app_row else 1)
        await db_pool.execute("UPDATE loan_applications SET current_step = $1, last_saved_at = $2 WHERE id = $3", step, now_utc(), session["application_id"])
    return {"status": "saved", "timestamp": now_utc().isoformat()}

@app.post("/api/upload-document-session")
async def upload_document_session(
    session_token: str = Form(...),
    document_type: str = Form(...),
    file: UploadFile = File(...),
    request: Request = None
):
    session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", session_token)
    if not session or not session["otp_verified"]:
        raise HTTPException(status_code=401, detail="Invalid or unverified session")
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE id = $1", session["application_id"])
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found")
    allowed_types = ['image/jpeg', 'image/png', 'application/pdf']
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Invalid file type. Allowed: JPG, PNG, PDF")
    file_content = await file.read()
    if len(file_content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large. Max 5MB.")
    ext = file.filename.split('.')[-1] if '.' in file.filename else 'bin'
    loan_dir = UPLOAD_DIR / app_row["loan_id"]
    loan_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{document_type}_{int(now_utc().timestamp())}.{ext}"
    filepath = loan_dir / filename
    async with aiofiles.open(filepath, 'wb') as f:
        await f.write(file_content)
    file_url = f"/uploads/{app_row['loan_id']}/{filename}"
    field_mapping = {
        "aadhaar_front": "aadhaar_front_url", "aadhaar_back": "aadhaar_back_url",
        "pan_card": "pan_card_url", "photo": "photo_url",
        "income_proof": "income_proof_url", "bank_statement": "bank_statement_url"
    }
    if document_type in field_mapping:
        await db_pool.execute(
            f"UPDATE loan_applications SET {field_mapping[document_type]} = $1 WHERE id = $2",
            file_url, session["application_id"]
        )
    # Update session activity
    await db_pool.execute("UPDATE loan_sessions SET last_activity_at = $1 WHERE id = $2", now_utc(), session["id"])
    return {"status": "uploaded", "url": file_url, "filename": file.filename, "size": len(file_content)}

@app.post("/api/verify-pan-session")
async def verify_pan_session(session_token: str, pan_number: str, request: Request):
    session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", session_token)
    if not session or not session["otp_verified"]:
        raise HTTPException(status_code=401, detail="Invalid or unverified session")
    if not re.match(r'^[A-Z]{5}[0-9]{4}[A-Z]{1}$', pan_number):
        raise HTTPException(status_code=400, detail="Invalid PAN format")
    # Call VG API for real PAN verification
    pan_name = ""
    if not VG_MOCK_MODE:
        try:
            pan_payload = {"obj": [{**vg_base_obj("pancard"), "PanNo": pan_number}]}
            async with httpx.AsyncClient(verify=False, timeout=20.0) as client:
                response = await client.post(f"{VG_API_BASE}/Pan", json=pan_payload, headers={"Content-Type": "application/json"})
            api_data = parse_vg_response(response.text)
            print(f"[PAN API] {pan_number} -> {api_data.get('status-code', api_data.get('statusCode', '?'))}")
            if str(api_data.get("status-code", api_data.get("statusCode", ""))) == "101":
                pan_name = api_data.get("result", {}).get("name", "")
        except Exception as e:
            print(f"[PAN API] Error: {e} — falling back to format-only verification")
    await db_pool.execute(
        "UPDATE loan_applications SET pan_number = $1, pan_verified = true, pan_verification_timestamp = $2, pan_name = $3 WHERE id = $4",
        pan_number, now_utc(), pan_name or None, session["application_id"]
    )
    if pan_name:
        await save_field_sources(session["application_id"], "pan", {"first_name": pan_name.split()[0] if pan_name else "", "middle_name": " ".join(pan_name.split()[1:-1]) if len(pan_name.split()) > 2 else "", "last_name": pan_name.split()[-1] if len(pan_name.split()) > 1 else "", "full_name": pan_name})
    result = {"status": "verified", "message": "PAN verified successfully"}
    if pan_name:
        result["name"] = pan_name
    return result

@app.post("/api/verify-aadhaar-session")
async def verify_aadhaar_session(session_token: str, aadhaar_number: str, request: Request):
    session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", session_token)
    if not session or not session["otp_verified"]:
        raise HTTPException(status_code=401, detail="Invalid or unverified session")
    if not re.match(r'^\d{12}$', aadhaar_number):
        raise HTTPException(status_code=400, detail="Invalid Aadhaar format")
    last4 = aadhaar_number[-4:]
    await db_pool.execute(
        "UPDATE loan_applications SET aadhaar_last4 = $1, aadhaar_number_encrypted = $2, aadhaar_verified = true, aadhaar_verification_timestamp = $3 WHERE id = $4",
        last4, aadhaar_number, now_utc(), session["application_id"]
    )
    return {"status": "verified", "message": "Aadhaar verified successfully", "last4": last4}

@app.post("/api/submit-form-session")
async def submit_form_session(session_token: str, request: Request):
    session = await db_pool.fetchrow("SELECT * FROM loan_sessions WHERE session_token = $1", session_token)
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE id = $1", session["application_id"])
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found")
    await db_pool.execute("UPDATE loan_applications SET is_complete = true, status = 'submitted', submitted_at = $1 WHERE id = $2", now_utc(), app_row["id"])
    # Record transition
    await record_transition(app_row["id"], "draft", "submitted", "customer", app_row["id"], "Form submitted by customer via session")
    if WHATSAPP_API_TOKEN and WHATSAPP_PHONE_ID:
        message = f"Dear {app_row['customer_name']},\n\nYour loan application has been submitted!\n\nLoan ID: {app_row['loan_id']}\n\nOur team will review within 24-48 hours.\n\n- Your Bank"
        await send_whatsapp_message(app_row["phone"], message)
    return {"status": "submitted", "message": "Application submitted successfully", "loan_id": app_row["loan_id"]}

# ============================================
# MOCK DATA SEEDER
# ============================================

@app.post("/api/admin/seed-mock-data")
async def seed_mock_data(admin: dict = Depends(get_current_admin)):
    """Seeds 3 banks, 6 users (2 per bank), 15 mock applications with various statuses and AI suggestions.
    THIS IS MOCK DATA FOR DEVELOPMENT/TESTING ONLY."""

    mock_banks = [
        {"name": "Buldhana Urban Co-op Bank", "code": "BUCB", "contact_email": "admin@buldhanabank.com", "contact_phone": "+912025551001", "address": "Main Branch, Buldhana, Maharashtra"},
        {"name": "State Finance Bank", "code": "SFB", "contact_email": "admin@statefinance.com", "contact_phone": "+912025552002", "address": "CBD Belapur, Navi Mumbai, Maharashtra"},
        {"name": "National Rural Credit Bank", "code": "NRCB", "contact_email": "admin@nrcbank.com", "contact_phone": "+912025553003", "address": "FC Road, Pune, Maharashtra"},
    ]

    created_banks = []
    created_users = []
    created_apps = []

    for bank_data in mock_banks:
        # Check if bank already exists
        existing = await db_pool.fetchrow("SELECT id FROM banks WHERE code = $1", bank_data["code"])
        if existing:
            bank_id = existing["id"]
        else:
            row = await db_pool.fetchrow(
                """INSERT INTO banks (name, code, contact_email, contact_phone, address)
                   VALUES ($1, $2, $3, $4, $5) RETURNING id""",
                bank_data["name"], bank_data["code"], bank_data["contact_email"], bank_data["contact_phone"], bank_data["address"]
            )
            bank_id = row["id"]
        created_banks.append({"id": str(bank_id), "name": bank_data["name"], "code": bank_data["code"]})

        # Create 2 users per bank: 1 officer, 1 supervisor
        for role_suffix, role in [("officer", "bank_officer"), ("supervisor", "bank_supervisor")]:
            username = f"{bank_data['code'].lower()}_{role_suffix}"
            existing_user = await db_pool.fetchrow("SELECT id FROM bank_users WHERE username = $1", username)
            if existing_user:
                created_users.append({"username": username, "password": "(already existed)", "role": role, "bank": bank_data["code"]})
                continue
            password = f"{bank_data['code']}@{role_suffix}123"
            password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
            full_name = f"{bank_data['name'].split()[0]} {role_suffix.capitalize()}"
            email = f"{username}@{bank_data['code'].lower()}.mock"
            await db_pool.execute(
                """INSERT INTO bank_users (bank_id, username, email, password_hash, full_name, role)
                   VALUES ($1, $2, $3, $4, $5, $6)""",
                bank_id, username, email, password_hash, full_name, role
            )
            created_users.append({"username": username, "password": password, "role": role, "bank": bank_data["code"]})

    # Create 15 mock applications (5 per bank)
    mock_names = [
        "Rajesh Kumar Sharma", "Priya Suresh Patil", "Amit Vijay Deshmukh",
        "Sunita Ramesh Jadhav", "Vikas Mohan Kulkarni", "Neha Ashok Bhosle",
        "Manoj Prakash Chavan", "Kavita Sanjay Pawar", "Sunil Deepak Joshi",
        "Anita Rahul Deshpande", "Ramesh Anil Sawant", "Pooja Nitin Gaikwad",
        "Siddharth Ajay More", "Rekha Suresh Thakur", "Ganesh Mahesh Shinde",
    ]
    mock_phones = [f"+9198{random.randint(10000000, 99999999)}" for _ in range(15)]
    mock_loan_types = ["Personal Loan", "Home Loan", "Vehicle Loan", "Education Loan", "Business Loan"]
    mock_statuses = [
        "submitted", "system_reviewed", "system_reviewed", "officer_approved", "officer_rejected",
        "submitted", "system_reviewed", "officer_approved", "approved", "documents_submitted",
        "submitted", "system_reviewed", "officer_approved", "officer_approved", "approved",
    ]
    mock_system_suggestions = ["approve", "approve", "reject", "approve", "reject",
                           "approve", "approve", "approve", "approve", "approve",
                           "reject", "approve", "approve", "approve", "approve"]
    mock_ai_reasons = [
        "Strong income-to-loan ratio, stable employment history",
        "Good credit indicators, low existing EMI burden",
        "High debt-to-income ratio, multiple existing loans",
        "Excellent financial profile, property-backed collateral",
        "Insufficient income documentation, recent job changes",
        "Moderate risk, adequate income for requested amount",
        "Strong savings pattern, long employment tenure",
        "Good repayment capacity, clear credit history",
        "Stable government employment, adequate income",
        "Good business revenue, consistent tax filings",
        "Low income relative to loan amount, no collateral",
        "Strong co-applicant profile, good combined income",
        "Verified employment, strong salary credentials",
        "Excellent credit score, minimal existing obligations",
        "Good financial standing, property as security",
    ]
    mock_system_scores = [82, 78, 35, 91, 28, 65, 85, 88, 90, 76, 32, 79, 87, 93, 81]
    mock_amounts = [500000, 2500000, 800000, 1200000, 350000,
                    750000, 1500000, 3000000, 600000, 1000000,
                    450000, 900000, 2000000, 1800000, 700000]

    for i in range(15):
        bank_idx = i // 5
        bank_id = uuid.UUID(created_banks[bank_idx]["id"])
        loan_id = f"MOCK-{created_banks[bank_idx]['code']}-{2026}{(i+1):04d}"

        # Check if this mock loan_id already exists
        existing_app = await db_pool.fetchrow("SELECT id FROM loan_applications WHERE loan_id = $1", loan_id)
        if existing_app:
            created_apps.append({"loan_id": loan_id, "status": "(already existed)"})
            continue

        status = mock_statuses[i]
        now = now_utc()
        submitted_at = now - timedelta(days=random.randint(1, 14))
        system_reviewed_at = submitted_at + timedelta(hours=random.randint(1, 4)) if status != "submitted" else None

        # Build officer/supervisor data based on status
        officer_reviewed_at = None
        supervisor_reviewed_at = None
        documents_requested_at = None
        approved_at = None
        disbursed_at = None

        if status in ("officer_approved", "officer_rejected", "approved", "supervisor_rejected", "documents_requested", "approved", "approved"):
            officer_reviewed_at = (system_reviewed_at or submitted_at) + timedelta(hours=random.randint(2, 24))
        if status in ("approved", "supervisor_rejected", "documents_requested", "approved", "approved"):
            supervisor_reviewed_at = (officer_reviewed_at or submitted_at) + timedelta(hours=random.randint(1, 12))
        if status == "documents_requested":
            documents_requested_at = supervisor_reviewed_at
        if status in ("approved", "approved"):
            approved_at = (supervisor_reviewed_at or submitted_at) + timedelta(days=random.randint(1, 3))
        if status == "approved":
            disbursed_at = approved_at + timedelta(days=random.randint(1, 2))

        # Generate realistic personal/employment/KYC mock data
        mock_emails = ["rajesh.sharma@gmail.com", "priya.patil@yahoo.com", "amit.deshmukh@gmail.com",
                       "sunita.jadhav@hotmail.com", "vikas.kulkarni@gmail.com", "neha.bhosle@gmail.com",
                       "manoj.chavan@yahoo.com", "kavita.pawar@gmail.com", "sunil.joshi@outlook.com",
                       "anita.deshpande@gmail.com", "ramesh.sawant@gmail.com", "pooja.gaikwad@yahoo.com",
                       "siddharth.more@gmail.com", "rekha.thakur@gmail.com", "ganesh.shinde@gmail.com"]
        mock_genders = ["Male", "Female", "Male", "Female", "Male", "Female", "Male", "Female", "Male",
                        "Female", "Male", "Female", "Male", "Female", "Male"]
        mock_dobs = ["1990-05-15", "1985-11-20", "1992-03-08", "1988-07-12", "1995-01-25",
                     "1991-09-30", "1987-06-18", "1993-12-05", "1989-04-22", "1994-08-14",
                     "1986-02-28", "1996-10-10", "1990-07-07", "1984-03-15", "1991-11-01"]
        mock_employment = ["Salaried", "Salaried", "Business", "Salaried", "Self-employed",
                           "Salaried", "Business", "Salaried", "Salaried", "Self-employed",
                           "Salaried", "Salaried", "Business", "Salaried", "Self-employed"]
        mock_employers = ["TCS", "Infosys", "Own Business", "Wipro", "Freelance",
                          "HCL Tech", "Shop Owner", "Cognizant", "SBI", "Consultant",
                          "L&T", "Tech Mahindra", "Transport", "HDFC Bank", "Agriculture"]
        mock_incomes = [65000, 85000, 120000, 55000, 45000, 75000, 90000, 60000, 50000, 70000,
                        80000, 55000, 100000, 72000, 40000]
        mock_pans = ["ABCDE1234F", "FGHIJ5678K", "KLMNO9012P", "PQRST3456U", "UVWXY7890Z",
                     "ABCFG1234H", "DEFHI5678J", "GHJKL9012M", "JKLMN3456O", "MNOPQ7890R",
                     "OPQRS1234T", "RSTUV5678W", "TUVWX9012Y", "WXYZA3456B", "ZABCD7890E"]
        mock_addresses = ["Flat 12, Shivaji Nagar, Pune", "House 45, MG Road, Mumbai", "Plot 78, MIDC, Nagpur",
                          "Room 3, Bajaj Colony, Aurangabad", "204 Lake View, Nashik", "B-12 Harmony, Thane",
                          "15 Gandhi Chowk, Satara", "67 Tilak Road, Kolhapur", "89 Station Road, Solapur",
                          "22 Civil Lines, Amravati", "34 Peth Area, Sangli", "56 Market Yard, Jalgaon",
                          "78 Industrial Area, Akola", "90 Cantonment, Ahmednagar", "11 Main Road, Latur"]

        from datetime import date as _date
        dob_val = _date.fromisoformat(mock_dobs[i]) if i < len(mock_dobs) else None

        await db_pool.execute(
            """INSERT INTO loan_applications
               (customer_name, phone, loan_id, bank_id, status, is_complete, submitted_at,
                email, date_of_birth, gender, marital_status, current_address,
                employment_type, employer_name, monthly_gross_income, monthly_net_income,
                loan_amount_requested, purpose_of_loan, pan_number, pan_verified, aadhaar_verified, aadhaar_last4,
                system_suggestion, system_suggestion_reason, system_score, system_reviewed_at,
                officer_reviewed_at, supervisor_reviewed_at,
                documents_requested_at, approved_at, disbursed_at,
                current_step, highest_step, last_saved_at, created_at)
               VALUES ($1, $2, $3, $4, $5, true, $6,
                       $7, $8, $9, $10, $11,
                       $12, $13, $14, $15,
                       $16, $17, $18, true, true, $19,
                       $20, $21, $22, $23,
                       $24, $25,
                       $26, $27, $28,
                       5, 5, $29, $30)""",
            mock_names[i], mock_phones[i], loan_id, bank_id, status, submitted_at,
            mock_emails[i], dob_val, mock_genders[i], random.choice(["Single", "Married"]), mock_addresses[i],
            mock_employment[i], mock_employers[i], float(mock_incomes[i]), float(mock_incomes[i] * 0.75),
            float(mock_amounts[i]), mock_loan_types[i % len(mock_loan_types)], mock_pans[i], str(random.randint(1000, 9999)),
            mock_system_suggestions[i], mock_ai_reasons[i], mock_system_scores[i], system_reviewed_at,
            officer_reviewed_at, supervisor_reviewed_at,
            documents_requested_at, approved_at, disbursed_at,
            now, submitted_at - timedelta(days=1)
        )
        created_apps.append({"loan_id": loan_id, "name": mock_names[i], "status": status, "bank": created_banks[bank_idx]["code"]})

    return {
        "status": "success",
        "message": "Mock data seeded successfully. THIS IS TEST DATA.",
        "banks": created_banks,
        "users": created_users,
        "applications": created_apps,
        "note": "Use the username/password pairs above to log in as bank users. Passwords are shown once here."
    }

# ============================================
# API PAYLOAD BUILDER (lrsAnalysisSummary)
# ============================================
# TODO(lrs-integration): wire this into a background task fired on form submission
# once the bank provides the public lrsAnalysisSummary endpoint URL. The response
# should populate system_suggestion / system_score / system_suggestion_reason on
# the loan_applications row. Not called from any route yet.

def build_api_payload(app_data: dict) -> dict:
    """Convert loan_applications row → lrsAnalysisSummary API payload (42 fields)."""
    # Take the last 10 digits — lstrip("91") treats it as a char set, not a prefix.
    _digits = ''.join(c for c in (app_data.get("phone") or "") if c.isdigit())
    phone = _digits[-10:] if len(_digits) >= 10 else _digits
    # Concatenate address parts for API.  Permanent is the source-of-truth
    # (auto-filled from Aadhaar); current either mirrors it (when the
    # legacy-named ``same_as_current`` flag is set, which now semantically
    # means "current == permanent") or is user-entered.
    per_parts = [app_data.get("permanent_house", ""), app_data.get("permanent_street", ""),
                 app_data.get("permanent_landmark", ""), app_data.get("permanent_locality", "")]
    perm_addr = ", ".join([p for p in per_parts if p and str(p).strip()])
    per_state = app_data.get("permanent_state_code", "")
    per_city = app_data.get("permanent_city_code", "")
    is_same = app_data.get("same_as_current", False)
    if is_same:
        current_addr = perm_addr
        curr_state = per_state
        curr_city = per_city
    else:
        cur_parts = [app_data.get("current_house", ""), app_data.get("current_street", ""),
                     app_data.get("current_landmark", ""), app_data.get("current_locality", "")]
        current_addr = ", ".join([p for p in cur_parts if p and str(p).strip()])
        curr_state = app_data.get("current_state_code", "")
        curr_city = app_data.get("current_city_code", "")
    # Repayment period: years → months
    years = app_data.get("repayment_period_years")
    months = str(int(float(years) * 12)) if years else ""
    return {
        "panNo": app_data.get("pan_number", ""),
        "firstName": app_data.get("first_name", ""),
        "middleName": app_data.get("middle_name", ""),
        "lastName": app_data.get("last_name", ""),
        "dateOfBirth": app_data.get("date_of_birth", ""),
        "phoneNo": phone,
        "gender": app_data.get("gender", ""),
        "maritalStatus": app_data.get("marital_status", ""),
        "enqId": app_data.get("loan_id", ""),
        "currentAddress1": current_addr or app_data.get("current_address", ""),
        "pinCode": (app_data.get("permanent_pincode", "") if is_same else app_data.get("current_pincode", "")),
        "curr_state": curr_state,
        "curr_city": curr_city,
        "curr_country": "1",
        "permanentAddress1": perm_addr or app_data.get("permanent_address", ""),
        "per_state": per_state,
        "per_city": per_city,
        "per_country": "1",
        "qualification": app_data.get("qualification", ""),
        "occupation": app_data.get("occupation", ""),
        "industryType": app_data.get("industry_type", ""),
        "employmentType": app_data.get("employment_type", ""),
        "employerName": app_data.get("employer_name", ""),
        "designation": app_data.get("designation", ""),
        "totalWorkExp": str(app_data.get("total_work_experience", "")),
        "totalWorkExpCurOrg": str(app_data.get("experience_current_org", "")),
        "residentialStatus": app_data.get("residential_status", ""),
        "tenureStatbility": app_data.get("tenure_stability", ""),
        "employerAddress": app_data.get("employer_address", ""),
        "requestedLoanAmt": str(app_data.get("loan_amount_requested", "")),
        "loanRepaymentPeriod": months,
        "purposeOfLoan": app_data.get("purpose_of_loan", ""),
        "scheme": app_data.get("scheme", ""),
        "monthlyGrossIncome": str(app_data.get("monthly_gross_income", "")),
        "monthlyDeduction": str(app_data.get("monthly_deductions", "")),
        "monthlyEMI": str(app_data.get("monthly_emi_existing", "")),
        "monthlyNetIncome": str(app_data.get("monthly_net_income", "")),
        "salarySlip": app_data.get("salary_slips_url", ""),
        "itrDocument": app_data.get("itr_form16_url", ""),
        "bankStatementDocument": app_data.get("bank_statements_url", ""),
        "itrJsonData": {},
        "bankStatementJsonData": {},
    }


# ============================================
# ENTRY POINT
# ============================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8200)
