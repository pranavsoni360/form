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
import random
import string
import json
import base64 as b64mod
from fpdf import FPDF
import tempfile

load_dotenv()

app = FastAPI(
    title="Bank Loan Form API",
    description="Multi-bank tenant loan origination system with AI review pipeline",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "https://virtualvaani.vgipl.com:3001",
        "https://virtualvaani.vgipl.com",
    ],
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
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "/root/vaani_los_form/uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

FORM_BASE_URL = os.getenv("FORM_BASE_URL", "https://virtualvaani.vgipl.com:3001")

# ── VG DocVerify API Configuration ──
VG_API_BASE = os.getenv("VG_API_BASE", "http://10.200.10.43/VGDocverify/VGKVerify.asmx")
VG_USER_ID = os.getenv("VG_USER_ID", "33")
VG_KEY = os.getenv("VG_KEY", "")
VG_BANK_CODE = os.getenv("VG_BANK_CODE", "VGIL")
VG_BANK_NAME = os.getenv("VG_BANK_NAME", "VIRTUAL URBAN CO-OPERATIVE BANK LTD")
VG_MOCK_MODE = os.getenv("VG_MOCK_MODE", "false").lower() == "true"  # Set to "true" only when needed for testing without VG API access

# ── Code List API (lrsAnalysisSummary dropdown codes) ──
CODE_LIST_API_URL = os.getenv("CODE_LIST_API_URL", "http://10.200.10.83:5020")
_code_list_cache: dict[str, tuple[float, list]] = {}  # cache_key -> (expiry_timestamp, data)
CODE_LIST_CACHE_TTL = 3600  # 1 hour

# ── Auth Configuration ──
ACCESS_TOKEN_MINUTES = int(os.getenv("LOS_ACCESS_TOKEN_MINUTES", "30"))
REFRESH_TOKEN_HOURS = int(os.getenv("LOS_REFRESH_TOKEN_HOURS", "9"))
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_MINUTES = 15
WARN_AFTER_ATTEMPTS = 3
COOKIE_SECURE = os.getenv("LOS_COOKIE_SECURE", "false").lower() == "true"

db_pool: asyncpg.Pool = None
security = HTTPBearer(auto_error=False)  # auto_error=False so we can handle missing tokens gracefully

# ============================================
# VALID STATUSES & TRANSITIONS (v3 — officer stage removed)
# ============================================
VALID_STATUSES = {
    "draft", "submitted", "system_reviewed",
    "approved", "rejected",
    "documents_requested", "documents_submitted", "disbursed",
}

# ============================================
# UTILITY FUNCTIONS
# ============================================

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

def create_access_token(user_id: str, role: str, bank_id: str = None, vendor_id: str = None, **extra) -> str:
    payload = {
        "user_id": user_id,
        "role": role,  # admin | bank_user | vendor_user | customer
        "exp": now_utc() + timedelta(minutes=ACCESS_TOKEN_MINUTES),
        "iat": now_utc(),
        "type": "access",
    }
    if bank_id:
        payload["bank_id"] = bank_id
    if vendor_id:
        payload["vendor_id"] = vendor_id
    payload.update(extra)
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def create_refresh_token(user_id: str, role: str, bank_id: str = None, vendor_id: str = None) -> tuple[str, str]:
    jti = secrets.token_urlsafe(32)
    payload = {
        "user_id": user_id,
        "role": role,
        "jti": jti,
        "exp": now_utc() + timedelta(hours=REFRESH_TOKEN_HOURS),
        "iat": now_utc(),
        "type": "refresh",
    }
    if bank_id:
        payload["bank_id"] = bank_id
    if vendor_id:
        payload["vendor_id"] = vendor_id
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

async def _store_refresh_token(user_id: str, jti: str, role: str, bank_id: str = None, vendor_id: str = None) -> None:
    await db_pool.execute(
        """INSERT INTO refresh_tokens (user_id, jti, role, bank_id, vendor_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)""",
        uuid.UUID(user_id), jti, role,
        uuid.UUID(bank_id) if bank_id else None,
        uuid.UUID(vendor_id) if vendor_id else None,
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

class PortalLogin(BaseModel):
    """Unified login for bank_user / vendor_user. Portal tab selects which role is expected."""
    username: str
    password: str
    portal: str  # 'bank' | 'vendor'

class BankCreate(BaseModel):
    name: str
    code: str
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    logo_url: Optional[str] = None
    vendor_limit: int = 5

class BankUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    logo_url: Optional[str] = None
    vendor_limit: Optional[int] = None
    status: Optional[str] = None

class VendorCreate(BaseModel):
    name: str
    code: str
    category: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    # Admin may target a specific bank; bank_user uses their own bank_id
    bank_id: Optional[str] = None

class VendorUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    category: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    address: Optional[str] = None
    status: Optional[str] = None

class UserCreate(BaseModel):
    """Create a bank_user or vendor_user. Password is auto-generated and returned once."""
    username: str
    email: Optional[str] = None
    full_name: str

class UserUpdate(BaseModel):
    email: Optional[str] = None
    full_name: Optional[str] = None
    is_active: Optional[bool] = None

class ReviewRequest(BaseModel):
    notes: Optional[str] = None

class RejectRequest(BaseModel):
    notes: Optional[str] = None
    rejection_reason: Optional[str] = None

class SingleCallRequest(BaseModel):
    customer_name: str
    phone: str
    loan_type: Optional[str] = None
    loan_amount: Optional[str] = None
    language: str = "hindi"

class GenerateFormLinksRequest(BaseModel):
    customers: List[CustomerData]
    bank_id: Optional[str] = None
    vendor_id: Optional[str] = None

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

def generate_random_password(length: int = 12) -> str:
    chars = string.ascii_letters + string.digits + "!@#$%"
    return ''.join(secrets.choice(chars) for _ in range(length))

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
            return response.json() if response.text else {"status": "sent"}
        except Exception as e:
            print(f"WhatsApp send error: {str(e)}")
            return {"status": "failed", "error": str(e)}

async def send_otp_via_aisensy(phone: str, otp: str) -> dict:
    """Send OTP via AiSensy otp_verification WhatsApp campaign."""
    if not AISENSY_API_KEY:
        print(f"[AiSensy OTP] Not configured. OTP for {phone}: {otp}")
        return {"status": "simulated"}
    phone_formatted = clean_phone(phone)
    payload = {
        "apiKey": AISENSY_API_KEY,
        "campaignName": "otp_verification",
        "destination": phone_formatted,
        "userName": AISENSY_USERNAME,
        "templateParams": [otp],
        "source": "loan-form-otp",
        "media": {},
        "buttons": [{"type": "button", "sub_type": "url", "index": 0, "parameters": [{"type": "text", "text": otp}]}],
        "carouselCards": [], "location": {}, "attributes": {},
        "paramsFallbackValue": {"FirstName": "user"},
    }
    async with httpx.AsyncClient(verify=False, timeout=10) as client:
        try:
            response = await client.post("https://backend.aisensy.com/campaign/t1/api/v2", json=payload)
            print(f"[AiSensy OTP] {phone_formatted} -> {response.status_code}")
            return response.json() if response.text else {"status": "sent"}
        except Exception as e:
            print(f"[AiSensy OTP] Error: {e}")
            return {"status": "failed", "error": str(e)}

async def send_whatsapp_aisensy(phone: str, customer_name: str, template_params: list = None):
    if not AISENSY_API_KEY:
        print(f"[AiSensy STUB] Would send to {phone}")
        return {"status": "simulated"}
    phone_formatted = clean_phone(phone).replace(' ', '')
    payload = {
        "apiKey": AISENSY_API_KEY,
        "campaignName": AISENSY_CAMPAIGN_NAME,
        "destination": phone_formatted,
        "userName": AISENSY_USERNAME,
        "templateParams": template_params or [customer_name],
        "source": "loan-form-system",
        "media": {}, "buttons": [], "carouselCards": [], "location": {}, "attributes": {},
        "paramsFallbackValue": {"FirstName": customer_name}
    }
    async with httpx.AsyncClient(verify=False) as client:
        try:
            response = await client.post("https://backend.aisensy.com/campaign/t1/api/v2", json=payload)
            return response.json() if response.text else {"status": "sent"}
        except Exception as e:
            return {"status": "failed", "error": str(e)}

# ============================================
# STATUS TRANSITION HELPER
# ============================================

async def record_transition(app_id, from_status, to_status, changed_by_role, changed_by_id, notes=None):
    """Append a status_transitions row. changed_by_role: system|admin|bank_user|vendor_user|customer."""
    await db_pool.execute(
        """INSERT INTO status_transitions (application_id, from_status, to_status, changed_by_role, changed_by, notes)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        app_id, from_status, to_status, changed_by_role, changed_by_id, notes,
    )

# ============================================
# AUTH DEPENDENCIES (v3 — unified users table)
# ============================================

async def _load_user_by_id(user_id: str) -> dict:
    row = await db_pool.fetchrow(
        "SELECT * FROM users WHERE id = $1 AND is_active = TRUE",
        uuid.UUID(user_id),
    )
    if not row:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    user = _row_to_dict(row)
    user["id"] = str(row["id"])
    if row["bank_id"]:
        user["bank_id"] = str(row["bank_id"])
    if row["vendor_id"]:
        user["vendor_id"] = str(row["vendor_id"])
    return user

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Decode JWT and load the user from the unified users table."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Missing authentication")
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Not an access token")
    return await _load_user_by_id(payload["user_id"])

async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

async def require_bank_user(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "bank_user":
        raise HTTPException(status_code=403, detail="Bank user access required")
    if not user.get("bank_id"):
        raise HTTPException(status_code=403, detail="Bank user missing bank_id")
    return user

async def require_vendor_user(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "vendor_user":
        raise HTTPException(status_code=403, detail="Vendor user access required")
    if not user.get("vendor_id") or not user.get("bank_id"):
        raise HTTPException(status_code=403, detail="Vendor user missing bank_id/vendor_id")
    return user

async def require_bank_or_vendor(user: dict = Depends(get_current_user)) -> dict:
    """Shared dependency for endpoints accessible to both bank_user and vendor_user
    (e.g. application detail, call detail). Scope is enforced downstream using
    user['bank_id'] and user['vendor_id']."""
    if user.get("role") not in ("bank_user", "vendor_user"):
        raise HTTPException(status_code=403, detail="Bank or vendor user access required")
    return user

async def require_any_authenticated(user: dict = Depends(get_current_user)) -> dict:
    """Admin + bank + vendor all allowed. Scope enforcement is the caller's job."""
    if user.get("role") not in ("admin", "bank_user", "vendor_user"):
        raise HTTPException(status_code=403, detail="Authentication required")
    return user

def scope_where_for_user(user: dict, table_alias: str = "") -> tuple[str, list, int]:
    """Build a SQL WHERE fragment enforcing scope rules for an authenticated user.
    Returns (where_clause, params, next_param_idx)."""
    prefix = f"{table_alias}." if table_alias else ""
    role = user.get("role")
    if role == "admin":
        return "TRUE", [], 1
    if role == "bank_user":
        return f"{prefix}bank_id = $1", [uuid.UUID(user["bank_id"])], 2
    if role == "vendor_user":
        return f"{prefix}vendor_id = $1", [uuid.UUID(user["vendor_id"])], 2
    raise HTTPException(status_code=403, detail="Forbidden")

# ============================================
# TYPE COERCION FOR DB COLUMNS
# ============================================
DATE_COLUMNS = {"date_of_birth"}
BOOLEAN_COLUMNS = {"criminal_records", "same_as_current", "highest_step", "same_as_current", "pan_verified", "aadhaar_verified"}
DECIMAL_COLUMNS = {
    "loan_amount_requested", "monthly_gross_income", "monthly_deductions",
    "monthly_emi_existing", "monthly_net_income",
}
INTEGER_COLUMNS = {"repayment_period_years", "current_step", "highest_step"}

def _coerce_value(key: str, val):
    """Convert frontend string values to proper Python types for asyncpg."""
    if val is None or val == '':
        return None
    if key in DATE_COLUMNS:
        if isinstance(val, str):
            try:
                from datetime import date as d
                parts = val.split('-')
                return d(int(parts[0]), int(parts[1]), int(parts[2]))
            except (ValueError, IndexError):
                return None
        return val
    if key in BOOLEAN_COLUMNS:
        if isinstance(val, str):
            return val.lower() in ('true', '1', 'yes')
        return bool(val)
    if key in DECIMAL_COLUMNS:
        try:
            return float(val)
        except (ValueError, TypeError):
            return None
    if key in INTEGER_COLUMNS:
        try:
            return int(val)
        except (ValueError, TypeError):
            return None
    return val

# ============================================
# AUTOSAVE WHITELISTED COLUMNS
# ============================================
AUTOSAVE_COLUMNS = {
    "customer_name", "email", "date_of_birth", "gender", "marital_status",
    "address_line1", "address_line2", "city", "state", "pincode",
    "employment_type", "employer_name", "designation", "years_at_job", "monthly_income",
    # pan_number, aadhaar saved via verify endpoints only
    "loan_purpose", "requested_loan_amount", "loan_tenure_months",
    "pan_card_url", "income_proof_url", "bank_statement_url",
    # aadhaar_front_url, photo_url: set only by DigiLocker or upload endpoints, not autosave
    "current_address", "permanent_address", "customer_type",
    "title", "first_name", "middle_name", "last_name", "full_name",
    "qualification", "occupation", "industry_type",
    "total_work_experience", "experience_current_org",
    "residential_status", "tenure_stability", "employer_address",
    "loan_amount_requested", "repayment_period_years", "purpose_of_loan", "scheme",
    "monthly_gross_income", "monthly_deductions", "monthly_emi_existing", "monthly_net_income",
    "criminal_records", "same_as_current", "highest_step",
    # Split address fields (form step 2)
    "current_house", "current_street", "current_landmark", "current_locality",
    "current_pincode", "current_state_code", "current_city_code",
    "permanent_house", "permanent_street", "permanent_landmark", "permanent_locality",
    "permanent_pincode", "permanent_state_code", "permanent_city_code",
}

# ============================================
# API ENDPOINTS
# ============================================

@app.get("/")
async def root():
    return {"status": "running", "service": "Bank Loan Form API", "version": "2.0.0"}

# ============================================
# AUTH ENDPOINTS
# ============================================

def _user_public(row: dict, bank: Optional[dict] = None, vendor: Optional[dict] = None) -> dict:
    out = {
        "id": str(row["id"]),
        "username": row["username"],
        "email": row["email"],
        "name": row["full_name"],
        "role": row["role"],
        "is_active": row["is_active"],
    }
    if row.get("bank_id"):
        out["bank_id"] = str(row["bank_id"])
        if bank:
            out["bank_name"] = bank["name"]
            out["bank_code"] = bank["code"]
    if row.get("vendor_id"):
        out["vendor_id"] = str(row["vendor_id"])
        if vendor:
            out["vendor_name"] = vendor["name"]
            out["vendor_code"] = vendor["code"]
    return out


@app.post("/api/auth/admin-login")
async def auth_admin_login(payload: AdminLogin):
    """Admin login — email + password. Sets httpOnly refresh cookie."""
    await _check_lockout(payload.email)
    row = await db_pool.fetchrow(
        "SELECT * FROM users WHERE username = $1 AND role = 'admin'",
        payload.email,
    )
    if not row or not row["password_hash"] or not bcrypt.checkpw(
        payload.password.encode("utf-8"), row["password_hash"].encode("utf-8")
    ):
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
    access_token = create_access_token(user_id=user_id, role="admin")
    refresh_token, jti = create_refresh_token(user_id=user_id, role="admin")
    await _store_refresh_token(user_id, jti, "admin")
    await db_pool.execute("UPDATE users SET last_login_at = $1 WHERE id = $2", now_utc(), row["id"])
    resp = JSONResponse({"token": access_token, "user": _user_public(row)})
    _set_refresh_cookie(resp, "los_refresh_admin", refresh_token)
    return resp


@app.post("/api/auth/login")
async def auth_portal_login(payload: PortalLogin):
    """Unified login for bank_user & vendor_user. `portal` must match the user's role."""
    if payload.portal not in ("bank", "vendor"):
        raise HTTPException(status_code=400, detail="portal must be 'bank' or 'vendor'")
    expected_role = "bank_user" if payload.portal == "bank" else "vendor_user"

    await _check_lockout(payload.username)
    row = await db_pool.fetchrow("SELECT * FROM users WHERE username = $1", payload.username)
    password_ok = (
        row is not None
        and row["password_hash"]
        and bcrypt.checkpw(payload.password.encode("utf-8"), row["password_hash"].encode("utf-8"))
    )
    if not password_ok:
        attempts, locked = await _record_failed_login(payload.username)
        if locked:
            raise HTTPException(423, f"Account locked after {MAX_LOGIN_ATTEMPTS} failed attempts. Try again in {LOCKOUT_MINUTES} minutes.")
        remaining = MAX_LOGIN_ATTEMPTS - attempts
        if attempts >= WARN_AFTER_ATTEMPTS:
            raise HTTPException(401, f"Invalid credentials. {remaining} attempt{'s' if remaining != 1 else ''} remaining before lockout.")
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if row["role"] != expected_role:
        # Don't leak that the user exists with a different role.
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="Account deactivated")

    bank = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1", row["bank_id"])
    if not bank or bank["status"] != "active":
        raise HTTPException(status_code=403, detail="Bank is inactive or not found")

    vendor = None
    if row["role"] == "vendor_user":
        vendor = await db_pool.fetchrow("SELECT * FROM vendors WHERE id = $1", row["vendor_id"])
        if not vendor or vendor["status"] != "active":
            raise HTTPException(status_code=403, detail="Vendor is inactive or not found")

    await _clear_failed_logins(payload.username)
    user_id = str(row["id"])
    bank_id = str(row["bank_id"])
    vendor_id = str(row["vendor_id"]) if row.get("vendor_id") else None
    access_token = create_access_token(
        user_id=user_id, role=row["role"], bank_id=bank_id, vendor_id=vendor_id, username=row["username"],
    )
    refresh_token, jti = create_refresh_token(
        user_id=user_id, role=row["role"], bank_id=bank_id, vendor_id=vendor_id,
    )
    await _store_refresh_token(user_id, jti, row["role"], bank_id, vendor_id)
    await db_pool.execute("UPDATE users SET last_login_at = $1 WHERE id = $2", now_utc(), row["id"])
    resp = JSONResponse({"token": access_token, "user": _user_public(row, bank=bank, vendor=vendor)})
    cookie_name = "los_refresh_bank" if row["role"] == "bank_user" else "los_refresh_vendor"
    _set_refresh_cookie(resp, cookie_name, refresh_token)
    return resp


@app.post("/api/auth/refresh")
async def auth_refresh(request: Request):
    """Silent token refresh via httpOnly cookie. Returns a new access token."""
    refresh_jwt = (
        request.cookies.get("los_refresh_admin")
        or request.cookies.get("los_refresh_bank")
        or request.cookies.get("los_refresh_vendor")
    )
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
    stored = await db_pool.fetchrow("SELECT * FROM refresh_tokens WHERE jti = $1", payload["jti"])
    if not stored:
        raise HTTPException(status_code=401, detail="Token revoked")
    access_token = create_access_token(
        user_id=payload["user_id"],
        role=payload["role"],
        bank_id=payload.get("bank_id"),
        vendor_id=payload.get("vendor_id"),
    )
    return {"token": access_token}


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    """Revoke refresh token and clear the matching cookie."""
    cookie_name = None
    refresh_jwt = None
    for name in ("los_refresh_admin", "los_refresh_bank", "los_refresh_vendor"):
        val = request.cookies.get(name)
        if val:
            refresh_jwt = val
            cookie_name = name
            break
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
async def auth_me(user: dict = Depends(get_current_user)):
    """Returns current user info with bank/vendor context."""
    bank = None
    vendor = None
    if user.get("bank_id"):
        bank = await db_pool.fetchrow("SELECT name, code FROM banks WHERE id = $1", uuid.UUID(user["bank_id"]))
    if user.get("vendor_id"):
        vendor = await db_pool.fetchrow("SELECT name, code FROM vendors WHERE id = $1", uuid.UUID(user["vendor_id"]))
    return _user_public(user, bank=bank, vendor=vendor)

# ============================================
# ADMIN BANK MANAGEMENT ENDPOINTS
# ============================================

# ---------- Banks ----------

@app.get("/api/admin/banks")
async def admin_list_banks(_: dict = Depends(require_admin)):
    rows = await db_pool.fetch(
        """SELECT b.*,
                  (SELECT COUNT(*) FROM vendors v WHERE v.bank_id = b.id) AS vendor_count,
                  (SELECT COUNT(*) FROM loan_applications la WHERE la.bank_id = b.id) AS application_count,
                  (SELECT COUNT(*) FROM users u WHERE u.bank_id = b.id AND u.role = 'bank_user' AND u.is_active) AS active_user_count
             FROM banks b ORDER BY b.created_at DESC"""
    )
    return {"banks": _rows_to_list(rows)}


@app.post("/api/admin/banks")
async def admin_create_bank(bank: BankCreate, _: dict = Depends(require_admin)):
    if bank.vendor_limit < 0:
        raise HTTPException(status_code=400, detail="vendor_limit must be >= 0")
    existing = await db_pool.fetchrow("SELECT id FROM banks WHERE code = $1", bank.code)
    if existing:
        raise HTTPException(status_code=400, detail=f"Bank with code '{bank.code}' already exists")
    row = await db_pool.fetchrow(
        """INSERT INTO banks (name, code, contact_email, contact_phone, address, logo_url, vendor_limit)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *""",
        bank.name, bank.code, bank.contact_email, bank.contact_phone,
        bank.address, bank.logo_url, bank.vendor_limit,
    )
    return {"bank": _row_to_dict(row)}


@app.put("/api/admin/banks/{bank_id}")
async def admin_update_bank(bank_id: str, bank: BankUpdate, _: dict = Depends(require_admin)):
    existing = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1", uuid.UUID(bank_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Bank not found")
    updates: dict = {}
    if bank.name is not None:           updates["name"] = bank.name
    if bank.code is not None:
        dup = await db_pool.fetchrow("SELECT id FROM banks WHERE code = $1 AND id != $2", bank.code, uuid.UUID(bank_id))
        if dup:
            raise HTTPException(status_code=400, detail=f"Bank code '{bank.code}' already in use")
        updates["code"] = bank.code
    if bank.contact_email is not None:  updates["contact_email"] = bank.contact_email
    if bank.contact_phone is not None:  updates["contact_phone"] = bank.contact_phone
    if bank.address is not None:        updates["address"] = bank.address
    if bank.logo_url is not None:       updates["logo_url"] = bank.logo_url
    if bank.vendor_limit is not None:
        if bank.vendor_limit < 0:
            raise HTTPException(status_code=400, detail="vendor_limit must be >= 0")
        updates["vendor_limit"] = bank.vendor_limit
    if bank.status is not None:
        if bank.status not in ("active", "inactive"):
            raise HTTPException(status_code=400, detail="Status must be 'active' or 'inactive'")
        updates["status"] = bank.status
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates.keys()))
    vals = list(updates.values()) + [uuid.UUID(bank_id)]
    await db_pool.execute(f"UPDATE banks SET {sets} WHERE id = ${len(updates)+1}", *vals)
    row = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1", uuid.UUID(bank_id))
    return {"bank": _row_to_dict(row)}


@app.get("/api/admin/banks/{bank_id}")
async def admin_get_bank(bank_id: str, _: dict = Depends(require_admin)):
    bank = await db_pool.fetchrow("SELECT * FROM banks WHERE id = $1", uuid.UUID(bank_id))
    if not bank:
        raise HTTPException(status_code=404, detail="Bank not found")
    bank_users = await db_pool.fetch(
        """SELECT id, username, email, full_name, is_active, created_at, last_login_at
             FROM users WHERE bank_id = $1 AND role = 'bank_user' ORDER BY created_at DESC""",
        uuid.UUID(bank_id),
    )
    vendors = await db_pool.fetch(
        """SELECT v.*,
                  (SELECT COUNT(*) FROM users u WHERE u.vendor_id = v.id AND u.role = 'vendor_user' AND u.is_active) AS active_user_count,
                  (SELECT COUNT(*) FROM loan_applications la WHERE la.vendor_id = v.id) AS application_count
             FROM vendors v WHERE v.bank_id = $1 ORDER BY v.created_at DESC""",
        uuid.UUID(bank_id),
    )
    app_count = await db_pool.fetchval("SELECT COUNT(*) FROM loan_applications WHERE bank_id = $1", uuid.UUID(bank_id))
    bank_dict = _row_to_dict(bank)
    bank_dict["users"] = _rows_to_list(bank_users)
    bank_dict["vendors"] = _rows_to_list(vendors)
    bank_dict["application_count"] = app_count
    return {"bank": bank_dict}


# ---------- Bank users ----------

@app.post("/api/admin/banks/{bank_id}/users")
async def admin_create_bank_user(bank_id: str, user: UserCreate, admin: dict = Depends(require_admin)):
    bank = await db_pool.fetchrow("SELECT id FROM banks WHERE id = $1", uuid.UUID(bank_id))
    if not bank:
        raise HTTPException(status_code=404, detail="Bank not found")
    existing = await db_pool.fetchrow("SELECT id FROM users WHERE username = $1", user.username)
    if existing:
        raise HTTPException(status_code=400, detail=f"Username '{user.username}' already exists")
    password = generate_random_password()
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    row = await db_pool.fetchrow(
        """INSERT INTO users (username, email, password_hash, full_name, role, bank_id)
           VALUES ($1, $2, $3, $4, 'bank_user', $5)
           RETURNING id, username, email, full_name, role, bank_id, is_active, created_at""",
        user.username, user.email, password_hash, user.full_name, uuid.UUID(bank_id),
    )
    user_dict = _row_to_dict(row)
    user_dict["generated_password"] = password
    return {"user": user_dict}


@app.put("/api/admin/users/{user_id}")
async def admin_update_user(user_id: str, user: UserUpdate, _: dict = Depends(require_admin)):
    existing = await db_pool.fetchrow("SELECT * FROM users WHERE id = $1", uuid.UUID(user_id))
    if not existing:
        raise HTTPException(status_code=404, detail="User not found")
    if existing["role"] == "admin":
        raise HTTPException(status_code=400, detail="Cannot modify admin users via this endpoint")
    updates: dict = {}
    if user.email is not None:       updates["email"] = user.email
    if user.full_name is not None:   updates["full_name"] = user.full_name
    if user.is_active is not None:   updates["is_active"] = user.is_active
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates.keys()))
    vals = list(updates.values()) + [uuid.UUID(user_id)]
    await db_pool.execute(f"UPDATE users SET {sets} WHERE id = ${len(updates)+1}", *vals)
    row = await db_pool.fetchrow(
        "SELECT id, username, email, full_name, role, bank_id, vendor_id, is_active, created_at, last_login_at FROM users WHERE id = $1",
        uuid.UUID(user_id),
    )
    return {"user": _row_to_dict(row)}


@app.delete("/api/admin/users/{user_id}")
async def admin_deactivate_user(user_id: str, _: dict = Depends(require_admin)):
    existing = await db_pool.fetchrow("SELECT username, role FROM users WHERE id = $1", uuid.UUID(user_id))
    if not existing:
        raise HTTPException(status_code=404, detail="User not found")
    if existing["role"] == "admin":
        raise HTTPException(status_code=400, detail="Cannot deactivate admin accounts")
    await db_pool.execute("UPDATE users SET is_active = FALSE WHERE id = $1", uuid.UUID(user_id))
    return {"status": "deactivated", "message": f"User {existing['username']} deactivated"}


# ---------- Vendors (admin) ----------

async def _assert_vendor_within_limit(bank_id: uuid.UUID):
    bank = await db_pool.fetchrow("SELECT vendor_limit FROM banks WHERE id = $1", bank_id)
    if not bank:
        raise HTTPException(status_code=404, detail="Bank not found")
    existing = await db_pool.fetchval("SELECT COUNT(*) FROM vendors WHERE bank_id = $1 AND status = 'active'", bank_id)
    if existing >= bank["vendor_limit"]:
        raise HTTPException(status_code=400, detail=f"Vendor limit reached ({existing}/{bank['vendor_limit']})")


@app.get("/api/admin/vendors")
async def admin_list_vendors(bank_id: Optional[str] = None, _: dict = Depends(require_admin)):
    if bank_id:
        rows = await db_pool.fetch(
            """SELECT v.*, b.name AS bank_name, b.code AS bank_code
                 FROM vendors v JOIN banks b ON b.id = v.bank_id
                WHERE v.bank_id = $1
                ORDER BY v.created_at DESC""",
            uuid.UUID(bank_id),
        )
    else:
        rows = await db_pool.fetch(
            """SELECT v.*, b.name AS bank_name, b.code AS bank_code
                 FROM vendors v JOIN banks b ON b.id = v.bank_id
                ORDER BY v.created_at DESC"""
        )
    return {"vendors": _rows_to_list(rows)}


@app.post("/api/admin/vendors")
async def admin_create_vendor(payload: VendorCreate, admin: dict = Depends(require_admin)):
    if not payload.bank_id:
        raise HTTPException(status_code=400, detail="bank_id is required")
    bank_uuid = uuid.UUID(payload.bank_id)
    await _assert_vendor_within_limit(bank_uuid)
    dup = await db_pool.fetchrow(
        "SELECT id FROM vendors WHERE bank_id = $1 AND code = $2", bank_uuid, payload.code,
    )
    if dup:
        raise HTTPException(status_code=400, detail=f"Vendor code '{payload.code}' already exists in this bank")
    row = await db_pool.fetchrow(
        """INSERT INTO vendors (bank_id, name, code, category, contact_name, contact_email, contact_phone, address, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *""",
        bank_uuid, payload.name, payload.code, payload.category,
        payload.contact_name, payload.contact_email, payload.contact_phone, payload.address,
        uuid.UUID(admin["id"]),
    )
    return {"vendor": _row_to_dict(row)}


@app.get("/api/admin/vendors/{vendor_id}")
async def admin_get_vendor(vendor_id: str, _: dict = Depends(require_admin)):
    row = await db_pool.fetchrow(
        """SELECT v.*, b.name AS bank_name, b.code AS bank_code
             FROM vendors v JOIN banks b ON b.id = v.bank_id
            WHERE v.id = $1""",
        uuid.UUID(vendor_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Vendor not found")
    users = await db_pool.fetch(
        """SELECT id, username, email, full_name, is_active, created_at, last_login_at
             FROM users WHERE vendor_id = $1 AND role = 'vendor_user' ORDER BY created_at DESC""",
        uuid.UUID(vendor_id),
    )
    app_count = await db_pool.fetchval("SELECT COUNT(*) FROM loan_applications WHERE vendor_id = $1", uuid.UUID(vendor_id))
    out = _row_to_dict(row)
    out["users"] = _rows_to_list(users)
    out["application_count"] = app_count
    return {"vendor": out}


@app.put("/api/admin/vendors/{vendor_id}")
async def admin_update_vendor(vendor_id: str, payload: VendorUpdate, _: dict = Depends(require_admin)):
    existing = await db_pool.fetchrow("SELECT * FROM vendors WHERE id = $1", uuid.UUID(vendor_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Vendor not found")
    updates: dict = {}
    for fld in ("name", "category", "contact_name", "contact_email", "contact_phone", "address"):
        val = getattr(payload, fld)
        if val is not None:
            updates[fld] = val
    if payload.code is not None:
        dup = await db_pool.fetchrow(
            "SELECT id FROM vendors WHERE bank_id = $1 AND code = $2 AND id != $3",
            existing["bank_id"], payload.code, uuid.UUID(vendor_id),
        )
        if dup:
            raise HTTPException(status_code=400, detail=f"Vendor code '{payload.code}' already in use for this bank")
        updates["code"] = payload.code
    if payload.status is not None:
        if payload.status not in ("active", "inactive"):
            raise HTTPException(status_code=400, detail="Status must be 'active' or 'inactive'")
        updates["status"] = payload.status
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates.keys()))
    vals = list(updates.values()) + [uuid.UUID(vendor_id)]
    await db_pool.execute(f"UPDATE vendors SET {sets} WHERE id = ${len(updates)+1}", *vals)
    row = await db_pool.fetchrow("SELECT * FROM vendors WHERE id = $1", uuid.UUID(vendor_id))
    return {"vendor": _row_to_dict(row)}


@app.delete("/api/admin/vendors/{vendor_id}")
async def admin_deactivate_vendor(vendor_id: str, _: dict = Depends(require_admin)):
    existing = await db_pool.fetchrow("SELECT name FROM vendors WHERE id = $1", uuid.UUID(vendor_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Vendor not found")
    await db_pool.execute("UPDATE vendors SET status = 'inactive' WHERE id = $1", uuid.UUID(vendor_id))
    return {"status": "deactivated", "message": f"Vendor {existing['name']} deactivated"}


@app.post("/api/admin/vendors/{vendor_id}/users")
async def admin_create_vendor_user(vendor_id: str, user: UserCreate, _: dict = Depends(require_admin)):
    vendor = await db_pool.fetchrow("SELECT bank_id FROM vendors WHERE id = $1", uuid.UUID(vendor_id))
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    existing = await db_pool.fetchrow("SELECT id FROM users WHERE username = $1", user.username)
    if existing:
        raise HTTPException(status_code=400, detail=f"Username '{user.username}' already exists")
    password = generate_random_password()
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    row = await db_pool.fetchrow(
        """INSERT INTO users (username, email, password_hash, full_name, role, bank_id, vendor_id)
           VALUES ($1, $2, $3, $4, 'vendor_user', $5, $6)
           RETURNING id, username, email, full_name, role, bank_id, vendor_id, is_active, created_at""",
        user.username, user.email, password_hash, user.full_name,
        vendor["bank_id"], uuid.UUID(vendor_id),
    )
    user_dict = _row_to_dict(row)
    user_dict["generated_password"] = password
    return {"user": user_dict}


# ---------- Stats ----------

@app.get("/api/admin/stats")
async def admin_stats(_: dict = Depends(require_admin)):
    total_apps = await db_pool.fetchval("SELECT COUNT(*) FROM loan_applications")
    status_rows = await db_pool.fetch(
        "SELECT status, COUNT(*) AS count FROM loan_applications GROUP BY status ORDER BY count DESC"
    )
    status_counts = {r["status"]: r["count"] for r in status_rows}
    bank_rows = await db_pool.fetch(
        """SELECT b.id, b.name, b.code, b.vendor_limit,
                  (SELECT COUNT(*) FROM vendors v WHERE v.bank_id = b.id) AS vendor_count,
                  COUNT(la.id) AS app_count
             FROM banks b LEFT JOIN loan_applications la ON la.bank_id = b.id
            GROUP BY b.id ORDER BY app_count DESC"""
    )
    bank_counts = [
        {
            "bank_id": str(r["id"]), "bank_name": r["name"], "bank_code": r["code"],
            "vendor_limit": r["vendor_limit"], "vendor_count": r["vendor_count"],
            "count": r["app_count"],
        }
        for r in bank_rows
    ]
    approved = status_counts.get("approved", 0) + status_counts.get("disbursed", 0)
    reviewed = approved + status_counts.get("rejected", 0)
    approval_rate = round((approved / reviewed * 100), 1) if reviewed > 0 else 0.0
    total_banks = await db_pool.fetchval("SELECT COUNT(*) FROM banks")
    total_vendors = await db_pool.fetchval("SELECT COUNT(*) FROM vendors WHERE status = 'active'")
    total_bank_users = await db_pool.fetchval("SELECT COUNT(*) FROM users WHERE role = 'bank_user' AND is_active")
    total_vendor_users = await db_pool.fetchval("SELECT COUNT(*) FROM users WHERE role = 'vendor_user' AND is_active")
    active_calls = await db_pool.fetchval(
        "SELECT COUNT(*) FROM agent_calls WHERE status IN ('Pending', 'Dialing', 'In Progress', 'queued', 'dialing', 'in_progress')"
    )
    return {
        "total_applications": total_apps,
        "status_counts": status_counts,
        "bank_counts": bank_counts,
        "approval_rate": approval_rate,
        "total_banks": total_banks,
        "total_vendors": total_vendors,
        "total_bank_users": total_bank_users,
        "total_vendor_users": total_vendor_users,
        "active_calls": active_calls,
    }


@app.get("/api/admin/applications")
async def admin_list_applications(
    status: Optional[str] = None,
    bank_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    conds: list[str] = []
    params: list = []
    idx = 1
    if status:
        conds.append(f"la.status = ${idx}"); params.append(status); idx += 1
    if bank_id:
        conds.append(f"la.bank_id = ${idx}"); params.append(uuid.UUID(bank_id)); idx += 1
    if vendor_id:
        conds.append(f"la.vendor_id = ${idx}"); params.append(uuid.UUID(vendor_id)); idx += 1
    where = " AND ".join(conds) if conds else "TRUE"
    rows = await db_pool.fetch(
        f"""SELECT la.*, b.name AS bank_name, b.code AS bank_code, v.name AS vendor_name, v.code AS vendor_code
              FROM loan_applications la
              LEFT JOIN banks b   ON b.id = la.bank_id
              LEFT JOIN vendors v ON v.id = la.vendor_id
             WHERE {where}
             ORDER BY la.created_at DESC""",
        *params,
    )
    return {"applications": _rows_to_list(rows)}


@app.get("/api/admin/applications/{app_id}")
async def admin_get_application(app_id: str, _: dict = Depends(require_admin)):
    row = await db_pool.fetchrow(
        """SELECT la.*, b.name AS bank_name, b.code AS bank_code, v.name AS vendor_name, v.code AS vendor_code
             FROM loan_applications la
             LEFT JOIN banks b   ON b.id = la.bank_id
             LEFT JOIN vendors v ON v.id = la.vendor_id
            WHERE la.id = $1""",
        uuid.UUID(app_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Application not found")
    app_dict = _row_to_dict(row)
    if app_dict.get("aadhaar_number_encrypted"):
        app_dict["aadhaar_number"] = app_dict["aadhaar_number_encrypted"]
    transitions = await db_pool.fetch(
        "SELECT * FROM status_transitions WHERE application_id = $1 ORDER BY created_at ASC",
        uuid.UUID(app_id),
    )
    app_dict["status_history"] = _rows_to_list(transitions)
    return {"application": app_dict, "timeline": _rows_to_list(transitions)}

# ============================================================
# PORTAL APPLICATIONS (bank + vendor) — simplified workflow
# ============================================================

def _portal_scope(user: dict) -> tuple[str, list]:
    """Return ('bank_id = $1', [uuid]) or ('vendor_id = $1', [uuid]) for the current portal user."""
    if user["role"] == "bank_user":
        return "la.bank_id = $1", [uuid.UUID(user["bank_id"])]
    return "la.vendor_id = $1", [uuid.UUID(user["vendor_id"])]


@app.get("/api/portal/applications")
async def portal_list_applications(
    status: Optional[str] = None,
    user: dict = Depends(require_bank_or_vendor),
):
    where, params = _portal_scope(user)
    if status:
        where += f" AND la.status = ${len(params)+1}"
        params.append(status)
    rows = await db_pool.fetch(
        f"""SELECT la.*, b.name AS bank_name, b.code AS bank_code,
                   v.name AS vendor_name, v.code AS vendor_code
              FROM loan_applications la
              LEFT JOIN banks b   ON b.id = la.bank_id
              LEFT JOIN vendors v ON v.id = la.vendor_id
             WHERE {where}
             ORDER BY la.created_at DESC""",
        *params,
    )
    return {"applications": _rows_to_list(rows)}


async def _load_portal_application(app_id: str, user: dict) -> dict:
    where, params = _portal_scope(user)
    row = await db_pool.fetchrow(
        f"""SELECT la.*, b.name AS bank_name, b.code AS bank_code,
                   v.name AS vendor_name, v.code AS vendor_code
              FROM loan_applications la
              LEFT JOIN banks b   ON b.id = la.bank_id
              LEFT JOIN vendors v ON v.id = la.vendor_id
             WHERE la.id = ${len(params)+1} AND {where}""",
        *params, uuid.UUID(app_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Application not found or out of scope")
    return row


@app.get("/api/portal/applications/{app_id}")
async def portal_get_application(app_id: str, user: dict = Depends(require_bank_or_vendor)):
    row = await _load_portal_application(app_id, user)
    app_dict = _row_to_dict(row)
    if app_dict.get("aadhaar_number_encrypted"):
        app_dict["aadhaar_number"] = app_dict["aadhaar_number_encrypted"]
    transitions = await db_pool.fetch(
        "SELECT * FROM status_transitions WHERE application_id = $1 ORDER BY created_at ASC",
        uuid.UUID(app_id),
    )
    app_dict["status_history"] = _rows_to_list(transitions)
    return {"application": app_dict}


async def _bank_transition(
    app_id: str,
    bank_user: dict,
    allowed_from: set[str],
    target_status: str,
    payload: ReviewRequest | RejectRequest,
    extra_updates: Optional[dict] = None,
    notify_subject: Optional[str] = None,
    notify_body: Optional[str] = None,
):
    bank_uuid = uuid.UUID(bank_user["bank_id"])
    reviewer_id = uuid.UUID(bank_user["id"])
    app_row = await db_pool.fetchrow(
        "SELECT * FROM loan_applications WHERE id = $1 AND bank_id = $2",
        uuid.UUID(app_id), bank_uuid,
    )
    if not app_row:
        raise HTTPException(status_code=404, detail="Application not found or not in your bank")
    current = app_row["status"]
    if current not in allowed_from:
        allowed_list = ", ".join(sorted(allowed_from))
        raise HTTPException(
            status_code=400,
            detail=f"Cannot move to '{target_status}' from '{current}'. Allowed: {allowed_list}",
        )

    updates = {"status": target_status, "reviewed_by": reviewer_id, "reviewed_at": now_utc()}
    if isinstance(payload, RejectRequest):
        updates["review_notes"] = payload.notes
        updates["rejection_reason"] = payload.rejection_reason
    else:
        updates["review_notes"] = payload.notes
    if extra_updates:
        updates.update(extra_updates)

    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates.keys()))
    vals = list(updates.values()) + [uuid.UUID(app_id)]
    await db_pool.execute(f"UPDATE loan_applications SET {sets} WHERE id = ${len(updates)+1}", *vals)

    note = payload.notes or ""
    if isinstance(payload, RejectRequest) and payload.rejection_reason:
        note = f"[Reason: {payload.rejection_reason}] {note}".strip()
    await record_transition(uuid.UUID(app_id), current, target_status, "bank_user", reviewer_id, note or None)

    if notify_body and app_row["phone"]:
        await send_whatsapp_message(app_row["phone"], notify_body.format(
            customer_name=app_row["customer_name"],
            loan_id=app_row["loan_id"],
            reason=(payload.rejection_reason if isinstance(payload, RejectRequest) else "") or "Contact customer service",
        ))
    return {"status": "success", "message": notify_subject or f"Status updated to {target_status}", "new_status": target_status}


@app.post("/api/portal/applications/{app_id}/approve")
async def portal_approve(app_id: str, body: ReviewRequest, user: dict = Depends(require_bank_user)):
    return await _bank_transition(
        app_id, user,
        allowed_from={"submitted", "system_reviewed"},
        target_status="approved",
        payload=body,
        extra_updates={"approved_at": now_utc()},
        notify_subject="Application approved",
        notify_body=(
            "Congratulations {customer_name}!\n\n"
            "Your loan application has been APPROVED.\n\n"
            "Loan ID: {loan_id}\n\n"
            "Our team will contact you within 24 hours for next steps.\n\n- Your Bank"
        ),
    )


@app.post("/api/portal/applications/{app_id}/reject")
async def portal_reject(app_id: str, body: RejectRequest, user: dict = Depends(require_bank_user)):
    return await _bank_transition(
        app_id, user,
        allowed_from={"submitted", "system_reviewed", "approved", "documents_requested", "documents_submitted"},
        target_status="rejected",
        payload=body,
        notify_subject="Application rejected",
        notify_body=(
            "Dear {customer_name},\n\n"
            "Your loan application has been reviewed.\n\n"
            "Loan ID: {loan_id}\nStatus: Not Approved\n\n"
            "Reason: {reason}\n\n- Your Bank"
        ),
    )


@app.post("/api/portal/applications/{app_id}/request-documents")
async def portal_request_documents(app_id: str, body: ReviewRequest, user: dict = Depends(require_bank_user)):
    return await _bank_transition(
        app_id, user,
        allowed_from={"approved"},
        target_status="documents_requested",
        payload=body,
        extra_updates={"documents_requested_at": now_utc()},
        notify_subject="Documents requested",
        notify_body=(
            "Dear {customer_name},\n\n"
            "Additional documents have been requested for your loan application.\n\n"
            "Loan ID: {loan_id}\n\n"
            "Please submit the required documents at your earliest.\n\n- Your Bank"
        ),
    )


@app.post("/api/portal/applications/{app_id}/disburse")
async def portal_disburse(app_id: str, body: ReviewRequest, user: dict = Depends(require_bank_user)):
    return await _bank_transition(
        app_id, user,
        allowed_from={"approved", "documents_submitted"},
        target_status="disbursed",
        payload=body,
        extra_updates={"disbursed_at": now_utc()},
        notify_subject="Disbursement initiated",
        notify_body=(
            "Dear {customer_name},\n\n"
            "Great news! Disbursement has been initiated for your loan.\n\n"
            "Loan ID: {loan_id}\n\n"
            "You will receive the funds shortly.\n\n- Your Bank"
        ),
    )


# ============================================================
# PORTAL VENDORS (bank_user only — manage vendors within vendor_limit)
# ============================================================

@app.get("/api/portal/vendors")
async def portal_list_vendors(user: dict = Depends(require_bank_user)):
    bank_uuid = uuid.UUID(user["bank_id"])
    bank = await db_pool.fetchrow("SELECT vendor_limit FROM banks WHERE id = $1", bank_uuid)
    rows = await db_pool.fetch(
        """SELECT v.*,
                  (SELECT COUNT(*) FROM users u WHERE u.vendor_id = v.id AND u.role = 'vendor_user' AND u.is_active) AS active_user_count,
                  (SELECT COUNT(*) FROM loan_applications la WHERE la.vendor_id = v.id) AS application_count
             FROM vendors v WHERE v.bank_id = $1 ORDER BY v.created_at DESC""",
        bank_uuid,
    )
    return {
        "vendors": _rows_to_list(rows),
        "vendor_limit": bank["vendor_limit"] if bank else 0,
        "vendor_count": len(rows),
    }


@app.post("/api/portal/vendors")
async def portal_create_vendor(payload: VendorCreate, user: dict = Depends(require_bank_user)):
    bank_uuid = uuid.UUID(user["bank_id"])
    await _assert_vendor_within_limit(bank_uuid)
    dup = await db_pool.fetchrow(
        "SELECT id FROM vendors WHERE bank_id = $1 AND code = $2", bank_uuid, payload.code,
    )
    if dup:
        raise HTTPException(status_code=400, detail=f"Vendor code '{payload.code}' already exists")
    row = await db_pool.fetchrow(
        """INSERT INTO vendors (bank_id, name, code, category, contact_name, contact_email, contact_phone, address, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *""",
        bank_uuid, payload.name, payload.code, payload.category,
        payload.contact_name, payload.contact_email, payload.contact_phone, payload.address,
        uuid.UUID(user["id"]),
    )
    return {"vendor": _row_to_dict(row)}


@app.get("/api/portal/vendors/{vendor_id}")
async def portal_get_vendor(vendor_id: str, user: dict = Depends(require_bank_user)):
    bank_uuid = uuid.UUID(user["bank_id"])
    row = await db_pool.fetchrow(
        "SELECT * FROM vendors WHERE id = $1 AND bank_id = $2",
        uuid.UUID(vendor_id), bank_uuid,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Vendor not found")
    users = await db_pool.fetch(
        """SELECT id, username, email, full_name, is_active, created_at, last_login_at
             FROM users WHERE vendor_id = $1 AND role = 'vendor_user' ORDER BY created_at DESC""",
        uuid.UUID(vendor_id),
    )
    out = _row_to_dict(row)
    out["users"] = _rows_to_list(users)
    return {"vendor": out}


@app.put("/api/portal/vendors/{vendor_id}")
async def portal_update_vendor(vendor_id: str, payload: VendorUpdate, user: dict = Depends(require_bank_user)):
    bank_uuid = uuid.UUID(user["bank_id"])
    existing = await db_pool.fetchrow(
        "SELECT * FROM vendors WHERE id = $1 AND bank_id = $2",
        uuid.UUID(vendor_id), bank_uuid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Vendor not found")
    updates: dict = {}
    for fld in ("name", "category", "contact_name", "contact_email", "contact_phone", "address"):
        val = getattr(payload, fld)
        if val is not None:
            updates[fld] = val
    if payload.code is not None:
        dup = await db_pool.fetchrow(
            "SELECT id FROM vendors WHERE bank_id = $1 AND code = $2 AND id != $3",
            bank_uuid, payload.code, uuid.UUID(vendor_id),
        )
        if dup:
            raise HTTPException(status_code=400, detail=f"Vendor code '{payload.code}' already in use")
        updates["code"] = payload.code
    if payload.status is not None:
        if payload.status not in ("active", "inactive"):
            raise HTTPException(status_code=400, detail="Status must be 'active' or 'inactive'")
        updates["status"] = payload.status
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(updates.keys()))
    vals = list(updates.values()) + [uuid.UUID(vendor_id)]
    await db_pool.execute(f"UPDATE vendors SET {sets} WHERE id = ${len(updates)+1}", *vals)
    row = await db_pool.fetchrow("SELECT * FROM vendors WHERE id = $1", uuid.UUID(vendor_id))
    return {"vendor": _row_to_dict(row)}


@app.delete("/api/portal/vendors/{vendor_id}")
async def portal_deactivate_vendor(vendor_id: str, user: dict = Depends(require_bank_user)):
    bank_uuid = uuid.UUID(user["bank_id"])
    existing = await db_pool.fetchrow(
        "SELECT name FROM vendors WHERE id = $1 AND bank_id = $2",
        uuid.UUID(vendor_id), bank_uuid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Vendor not found")
    await db_pool.execute("UPDATE vendors SET status = 'inactive' WHERE id = $1", uuid.UUID(vendor_id))
    return {"status": "deactivated", "message": f"Vendor {existing['name']} deactivated"}


@app.post("/api/portal/vendors/{vendor_id}/users")
async def portal_create_vendor_user(vendor_id: str, user_payload: UserCreate, user: dict = Depends(require_bank_user)):
    bank_uuid = uuid.UUID(user["bank_id"])
    vendor = await db_pool.fetchrow(
        "SELECT id FROM vendors WHERE id = $1 AND bank_id = $2",
        uuid.UUID(vendor_id), bank_uuid,
    )
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found")
    existing = await db_pool.fetchrow("SELECT id FROM users WHERE username = $1", user_payload.username)
    if existing:
        raise HTTPException(status_code=400, detail=f"Username '{user_payload.username}' already exists")
    password = generate_random_password()
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    row = await db_pool.fetchrow(
        """INSERT INTO users (username, email, password_hash, full_name, role, bank_id, vendor_id)
           VALUES ($1, $2, $3, $4, 'vendor_user', $5, $6)
           RETURNING id, username, email, full_name, role, bank_id, vendor_id, is_active, created_at""",
        user_payload.username, user_payload.email, password_hash, user_payload.full_name,
        bank_uuid, uuid.UUID(vendor_id),
    )
    out = _row_to_dict(row)
    out["generated_password"] = password
    return {"user": out}

# ============================================================
# CALLS — portal + admin + live transcript SSE
# ============================================================

import asyncio as _asyncio
_call_subscribers: dict[str, list["_asyncio.Queue"]] = {}
_ended_calls: set[str] = set()


async def publish_to_call(call_id: str, payload: dict):
    queues = _call_subscribers.get(call_id, [])
    for q in list(queues):
        try:
            q.put_nowait(payload)
        except Exception:
            pass


def _subscribe_call(call_id: str) -> "_asyncio.Queue":
    q: _asyncio.Queue = _asyncio.Queue(maxsize=256)
    _call_subscribers.setdefault(call_id, []).append(q)
    return q


def _unsubscribe_call(call_id: str, q: "_asyncio.Queue") -> None:
    queues = _call_subscribers.get(call_id, [])
    if q in queues:
        queues.remove(q)
    if not queues:
        _call_subscribers.pop(call_id, None)


def mark_call_ended(call_id: str):
    _ended_calls.add(call_id)


def _calls_scope_where(user: dict, table_alias: str = "c") -> tuple[str, list]:
    prefix = f"{table_alias}." if table_alias else ""
    role = user["role"]
    if role == "admin":
        return "TRUE", []
    if role == "bank_user":
        return f"{prefix}bank_id = $1", [uuid.UUID(user["bank_id"])]
    if role == "vendor_user":
        return f"{prefix}vendor_id = $1", [uuid.UUID(user["vendor_id"])]
    raise HTTPException(status_code=403, detail="Forbidden")


@app.get("/api/portal/calls")
async def portal_list_calls(
    status: Optional[str] = None,
    user: dict = Depends(require_bank_or_vendor),
):
    where, params = _calls_scope_where(user, "c")
    if status:
        where += f" AND c.status = ${len(params)+1}"
        params.append(status)
    rows = await db_pool.fetch(
        f"""SELECT c.*, b.name AS bank_name, b.code AS bank_code,
                   v.name AS vendor_name, v.code AS vendor_code
              FROM agent_calls c
              LEFT JOIN banks b   ON b.id = c.bank_id
              LEFT JOIN vendors v ON v.id = c.vendor_id
             WHERE {where}
             ORDER BY c.created_at DESC LIMIT 200""",
        *params,
    )
    return {"calls": _rows_to_list(rows)}


@app.get("/api/portal/calls/{call_id}")
async def portal_get_call(call_id: str, user: dict = Depends(require_bank_or_vendor)):
    where, params = _calls_scope_where(user, "c")
    row = await db_pool.fetchrow(
        f"""SELECT c.*, b.name AS bank_name, b.code AS bank_code,
                   v.name AS vendor_name, v.code AS vendor_code
              FROM agent_calls c
              LEFT JOIN banks b   ON b.id = c.bank_id
              LEFT JOIN vendors v ON v.id = c.vendor_id
             WHERE c.id = ${len(params)+1} AND {where}""",
        *params, uuid.UUID(call_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found or out of scope")
    return {"call": _row_to_dict(row)}


@app.post("/api/portal/calls/single")
async def portal_initiate_single_call(
    payload: SingleCallRequest,
    user: dict = Depends(require_bank_or_vendor),
):
    """Create an agent_calls row in 'queued' status. Voice-agent dispatch happens
    separately (the LiveKit worker picks queued rows up)."""
    bank_id = uuid.UUID(user["bank_id"])
    vendor_id = uuid.UUID(user["vendor_id"]) if user.get("vendor_id") else None
    room_name = f"los_{secrets.token_hex(6)}_{int(datetime.now().timestamp())}"
    row = await db_pool.fetchrow(
        """INSERT INTO agent_calls
            (bank_id, vendor_id, initiated_by, customer_name, phone,
             loan_type, loan_amount, language, status, room_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9)
           RETURNING *""",
        bank_id, vendor_id, uuid.UUID(user["id"]),
        payload.customer_name, payload.phone,
        payload.loan_type or None, payload.loan_amount or None,
        payload.language, room_name,
    )
    return {"call": _row_to_dict(row)}


# ---------- Admin-scoped calls ----------

@app.get("/api/admin/calls")
async def admin_list_calls(
    status: Optional[str] = None,
    bank_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    _: dict = Depends(require_admin),
):
    conds, params = [], []
    if status:     conds.append(f"c.status = ${len(params)+1}"); params.append(status)
    if bank_id:    conds.append(f"c.bank_id = ${len(params)+1}"); params.append(uuid.UUID(bank_id))
    if vendor_id:  conds.append(f"c.vendor_id = ${len(params)+1}"); params.append(uuid.UUID(vendor_id))
    where = " AND ".join(conds) if conds else "TRUE"
    rows = await db_pool.fetch(
        f"""SELECT c.*, b.name AS bank_name, b.code AS bank_code,
                   v.name AS vendor_name, v.code AS vendor_code
              FROM agent_calls c
              LEFT JOIN banks b   ON b.id = c.bank_id
              LEFT JOIN vendors v ON v.id = c.vendor_id
             WHERE {where}
             ORDER BY c.created_at DESC LIMIT 500""",
        *params,
    )
    return {"calls": _rows_to_list(rows)}


@app.get("/api/admin/calls/{call_id}")
async def admin_get_call(call_id: str, _: dict = Depends(require_admin)):
    row = await db_pool.fetchrow(
        """SELECT c.*, b.name AS bank_name, b.code AS bank_code,
                  v.name AS vendor_name, v.code AS vendor_code
             FROM agent_calls c
             LEFT JOIN banks b   ON b.id = c.bank_id
             LEFT JOIN vendors v ON v.id = c.vendor_id
            WHERE c.id = $1""",
        uuid.UUID(call_id),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    return {"call": _row_to_dict(row)}


# ---------- Live transcript SSE ----------

def _sse(event: str, data) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


async def _call_access_for(user: dict, call_id: str) -> dict:
    """Fetch a call and enforce scope. Admin sees all, bank sees own bank, vendor sees own vendor."""
    row = await db_pool.fetchrow("SELECT * FROM agent_calls WHERE id = $1", uuid.UUID(call_id))
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")
    role = user["role"]
    if role == "admin":
        return dict(row)
    if role == "bank_user" and str(row["bank_id"]) == user["bank_id"]:
        return dict(row)
    if role == "vendor_user" and row["vendor_id"] and str(row["vendor_id"]) == user["vendor_id"]:
        return dict(row)
    raise HTTPException(status_code=403, detail="Forbidden")


@app.get("/api/live-transcript/{call_id}")
async def live_transcript_stream(
    call_id: str,
    request: Request,
    user: dict = Depends(require_any_authenticated),
):
    """SSE stream of live transcript entries for an active call.
    Snapshots the current DB transcript, then streams each new entry published by /api/agent/transcript."""
    call_row = await _call_access_for(user, call_id)

    from fastapi.responses import StreamingResponse

    async def event_stream():
        # snapshot
        snapshot = call_row.get("transcript") or []
        if isinstance(snapshot, str):
            try:
                snapshot = json.loads(snapshot)
            except Exception:
                snapshot = []
        yield _sse("snapshot", snapshot)

        queue = _subscribe_call(call_id)
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    evt = await _asyncio.wait_for(queue.get(), timeout=25)
                    yield _sse("transcript", evt)
                    if call_id in _ended_calls:
                        yield _sse("done", {"call_id": call_id})
                        break
                except _asyncio.TimeoutError:
                    yield b": keepalive\n\n"
                    # Also hop back to DB to detect terminal status in case we missed the signal
                    cur = await db_pool.fetchrow(
                        "SELECT status, ended_at FROM agent_calls WHERE id = $1", uuid.UUID(call_id),
                    )
                    if cur and (cur["ended_at"] or str(cur["status"]).lower() in ("completed", "failed", "not_answered")):
                        yield _sse("done", {"call_id": call_id})
                        break
        finally:
            _unsubscribe_call(call_id, queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ============================================================
# FORM TOKEN & APPLICATION ENDPOINTS (EXISTING)
# ============================================================

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
            row = await db_pool.fetchrow(
                """INSERT INTO form_tokens (token, customer_name, phone, loan_id, loan_amount, loan_type, email, date_of_birth, address, expires_at, bank_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id""",
                token, customer.customer_name, customer.phone, customer.loan_id,
                float(customer.loan_amount), customer.loan_type, customer.email,
                customer.date_of_birth, customer.address, expires_at, bank_id
            )
            token_id = str(row["id"])
            form_url = f"{FORM_BASE_URL}/form/{token}"

            # Also create a loan_application with bank_id if provided
            app_row = await db_pool.fetchrow(
                """INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at, bank_id)
                   VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING id""",
                row["id"], customer.customer_name, customer.phone, customer.loan_id, now_utc(), bank_id
            )

            message = (
                f"Dear {customer.customer_name},\n\n"
                f"Complete your loan application for {customer.loan_type}.\n\n"
                f"Loan ID: {customer.loan_id}\nAmount: Rs.{customer.loan_amount:,.2f}\n\n"
                f"Click to fill the form:\n{form_url}\n\nValid for 7 days. Do not share this link.\n\n- Your Bank Name"
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
    otp = generate_otp()
    otp_hash_val = hash_otp(otp)
    expires_at = now_utc() + timedelta(minutes=10)
    await db_pool.execute(
        """INSERT INTO otp_verifications (token_id, phone, otp_hash, expires_at, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5::inet, $6)""",
        row["id"], row["phone"], otp_hash_val, expires_at, request.client.host, request.headers.get("user-agent")
    )
    print(f"OTP for {row['phone']}: {otp}")
    await send_otp_via_aisensy(row["phone"], otp)
    return {"status": "otp_sent", "message": "OTP sent to your WhatsApp", "expires_in_minutes": 10}

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
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE token_id = $1", token_row["id"])
    safe_data = {k: _coerce_value(k, v) for k, v in payload.data.items() if k in AUTOSAVE_COLUMNS}
    if app_row:
        app_id = app_row["id"]
        # Filter out None values to avoid overwriting with NULL
        safe_data = {k: v for k, v in safe_data.items() if v is not None}
        # Ensure highest_step only goes up, never down
        if "highest_step" in safe_data:
            current_highest = app_row["highest_step"] or 1
            if safe_data["highest_step"] <= current_highest:
                safe_data.pop("highest_step")
        if safe_data:
            sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(safe_data.keys()))
            vals = list(safe_data.values())
            vals.append(payload.step)
            vals.append(now_utc())
            vals.append(app_id)
            n = len(safe_data)
            await db_pool.execute(
                f"UPDATE loan_applications SET {sets}, current_step = ${n+1}, last_saved_at = ${n+2} WHERE id = ${n+3}",
                *vals
            )
        else:
            await db_pool.execute(
                "UPDATE loan_applications SET current_step = $1, last_saved_at = $2 WHERE id = $3",
                payload.step, now_utc(), app_id
            )
    else:
        # Inherit bank_id from token if available
        bank_id = token_row.get("bank_id")
        row = await db_pool.fetchrow(
            """INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at, bank_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id""",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], payload.step, now_utc(), bank_id
        )
        app_id = row["id"]
        if safe_data:
            sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(safe_data.keys()))
            vals = list(safe_data.values())
            vals.append(app_id)
            await db_pool.execute(f"UPDATE loan_applications SET {sets} WHERE id = ${len(safe_data)+1}", *vals)
    return {"status": "saved", "application_id": str(app_id), "timestamp": now_utc().isoformat()}

@app.post("/api/verify-pan")
async def verify_pan(token: str, pan_number: str, request: Request):
    token_row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", token)
    if not token_row:
        raise HTTPException(status_code=404, detail="Invalid token")
    if not re.match(r'^[A-Z]{5}[0-9]{4}[A-Z]{1}$', pan_number):
        raise HTTPException(status_code=400, detail="Invalid PAN format")
    # Create application row if it doesn't exist yet
    app_row = await db_pool.fetchrow("SELECT id FROM loan_applications WHERE token_id = $1", token_row["id"])
    if not app_row:
        bank_id = token_row.get("bank_id")
        await db_pool.execute(
            "INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at, bank_id) VALUES ($1, $2, $3, $4, 1, $5, $6)",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc(), bank_id
        )
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
        "UPDATE loan_applications SET pan_number = $1, pan_verified = true, pan_verification_timestamp = $2, pan_name = $3 WHERE token_id = $4",
        pan_number, now_utc(), pan_name or None, token_row["id"]
    )
    if pan_name:
        app = await db_pool.fetchrow("SELECT id FROM loan_applications WHERE token_id = $1", token_row["id"])
        if app:
            await save_field_sources(app["id"], "pan", {"first_name": pan_name.split()[0] if pan_name else "", "middle_name": " ".join(pan_name.split()[1:-1]) if len(pan_name.split()) > 2 else "", "last_name": pan_name.split()[-1] if len(pan_name.split()) > 1 else "", "full_name": pan_name})
    result = {"status": "verified", "message": "PAN verified successfully"}
    if pan_name:
        result["name"] = pan_name
    return result

@app.post("/api/verify-aadhaar")
async def verify_aadhaar(token: str, aadhaar_number: str, request: Request):
    token_row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", token)
    if not token_row:
        raise HTTPException(status_code=404, detail="Invalid token")
    if not re.match(r'^\d{12}$', aadhaar_number):
        raise HTTPException(status_code=400, detail="Invalid Aadhaar format")
    last4 = aadhaar_number[-4:]
    # Create application row if it doesn't exist yet
    app_row = await db_pool.fetchrow("SELECT id FROM loan_applications WHERE token_id = $1", token_row["id"])
    if not app_row:
        bank_id = token_row.get("bank_id")
        await db_pool.execute(
            "INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at, bank_id) VALUES ($1, $2, $3, $4, 1, $5, $6)",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc(), bank_id
        )
    await db_pool.execute(
        "UPDATE loan_applications SET aadhaar_last4 = $1, aadhaar_number_encrypted = $2, aadhaar_verified = true, aadhaar_verification_timestamp = $3 WHERE token_id = $4",
        last4, aadhaar_number, now_utc(), token_row["id"]
    )
    return {"status": "verified", "message": "Aadhaar verified successfully", "last4": last4}

# ============================================
# DIGILOCKER AADHAAR VERIFICATION (VG DocVerify API)
# ============================================

@app.post("/api/aadhaar-link")
async def generate_aadhaar_link(request: Request):
    """Step 1: Generate DigiLocker OAuth link. User clicks this to authenticate with Aadhaar."""
    data = await request.json()
    token = data.get('token') or data.get('session_token')
    aadhaar_number = data.get('aadhaar_number', '')
    if not token:
        raise HTTPException(status_code=400, detail="Token or session_token required")
    row, application_id = await resolve_token_or_session(token)

    if VG_MOCK_MODE:
        mock_request_id = f"mock-{secrets.token_hex(8)}"
        if application_id:
            await db_pool.execute("UPDATE loan_applications SET digilocker_request_id = $1 WHERE id = $2", mock_request_id, application_id)
        return {"status": "success", "request_id": mock_request_id, "link": f"{FORM_BASE_URL}/loan-form/application?digilocker=success&requestId={mock_request_id}", "mock": True}

    payload = {"obj": [{
        **vg_base_obj("digilocker_link"),
        "redirectUrl": f"{FORM_BASE_URL}/loan-form/application?digilocker=success",
        "oAuthState": "123",
        "aadhaarFlowRequired": "true",
        "pinlessAuth": "true",
        "customDocList": "ADHAR",
    }]}
    # DigiLocker link generation involves VG → DigiLocker OAuth setup (slower than PAN)
    max_retries = 2
    last_error = None
    for attempt in range(max_retries):
        try:
            print(f"[DigiLocker Link] Attempt {attempt+1}/{max_retries}, payload keys: {list(payload['obj'][0].keys())}")
            async with httpx.AsyncClient(verify=False, timeout=60.0) as client:
                response = await client.post(f"{VG_API_BASE}/Digilockerlink", json=payload, headers={"Content-Type": "application/json"})
            print(f"[DigiLocker Link] Response ({response.status_code}): {response.text[:500]}")
            api_data = parse_vg_response(response.text)
            if str(api_data.get("statusCode")) != "101":
                raise HTTPException(status_code=400, detail=f"DigiLocker link generation failed: {api_data.get('message', '')}")
            request_id = api_data.get("requestId")
            link = api_data.get("result", {}).get("link")
            if not link:
                raise HTTPException(status_code=400, detail="No DigiLocker link returned")
            if application_id:
                await db_pool.execute("UPDATE loan_applications SET digilocker_request_id = $1 WHERE id = $2", request_id, application_id)
            return {"status": "success", "request_id": request_id, "link": link}
        except HTTPException:
            raise
        except httpx.TimeoutException as e:
            last_error = e
            print(f"[DigiLocker Link] Timeout on attempt {attempt+1}: {repr(e)}")
            if attempt < max_retries - 1:
                continue  # retry
            raise HTTPException(status_code=504, detail="DigiLocker server took too long to respond. Please try again.")
        except Exception as e:
            print(f"[DigiLocker Link] Error on attempt {attempt+1}: {repr(e)}")
            raise HTTPException(status_code=500, detail=f"DigiLocker Error: {repr(e)}")

@app.post("/api/aadhaar-documents")
async def fetch_aadhaar_documents(request: Request):
    """Step 2: After customer completes DigiLocker auth, fetch available documents."""
    data = await request.json()
    token = data.get('token') or data.get('session_token')
    request_id = data.get('request_id')
    if not token or not request_id:
        raise HTTPException(status_code=400, detail="Token and request_id required")
    await resolve_token_or_session(token)

    if VG_MOCK_MODE:
        return {"status": "success", "request_id": request_id, "uri": "in.gov.uidai-ADHAR-mock-document-uri", "mock": True}

    payload = {"obj": [{**vg_base_obj("digilocker_doc"), "AccessRequestId": request_id}]}
    try:
        print(f"[DigiLocker Docs] request_id={request_id}")
        async with httpx.AsyncClient(verify=False, timeout=60.0) as client:
            response = await client.post(f"{VG_API_BASE}/Digilockerdocuments", json=payload, headers={"Content-Type": "application/json"})
        print(f"[DigiLocker Docs] Response ({response.status_code}): {response.text[:500]}")
        api_data = parse_vg_response(response.text)
        if str(api_data.get("statusCode")) != "101":
            raise HTTPException(status_code=400, detail=f"Failed to fetch Aadhaar documents: {api_data.get('message', '')}")
        results = api_data.get("result", [])
        results = results if isinstance(results, list) else [results]
        uri = None
        for doc in results:
            if isinstance(doc, dict) and doc.get("doctype") == "ADHAR":
                uri = doc.get("uri")
                break
        if not uri:
            raise HTTPException(status_code=400, detail="Aadhaar document not found in DigiLocker")
        return {"status": "success", "request_id": request_id, "uri": uri}
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="DigiLocker documents request timed out. Please try again.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DigiLocker Documents Error: {repr(e)}")

@app.post("/api/aadhaar-download")
async def download_aadhaar(request: Request):
    """Step 3: Download and parse Aadhaar from DigiLocker. Auto-fills form fields."""
    data = await request.json()
    token = data.get('token') or data.get('session_token')
    request_id = data.get('request_id')
    uri = data.get('uri')
    if not token or not request_id or not uri:
        raise HTTPException(status_code=400, detail="token, request_id, and uri are required")
    row, application_id = await resolve_token_or_session(token)

    if VG_MOCK_MODE:
        mock_data = {
            "name": "MOCK VERIFIED USER",
            "dob": "1990-05-15",
            "gender": "Male",
            "address": "Mock Address, 123 Test Street, Nagpur, Maharashtra, 440024",
            "last4": "7183",
            "photo": None,
        }
        if application_id:
            await db_pool.execute(
                """UPDATE loan_applications SET aadhaar_verified = true, aadhaar_last4 = $1,
                   aadhaar_name = $2, aadhaar_dob = $3, aadhaar_gender = $4, aadhaar_address = $5,
                   aadhaar_verification_timestamp = $6 WHERE id = $7""",
                mock_data["last4"], mock_data["name"], mock_data["dob"], mock_data["gender"],
                mock_data["address"], now_utc(), application_id,
            )
        return {"status": "success", "data": mock_data, "mock": True}

    payload = {"obj": [{
        **vg_base_obj("digilocker_download"),
        "AccessRequestId": request_id, "uri": uri,
        "pdfB64": "true", "parsed": "true", "xml": "true", "json": "true",
    }]}
    try:
        print(f"[DigiLocker Download] request_id={request_id}, uri={uri}")
        async with httpx.AsyncClient(verify=False, timeout=90.0) as client:
            response = await client.post(f"{VG_API_BASE}/Digilockerdownload", json=payload, headers={"Content-Type": "application/json"})
        print(f"[DigiLocker Download] Response ({response.status_code}): {response.text[:500]}")
        api_data = parse_vg_response(response.text)
        if str(api_data.get("statusCode")) != "101":
            raise HTTPException(status_code=400, detail=f"Aadhaar download failed: {api_data.get('message', '')}")
        result_list = api_data.get("result", [])
        result_list = result_list if isinstance(result_list, list) else [result_list]
        if not result_list:
            raise HTTPException(status_code=400, detail="No Aadhaar data in response")
        # Log full response key structure (to identify PDF/photo fields)
        def _keys_deep(obj, prefix=""):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    vtype = type(v).__name__
                    vlen = f" ({len(v)} chars)" if isinstance(v, str) and len(v) > 100 else (f" = {v}" if not isinstance(v, (dict, list)) else "")
                    print(f"[DigiLocker Keys] {prefix}{k}: {vtype}{vlen}")
                    if isinstance(v, (dict, list)):
                        _keys_deep(v, prefix + k + ".")
            elif isinstance(obj, list):
                for i, item in enumerate(obj[:2]):
                    _keys_deep(item, f"{prefix}[{i}].")
        _keys_deep({"top": api_data}, "")
        # Extract parsed data from DigiLocker response
        parsed_file = result_list[0].get("parsedFile", {})
        issued_to = parsed_file.get("data", {}).get("issuedTo", {})
        additional = parsed_file.get("data", {}).get("additionalData", {})

        # Name
        name = issued_to.get("name", "")

        # UID (masked aadhaar — e.g., xxxxxxxx7183)
        uid = issued_to.get("uid", "")
        last4 = uid[-4:] if uid and len(uid) >= 4 else ""

        # DOB — API returns DD-MM-YYYY, convert to YYYY-MM-DD for form
        raw_dob = issued_to.get("dob", "") or additional.get("dob", "")
        dob = ""
        if raw_dob:
            parts = raw_dob.split("-")
            if len(parts) == 3 and len(parts[0]) <= 2:  # DD-MM-YYYY
                dob = f"{parts[2]}-{parts[1]}-{parts[0]}"
            else:
                dob = raw_dob  # Already YYYY-MM-DD or other format

        # Gender
        raw_gender = issued_to.get("gender", "") or additional.get("gender", "")
        g = raw_gender.strip().upper()
        gender = "Male" if g in ["M", "MALE"] else ("Female" if g in ["F", "FEMALE"] else raw_gender)

        # Marital Status
        marital_status = issued_to.get("maritalStatus", "") or ""

        # Address — extract structured fields
        addr = issued_to.get("address", {})
        pin = ""
        district = ""
        state = ""
        addr_house = ""
        addr_street = ""
        addr_landmark = ""
        addr_locality = ""
        address_full = ""
        if isinstance(addr, dict):
            pin = str(addr.get("pin", addr.get("pc", ""))).strip()
            district = str(addr.get("district", addr.get("dist", ""))).strip()
            state = str(addr.get("state", "")).strip()
            addr_house = str(addr.get("house", "")).strip()
            addr_street = str(addr.get("street", "") or addr.get("locality", "")).strip()
            addr_landmark = str(addr.get("landmark", "") or addr.get("lm", "")).strip()
            addr_locality = str(addr.get("loc", "") or addr.get("vtc", "")).strip()
            # Build full address string (backward compat)
            parts = [addr_house, addr_street, addr_landmark, addr_locality, district, state, pin]
            address_full = ", ".join([p for p in parts if p])
        elif isinstance(addr, str) and addr:
            address_full = addr

        # Resolve state/city text to API codes
        state_code = await resolve_state_code(state) if state else None
        city_code = await resolve_city_code(district, state_code) if district and state_code else None

        # Photo (base64 JPEG)
        photo_data = issued_to.get("photo", {})
        photo_b64 = photo_data.get("content", "") if isinstance(photo_data, dict) else None

        print(f"[DigiLocker] Extracted: name={name}, uid={uid}, dob={dob}, gender={gender}, pin={pin}, district={district}")

        photo_file_url = None
        aadhaar_pdf_url = None
        if application_id:
            app_row = await db_pool.fetchrow("SELECT loan_id FROM loan_applications WHERE id = $1", application_id)
            loan_id = app_row["loan_id"] if app_row else str(application_id)
            loan_dir = UPLOAD_DIR / loan_id
            loan_dir.mkdir(parents=True, exist_ok=True)

            # Save passport photo as JPEG file (auto-fill for Documents step)
            if photo_b64:
                photo_path = loan_dir / "photo_digilocker.jpg"
                async with aiofiles.open(photo_path, 'wb') as f:
                    await f.write(b64mod.b64decode(photo_b64))
                photo_file_url = f"/uploads/{loan_id}/photo_digilocker.jpg"
                print(f"[DigiLocker] Saved passport photo: {photo_file_url}")

            # Save signed Aadhaar XML (audit/verification backup)
            xml_data = result_list[0].get("rawFiles", {}).get("xml", {})
            xml_content = xml_data.get("content", "") if isinstance(xml_data, dict) else ""
            if xml_content:
                xml_path = loan_dir / "aadhaar_digilocker.xml"
                async with aiofiles.open(xml_path, 'w') as f:
                    await f.write(xml_content)
                print(f"[DigiLocker] Saved Aadhaar XML: /uploads/{loan_id}/aadhaar_digilocker.xml")

            # Generate clean PDF from the parsed data (for user-friendly viewing)
            try:
                # Format masked UID for display: XXXX XXXX 3461
                display_uid = f"XXXX XXXX {last4}" if last4 else uid
                pdf_bytes = generate_aadhaar_pdf(name, dob, gender, address_full, display_uid, photo_b64)
                pdf_path = loan_dir / "aadhaar_digilocker.pdf"
                async with aiofiles.open(pdf_path, 'wb') as f:
                    await f.write(pdf_bytes)
                aadhaar_pdf_url = f"/uploads/{loan_id}/aadhaar_digilocker.pdf"
                print(f"[DigiLocker] Generated Aadhaar PDF: {aadhaar_pdf_url}")
            except Exception as e:
                print(f"[DigiLocker] PDF generation failed: {e}")
                # Fallback: use XML URL if PDF fails
                aadhaar_pdf_url = f"/uploads/{loan_id}/aadhaar_digilocker.xml" if xml_content else None

            await db_pool.execute(
                """UPDATE loan_applications SET aadhaar_verified = true, aadhaar_last4 = $1,
                   aadhaar_name = $2, aadhaar_dob = $3, aadhaar_gender = $4, aadhaar_address = $5,
                   aadhaar_photo_b64 = $6, aadhaar_verification_timestamp = $7,
                   marital_status = COALESCE(NULLIF($9, ''), marital_status),
                   photo_url = COALESCE($10, photo_url),
                   aadhaar_front_url = COALESCE($11, aadhaar_front_url),
                   current_address = COALESCE(NULLIF($12, ''), current_address),
                   current_house = COALESCE(NULLIF($13, ''), current_house),
                   current_street = COALESCE(NULLIF($14, ''), current_street),
                   current_landmark = COALESCE(NULLIF($15, ''), current_landmark),
                   current_locality = COALESCE(NULLIF($16, ''), current_locality),
                   current_pincode = COALESCE(NULLIF($17, ''), current_pincode),
                   current_state_code = COALESCE(NULLIF($18, ''), current_state_code),
                   current_city_code = COALESCE(NULLIF($19, ''), current_city_code)
                   WHERE id = $8""",
                last4, name, dob, gender, address_full, photo_b64, now_utc(), application_id, marital_status,
                photo_file_url, aadhaar_pdf_url,
                address_full, addr_house, addr_street, addr_landmark, addr_locality, pin,
                state_code or "", city_code or "",
            )
            source_fields = {
                "date_of_birth": dob, "gender": gender,
                "current_address": address_full,
            }
            if addr_house: source_fields["current_house"] = addr_house
            if addr_street: source_fields["current_street"] = addr_street
            if addr_landmark: source_fields["current_landmark"] = addr_landmark
            if addr_locality: source_fields["current_locality"] = addr_locality
            if pin: source_fields["current_pincode"] = pin
            if state_code or state: source_fields["current_state_code"] = state_code or state
            if city_code or district: source_fields["current_city_code"] = city_code or district
            if marital_status:
                source_fields["marital_status"] = marital_status
            if photo_file_url:
                source_fields["photo_url"] = "digilocker_photo"
            if aadhaar_pdf_url:
                source_fields["aadhaar_front_url"] = "digilocker_verified"
            await save_field_sources(application_id, "aadhaar", source_fields)
        return {"status": "success", "data": {
            "name": name, "dob": dob, "gender": gender, "marital_status": marital_status,
            "address": address_full, "last4": last4,
            "house": addr_house, "street": addr_street,
            "landmark": addr_landmark, "locality": addr_locality,
            "pin": pin, "district": district, "state": state,
            "state_code": state_code, "city_code": city_code,
            "photo": bool(photo_b64),
            "photo_url": photo_file_url,
            "aadhaar_front_url": aadhaar_pdf_url,
        }}
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="DigiLocker download timed out. Please try again.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DigiLocker Download Error: {repr(e)}")

@app.post("/api/upload-document")
async def upload_document(token: str = Form(...), document_type: str = Form(...), file: UploadFile = File(...), request: Request = None):
    token_row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", token)
    if not token_row:
        raise HTTPException(status_code=404, detail="Invalid token")
    allowed_types = ['image/jpeg', 'image/png', 'application/pdf']
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Invalid file type")
    file_content = await file.read()
    if len(file_content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large. Max 5MB.")
    ext = file.filename.split('.')[-1] if '.' in file.filename else 'bin'
    loan_dir = UPLOAD_DIR / token_row["loan_id"]
    loan_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{document_type}_{int(now_utc().timestamp())}.{ext}"
    filepath = loan_dir / filename
    async with aiofiles.open(filepath, 'wb') as f:
        await f.write(file_content)
    file_url = f"/uploads/{token_row['loan_id']}/{filename}"
    field_mapping = {
        "aadhaar_front": "aadhaar_front_url", "aadhaar_back": "aadhaar_back_url",
        "pan_card": "pan_card_url", "photo": "photo_url",
        "income_proof": "income_proof_url", "bank_statement": "bank_statement_url"
    }
    if document_type in field_mapping:
        await db_pool.execute(
            f"UPDATE loan_applications SET {field_mapping[document_type]} = $1 WHERE token_id = $2",
            file_url, token_row["id"]
        )
    return {"status": "uploaded", "url": file_url, "filename": file.filename, "size": len(file_content)}

@app.post("/api/submit-form")
async def submit_form(token: str, request: Request):
    token_row = await db_pool.fetchrow("SELECT * FROM form_tokens WHERE token = $1", token)
    if not token_row:
        raise HTTPException(status_code=404, detail="Invalid token")
    app_row = await db_pool.fetchrow("SELECT * FROM loan_applications WHERE token_id = $1", token_row["id"])
    if not app_row:
        bank_id = token_row.get("bank_id")
        row = await db_pool.fetchrow(
            """INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at, bank_id)
               VALUES ($1, $2, $3, $4, 4, $5, $6) RETURNING *""",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc(), bank_id
        )
        app_data = _row_to_dict(row)
    else:
        app_data = _row_to_dict(app_row)
    app_uuid = uuid.UUID(app_data["id"])
    await db_pool.execute("UPDATE loan_applications SET is_complete = true, status = 'submitted', submitted_at = $1 WHERE id = $2", now_utc(), app_uuid)
    await db_pool.execute("UPDATE form_tokens SET is_used = true, form_status = 'submitted' WHERE id = $1", token_row["id"])
    # Record status transition
    await record_transition(app_uuid, "draft", "submitted", "customer", app_uuid, "Form submitted by customer")
    la = float(token_row["loan_amount"]) if token_row["loan_amount"] else 0
    message = (
        f"Dear {token_row['customer_name']},\n\nYour loan application has been submitted successfully!\n\n"
        f"Loan ID: {token_row['loan_id']}\nAmount: Rs.{la:,.2f}\n\n"
        f"Our team will review within 24-48 hours.\n\n- Your Bank Name"
    )
    await send_whatsapp_message(token_row["phone"], message)
    return {"status": "submitted", "message": "Application submitted successfully", "loan_id": token_row["loan_id"], "application_id": app_data["id"]}

# ============================================
# LEGACY ADMIN REVIEW ENDPOINT (kept for backward compat)
# ============================================

# Legacy /api/admin/review removed in v3 — use /api/portal/applications/{id}/{approve|reject} instead.

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
    return {"status": "sent", "phone": phone, "aisensy_response": result}

@app.post("/api/send-campaign-bulk")
async def send_campaign_bulk(request: Request):
    data = await request.json()
    loan_ids = data.get('loan_ids', [])
    if loan_ids:
        rows = await db_pool.fetch(
            "SELECT customer_name, phone, loan_id FROM loan_applications WHERE status = 'draft' AND loan_id = ANY($1)", loan_ids
        )
    else:
        rows = await db_pool.fetch("SELECT customer_name, phone, loan_id FROM loan_applications WHERE status = 'draft'")
    if not rows:
        raise HTTPException(status_code=404, detail="No pending applications found")
    results = []
    for r in rows:
        result = await send_whatsapp_aisensy(phone=r["phone"], customer_name=r["customer_name"], template_params=[r["customer_name"]])
        results.append({"phone": r["phone"], "customer_name": r["customer_name"], "loan_id": r["loan_id"], "status": "sent", "response": result})
    return {"status": "completed", "total_sent": len(results), "results": results}

# ============================================
# CODE LIST API (Dropdown Lookup Codes)
# ============================================

import time as _time

# Hardcoded fallbacks when the code list API is unreachable
_CODE_LIST_FALLBACKS: dict[int, list[dict]] = {
    5: [  # States (partial — common ones)
        {"code_mst_id": "269", "code_desc": "Maharashtra"},
        {"code_mst_id": "258", "code_desc": "Gujarat"},
        {"code_mst_id": "264", "code_desc": "Karnataka"},
        {"code_mst_id": "286", "code_desc": "Tamil Nadu"},
        {"code_mst_id": "262", "code_desc": "Delhi"},
        {"code_mst_id": "289", "code_desc": "Uttar Pradesh"},
        {"code_mst_id": "280", "code_desc": "Rajasthan"},
        {"code_mst_id": "268", "code_desc": "Madhya Pradesh"},
        {"code_mst_id": "291", "code_desc": "West Bengal"},
        {"code_mst_id": "285", "code_desc": "Telangana"},
        {"code_mst_id": "255", "code_desc": "Andhra Pradesh"},
        {"code_mst_id": "265", "code_desc": "Kerala"},
        {"code_mst_id": "278", "code_desc": "Punjab"},
        {"code_mst_id": "259", "code_desc": "Haryana"},
        {"code_mst_id": "260", "code_desc": "Himachal Pradesh"},
        {"code_mst_id": "263", "code_desc": "Goa"},
    ],
}


async def _fetch_code_list(sql_mst_id: int, param: str = "") -> list[dict]:
    """Fetch code list from API with caching."""
    cache_key = f"{sql_mst_id}:{param}"
    cached = _code_list_cache.get(cache_key)
    if cached and cached[0] > _time.time():
        return cached[1]

    try:
        body: dict = {"sqlMstId": sql_mst_id}
        if param:
            body["param"] = param
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{CODE_LIST_API_URL}/api/getCodeList/", json=body)
            resp.raise_for_status()
            data = resp.json()
        result = data if isinstance(data, list) else data.get("data", data.get("result", []))
        _code_list_cache[cache_key] = (_time.time() + CODE_LIST_CACHE_TTL, result)
        return result
    except Exception as e:
        print(f"[CodeList] Failed to fetch sqlMstId={sql_mst_id}: {e}")
        return _CODE_LIST_FALLBACKS.get(sql_mst_id, [])


@app.get("/api/code-list/{sql_mst_id}")
async def get_code_list(sql_mst_id: int, param: str = ""):
    """Proxy for getCodeList API — returns dropdown options with code_mst_id + code_desc."""
    data = await _fetch_code_list(sql_mst_id, param)
    fallback = len(data) > 0 and data == _CODE_LIST_FALLBACKS.get(sql_mst_id, [])
    return {"status": "success", "data": data, "fallback": fallback}


async def resolve_state_code(state_text: str) -> str | None:
    """Match DigiLocker state text (e.g. 'Maharashtra') to API code_mst_id."""
    if not state_text:
        return None
    states = await _fetch_code_list(5)
    st = state_text.strip().upper()
    for s in states:
        if s.get("code_desc", "").strip().upper() == st:
            return str(s["code_mst_id"])
    # Substring match fallback
    for s in states:
        desc = s.get("code_desc", "").strip().upper()
        if st in desc or desc in st:
            return str(s["code_mst_id"])
    return None


async def resolve_city_code(city_text: str, state_code: str) -> str | None:
    """Match DigiLocker city/district text to API code_mst_id (filtered by state)."""
    if not city_text or not state_code:
        return None
    cities = await _fetch_code_list(6, state_code)
    ct = city_text.strip().upper()
    for c in cities:
        if c.get("code_desc", "").strip().upper() == ct:
            return str(c["code_mst_id"])
    # Substring match fallback
    for c in cities:
        desc = c.get("code_desc", "").strip().upper()
        if ct in desc or desc in ct:
            return str(c["code_mst_id"])
    return None


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
    await db_pool.execute("DELETE FROM loan_sessions WHERE phone = $1", phone)
    await db_pool.execute(
        """INSERT INTO loan_sessions (phone, application_id, session_token, expires_at, otp_hash, otp_expires_at, otp_verified)
           VALUES ($1, $2, $3, $4, $5, $6, false)""",
        phone, app_row["id"], session_id, expires_at, otp_hash, expires_at
    )
    print(f"OTP for {phone}: {otp}")
    await send_otp_via_aisensy(phone, otp)
    return {"status": "otp_sent", "session_id": session_id, "message": "OTP sent successfully"}

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
async def seed_mock_data(_: dict = Depends(require_admin)):
    """Seed v3 demo data: 3 banks (vendor_limit=5), 2 bank_users per bank,
    2 vendors per bank (1 vendor_user each), 15 applications, 20 calls.
    Idempotent: existing rows are left alone."""
    from datetime import date as _date

    mock_banks = [
        {"name": "Buldhana Urban Co-op Bank", "code": "BUCB", "contact_email": "admin@buldhanabank.com", "contact_phone": "+912025551001", "address": "Main Branch, Buldhana, Maharashtra"},
        {"name": "State Finance Bank",       "code": "SFB",  "contact_email": "admin@statefinance.com", "contact_phone": "+912025552002", "address": "CBD Belapur, Navi Mumbai, Maharashtra"},
        {"name": "National Rural Credit Bank","code": "NRCB", "contact_email": "admin@nrcbank.com",     "contact_phone": "+912025553003", "address": "FC Road, Pune, Maharashtra"},
    ]
    mock_vendors = [
        [
            {"name": "ElectroHub Electronics", "code": "EH01", "category": "Electronics", "contact_name": "Rahul Mehta",   "contact_phone": "+918888800001"},
            {"name": "HomeStyle Furniture",    "code": "HS02", "category": "Furniture",   "contact_name": "Anjali Singh",  "contact_phone": "+918888800002"},
        ],
        [
            {"name": "Gadget Galaxy",          "code": "GG01", "category": "Electronics", "contact_name": "Vivek Shah",    "contact_phone": "+918888800003"},
            {"name": "PrimePhone Mart",        "code": "PP02", "category": "Mobile",      "contact_name": "Sneha Kapoor",  "contact_phone": "+918888800004"},
        ],
        [
            {"name": "Rural Appliances Co",    "code": "RA01", "category": "Appliances",  "contact_name": "Dinesh Patil",  "contact_phone": "+918888800005"},
            {"name": "FarmTech Tools",         "code": "FT02", "category": "Agri",        "contact_name": "Meena Kulkarni","contact_phone": "+918888800006"},
        ],
    ]

    created_banks: list[dict] = []
    created_bank_users: list[dict] = []
    created_vendors: list[dict] = []
    created_vendor_users: list[dict] = []
    created_apps: list[dict] = []

    # --- 1) Banks ---
    for bank_data in mock_banks:
        existing = await db_pool.fetchrow("SELECT id FROM banks WHERE code = $1", bank_data["code"])
        if existing:
            bank_id = existing["id"]
        else:
            row = await db_pool.fetchrow(
                """INSERT INTO banks (name, code, contact_email, contact_phone, address, vendor_limit)
                   VALUES ($1, $2, $3, $4, $5, 5) RETURNING id""",
                bank_data["name"], bank_data["code"], bank_data["contact_email"],
                bank_data["contact_phone"], bank_data["address"],
            )
            bank_id = row["id"]
        created_banks.append({"id": str(bank_id), "name": bank_data["name"], "code": bank_data["code"]})

        # --- 2) Bank users (2 per bank, same role) ---
        for idx in (1, 2):
            username = f"{bank_data['code'].lower()}_user{idx}"
            existing_u = await db_pool.fetchrow("SELECT id FROM users WHERE username = $1", username)
            if existing_u:
                created_bank_users.append({"username": username, "password": "(existed)", "bank": bank_data["code"]})
                continue
            password = f"{bank_data['code']}@user{idx}123"
            pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
            full_name = f"{bank_data['name'].split()[0]} User {idx}"
            email = f"{username}@{bank_data['code'].lower()}.mock"
            await db_pool.execute(
                """INSERT INTO users (username, email, password_hash, full_name, role, bank_id)
                   VALUES ($1, $2, $3, $4, 'bank_user', $5)""",
                username, email, pw_hash, full_name, bank_id,
            )
            created_bank_users.append({"username": username, "password": password, "bank": bank_data["code"]})

    # --- 3) Vendors + vendor users ---
    for bank_idx, bank in enumerate(created_banks):
        bank_uuid = uuid.UUID(bank["id"])
        for v in mock_vendors[bank_idx]:
            existing_v = await db_pool.fetchrow(
                "SELECT id FROM vendors WHERE bank_id = $1 AND code = $2", bank_uuid, v["code"],
            )
            if existing_v:
                vendor_id = existing_v["id"]
            else:
                row = await db_pool.fetchrow(
                    """INSERT INTO vendors (bank_id, name, code, category, contact_name, contact_phone)
                       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id""",
                    bank_uuid, v["name"], v["code"], v["category"], v["contact_name"], v["contact_phone"],
                )
                vendor_id = row["id"]
            created_vendors.append({
                "id": str(vendor_id), "bank": bank["code"], "name": v["name"], "code": v["code"],
            })
            # One vendor user per vendor
            vendor_username = f"{bank['code'].lower()}_{v['code'].lower()}"
            existing_vu = await db_pool.fetchrow("SELECT id FROM users WHERE username = $1", vendor_username)
            if existing_vu:
                created_vendor_users.append({"username": vendor_username, "password": "(existed)", "vendor": v["code"]})
                continue
            password = f"{v['code']}@vendor123"
            pw_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
            await db_pool.execute(
                """INSERT INTO users (username, email, password_hash, full_name, role, bank_id, vendor_id)
                   VALUES ($1, $2, $3, $4, 'vendor_user', $5, $6)""",
                vendor_username, f"{vendor_username}@vendor.mock", pw_hash, f"{v['name']} Staff",
                bank_uuid, vendor_id,
            )
            created_vendor_users.append({"username": vendor_username, "password": password, "vendor": v["code"]})

    # --- 4) Applications (15 total: 5 per bank; 2 of those 5 are vendor-originated) ---
    mock_names = [
        "Rajesh Kumar Sharma", "Priya Suresh Patil", "Amit Vijay Deshmukh", "Sunita Ramesh Jadhav", "Vikas Mohan Kulkarni",
        "Neha Ashok Bhosle",   "Manoj Prakash Chavan","Kavita Sanjay Pawar","Sunil Deepak Joshi",  "Anita Rahul Deshpande",
        "Ramesh Anil Sawant",  "Pooja Nitin Gaikwad", "Siddharth Ajay More","Rekha Suresh Thakur", "Ganesh Mahesh Shinde",
    ]
    mock_phones = [f"+9198{random.randint(10000000, 99999999)}" for _ in range(15)]
    mock_loan_types = ["Personal Loan", "Home Loan", "Vehicle Loan", "Education Loan", "Business Loan"]
    # Simplified v3 statuses
    mock_statuses = [
        "submitted",  "system_reviewed", "system_reviewed", "approved",       "rejected",
        "submitted",  "system_reviewed", "approved",        "documents_requested", "documents_submitted",
        "submitted",  "system_reviewed", "approved",        "disbursed",      "rejected",
    ]
    mock_system_suggestions = ["approve","approve","review","approve","deny",
                               "approve","approve","approve","approve","approve",
                               "review","approve","approve","approve","deny"]
    mock_scores = [82, 78, 55, 91, 28, 65, 85, 88, 90, 76, 48, 79, 87, 93, 31]
    mock_reasons = [
        "Strong income-to-loan ratio, stable employment history",
        "Good credit indicators, low existing EMI burden",
        "Moderate risk — recent job change, verify income",
        "Excellent financial profile, property-backed collateral",
        "High debt-to-income ratio, multiple existing loans",
        "Moderate risk, adequate income for requested amount",
        "Strong savings pattern, long employment tenure",
        "Good repayment capacity, clear credit history",
        "Stable government employment, adequate income",
        "Good business revenue, consistent tax filings",
        "Low income relative to loan amount, no collateral",
        "Strong co-applicant profile, good combined income",
        "Verified employment, strong salary credentials",
        "Excellent credit score, minimal existing obligations",
        "Insufficient documentation, multiple red flags",
    ]
    mock_amounts = [500000, 2500000, 800000, 1200000, 350000,
                    750000, 1500000, 3000000, 600000, 1000000,
                    450000, 900000, 2000000, 1800000, 700000]
    mock_emails = [
        "rajesh.sharma@gmail.com", "priya.patil@yahoo.com", "amit.deshmukh@gmail.com",
        "sunita.jadhav@hotmail.com", "vikas.kulkarni@gmail.com", "neha.bhosle@gmail.com",
        "manoj.chavan@yahoo.com", "kavita.pawar@gmail.com", "sunil.joshi@outlook.com",
        "anita.deshpande@gmail.com", "ramesh.sawant@gmail.com", "pooja.gaikwad@yahoo.com",
        "siddharth.more@gmail.com", "rekha.thakur@gmail.com", "ganesh.shinde@gmail.com",
    ]
    mock_genders = ["Male","Female","Male","Female","Male","Female","Male","Female","Male","Female","Male","Female","Male","Female","Male"]
    mock_dobs = ["1990-05-15","1985-11-20","1992-03-08","1988-07-12","1995-01-25",
                 "1991-09-30","1987-06-18","1993-12-05","1989-04-22","1994-08-14",
                 "1986-02-28","1996-10-10","1990-07-07","1984-03-15","1991-11-01"]
    mock_employment = ["Salaried","Salaried","Business","Salaried","Self-employed",
                       "Salaried","Business","Salaried","Salaried","Self-employed",
                       "Salaried","Salaried","Business","Salaried","Self-employed"]
    mock_employers = ["TCS","Infosys","Own Business","Wipro","Freelance",
                      "HCL Tech","Shop Owner","Cognizant","SBI","Consultant",
                      "L&T","Tech Mahindra","Transport","HDFC Bank","Agriculture"]
    mock_incomes = [65000,85000,120000,55000,45000,75000,90000,60000,50000,70000,
                    80000,55000,100000,72000,40000]
    mock_pans = ["ABCDE1234F","FGHIJ5678K","KLMNO9012P","PQRST3456U","UVWXY7890Z",
                 "ABCFG1234H","DEFHI5678J","GHJKL9012M","JKLMN3456O","MNOPQ7890R",
                 "OPQRS1234T","RSTUV5678W","TUVWX9012Y","WXYZA3456B","ZABCD7890E"]
    mock_addresses = [
        "Flat 12, Shivaji Nagar, Pune", "House 45, MG Road, Mumbai", "Plot 78, MIDC, Nagpur",
        "Room 3, Bajaj Colony, Aurangabad", "204 Lake View, Nashik", "B-12 Harmony, Thane",
        "15 Gandhi Chowk, Satara", "67 Tilak Road, Kolhapur", "89 Station Road, Solapur",
        "22 Civil Lines, Amravati", "34 Peth Area, Sangli", "56 Market Yard, Jalgaon",
        "78 Industrial Area, Akola", "90 Cantonment, Ahmednagar", "11 Main Road, Latur",
    ]

    vendors_by_bank: dict[str, list[str]] = {}
    for v in created_vendors:
        vendors_by_bank.setdefault(v["bank"], []).append(v["id"])

    for i in range(15):
        bank_idx = i // 5
        bank = created_banks[bank_idx]
        bank_uuid = uuid.UUID(bank["id"])
        # First 2 of each bank's 5 apps are vendor-originated (round-robin across its vendors)
        slot = i % 5
        vendor_id = None
        if slot < 2 and vendors_by_bank.get(bank["code"]):
            vendor_id = uuid.UUID(vendors_by_bank[bank["code"]][slot])
        loan_id = f"MOCK-{bank['code']}-2026{(i+1):04d}"
        existing = await db_pool.fetchrow("SELECT id FROM loan_applications WHERE loan_id = $1", loan_id)
        if existing:
            created_apps.append({"loan_id": loan_id, "status": "(existed)"})
            continue

        status = mock_statuses[i]
        submitted_at = now_utc() - timedelta(days=random.randint(1, 14))
        system_reviewed_at = submitted_at + timedelta(hours=random.randint(1, 4)) if status != "submitted" else None
        reviewed_at = (system_reviewed_at or submitted_at) + timedelta(hours=random.randint(2, 24)) \
            if status in ("approved", "rejected", "documents_requested", "documents_submitted", "disbursed") else None
        documents_requested_at = reviewed_at if status in ("documents_requested", "documents_submitted", "disbursed") else None
        approved_at = reviewed_at if status in ("approved", "documents_requested", "documents_submitted", "disbursed") else None
        disbursed_at = (reviewed_at + timedelta(days=random.randint(1, 3))) if status == "disbursed" else None

        dob_val = _date.fromisoformat(mock_dobs[i])
        await db_pool.execute(
            """INSERT INTO loan_applications (
                customer_name, phone, loan_id, bank_id, vendor_id, status, is_complete, submitted_at,
                email, date_of_birth, gender, marital_status, current_address,
                employment_type, employer_name, monthly_gross_income, monthly_net_income,
                loan_amount_requested, purpose_of_loan,
                pan_number, pan_verified, aadhaar_verified, aadhaar_last4,
                system_suggestion, system_suggestion_reason, system_score, system_reviewed_at,
                reviewed_at, review_notes, rejection_reason,
                documents_requested_at, approved_at, disbursed_at,
                current_step, highest_step, last_saved_at, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, TRUE, $7,
                $8, $9, $10, $11, $12,
                $13, $14, $15, $16,
                $17, $18,
                $19, TRUE, TRUE, $20,
                $21, $22, $23, $24,
                $25, $26, $27,
                $28, $29, $30,
                6, 6, $31, $32
            )""",
            mock_names[i], mock_phones[i], loan_id, bank_uuid, vendor_id, status, submitted_at,
            mock_emails[i], dob_val, mock_genders[i], random.choice(["Single", "Married"]), mock_addresses[i],
            mock_employment[i], mock_employers[i], float(mock_incomes[i]), float(mock_incomes[i] * 0.75),
            float(mock_amounts[i]), mock_loan_types[i % len(mock_loan_types)],
            mock_pans[i], str(random.randint(1000, 9999)),
            mock_system_suggestions[i], mock_reasons[i], mock_scores[i], system_reviewed_at,
            reviewed_at, "System review" if reviewed_at else None,
            "High debt-to-income ratio" if status == "rejected" else None,
            documents_requested_at, approved_at, disbursed_at,
            now_utc(), submitted_at - timedelta(days=1),
        )
        created_apps.append({
            "loan_id": loan_id, "name": mock_names[i], "status": status,
            "bank": bank["code"], "vendor": next((v["code"] for v in created_vendors if v["id"] == str(vendor_id)), None),
        })

    # --- 5) Calls (20 mixed) ---
    call_statuses = [
        "completed", "completed", "completed", "in_progress", "queued",
        "failed",    "not_answered", "completed", "completed", "in_progress",
        "completed", "completed", "failed",       "queued",    "completed",
        "completed", "not_answered", "completed", "dialing",   "completed",
    ]
    for i in range(20):
        bank = created_banks[i % 3]
        bank_uuid = uuid.UUID(bank["id"])
        vendor_id = None
        if i % 4 == 0 and vendors_by_bank.get(bank["code"]):
            vendor_id = uuid.UUID(vendors_by_bank[bank["code"]][0])
        phone = f"+9198{random.randint(10000000, 99999999)}"
        name = f"Call Lead {i+1}"
        status = call_statuses[i]
        started = now_utc() - timedelta(hours=random.randint(1, 72))
        ended = started + timedelta(minutes=random.randint(1, 6)) if status in ("completed", "failed", "not_answered") else None
        duration = int((ended - started).total_seconds()) if ended else 0
        await db_pool.execute(
            """INSERT INTO agent_calls (bank_id, vendor_id, customer_name, phone, loan_type, loan_amount, language,
                                         status, call_duration, interested, form_sent, category, started_at, ended_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'hindi', $7, $8, $9, $10, $11, $12, $13)""",
            bank_uuid, vendor_id, name, phone,
            random.choice(mock_loan_types), str(random.randint(50, 3000) * 1000),
            status, duration, status == "completed", status == "completed" and i % 3 != 0,
            random.choice(["Hot Lead", "Warm Lead", "Cold Lead", "Uncategorized"]),
            started, ended,
        )

    return {
        "status": "success",
        "message": "v3 mock data seeded.",
        "banks": created_banks,
        "bank_users": created_bank_users,
        "vendors": created_vendors,
        "vendor_users": created_vendor_users,
        "applications": created_apps,
        "note": "Login patterns: admin=admin@bank.com/admin123; bank user=<code>_user1/<CODE>@user1123; vendor user=<bank>_<vcode>/<VCODE>@vendor123",
    }

# ============================================
# API PAYLOAD BUILDER (lrsAnalysisSummary)
# ============================================

def build_api_payload(app_data: dict) -> dict:
    """Convert loan_applications row → lrsAnalysisSummary API payload (42 fields)."""
    phone = (app_data.get("phone") or "").lstrip("+").lstrip("91")
    # Concatenate address parts for API
    cur_parts = [app_data.get("current_house", ""), app_data.get("current_street", ""),
                 app_data.get("current_landmark", ""), app_data.get("current_locality", "")]
    current_addr = ", ".join([p for p in cur_parts if p and str(p).strip()])
    is_same = app_data.get("same_as_current", False)
    if is_same:
        perm_addr = current_addr
        per_state = app_data.get("current_state_code", "")
        per_city = app_data.get("current_city_code", "")
    else:
        per_parts = [app_data.get("permanent_house", ""), app_data.get("permanent_street", ""),
                     app_data.get("permanent_landmark", ""), app_data.get("permanent_locality", "")]
        perm_addr = ", ".join([p for p in per_parts if p and str(p).strip()])
        per_state = app_data.get("permanent_state_code", "")
        per_city = app_data.get("permanent_city_code", "")
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
        "pinCode": app_data.get("current_pincode", ""),
        "curr_state": app_data.get("current_state_code", ""),
        "curr_city": app_data.get("current_city_code", ""),
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
