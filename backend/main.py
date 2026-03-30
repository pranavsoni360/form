# main.py - FastAPI Backend for Bank Loan Form System (asyncpg version)
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
    description="Production-grade loan form system with OTP verification",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "https://virtualvaani.vgipl.com:3001",
        "http://virtualvaani.vgipl.com:3001",
        "https://virtualvaani.vgipl.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://los_admin:password@localhost:5434/los_form")
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

db_pool: asyncpg.Pool = None
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
    return d

def _rows_to_list(rows):
    return [_row_to_dict(r) for r in rows]

# ============================================
# STARTUP / SHUTDOWN
# ============================================

@app.on_event("startup")
async def startup():
    global db_pool
    db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)

@app.on_event("shutdown")
async def shutdown():
    global db_pool
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

class ReviewAction(BaseModel):
    application_id: str
    action: str
    notes: Optional[str] = None
    rejection_reason: Optional[str] = None

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

    phone_formatted = phone.replace('+', '')
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

async def send_whatsapp_aisensy(phone: str, customer_name: str, template_params: list = None):
    if not AISENSY_API_KEY:
        print(f"[AiSensy STUB] Would send to {phone}")
        return {"status": "simulated"}
    phone_formatted = phone.replace('+', '').replace(' ', '')
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
    "aadhaar_front_url", "aadhaar_back_url", "pan_card_url",
    "photo_url", "income_proof_url", "bank_statement_url",
    "current_address", "permanent_address", "customer_type",
    "title", "first_name", "middle_name", "last_name", "full_name",
    "qualification", "occupation", "industry_type",
    "total_work_experience", "experience_current_org",
    "residential_status", "tenure_stability", "employer_address",
    "loan_amount_requested", "repayment_period_years", "purpose_of_loan", "scheme",
    "monthly_gross_income", "monthly_deductions", "monthly_emi_existing", "monthly_net_income",
    "criminal_records", "same_as_current", "highest_step",
}

# ============================================
# API ENDPOINTS
# ============================================

@app.get("/")
async def root():
    return {"status": "running", "service": "Bank Loan Form API", "version": "1.0.0"}

@app.post("/api/generate-form-links")
async def generate_form_links(customers: List[CustomerData], request: Request):
    results = []
    for customer in customers:
        try:
            token = generate_secure_token()
            expires_at = now_utc() + timedelta(days=7)
            row = await db_pool.fetchrow(
                """INSERT INTO form_tokens (token, customer_name, phone, loan_id, loan_amount, loan_type, email, date_of_birth, address, expires_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id""",
                token, customer.customer_name, customer.phone, customer.loan_id,
                float(customer.loan_amount), customer.loan_type, customer.email,
                customer.date_of_birth, customer.address, expires_at
            )
            token_id = str(row["id"])
            form_url = f"{FORM_BASE_URL}/form/{token}"
            message = (
                f"Dear {customer.customer_name},\n\n"
                f"Complete your loan application for {customer.loan_type}.\n\n"
                f"Loan ID: {customer.loan_id}\nAmount: Rs.{customer.loan_amount:,.2f}\n\n"
                f"Click to fill the form:\n{form_url}\n\nValid for 7 days. Do not share this link.\n\n- Your Bank Name"
            )
            await send_whatsapp_message(customer.phone, message, token_id)
            results.append({"phone": customer.phone, "loan_id": customer.loan_id, "status": "success", "token": token, "form_url": form_url})
        except Exception as e:
            results.append({"phone": customer.phone, "status": "failed", "reason": str(e)})
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
    print(f"DEBUG OTP for {row['phone']}: {otp}")
    message = f"Your loan application OTP: {otp}\n\nValid for 10 minutes.\nDo not share this OTP.\n\n- Your Bank"
    await send_whatsapp_message(row["phone"], message)
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
        row = await db_pool.fetchrow(
            """INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id""",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], payload.step, now_utc()
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
        await db_pool.execute(
            "INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at) VALUES ($1, $2, $3, $4, 1, $5)",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc()
        )
    await db_pool.execute(
        "UPDATE loan_applications SET pan_number = $1, pan_verified = true, pan_verification_timestamp = $2 WHERE token_id = $3",
        pan_number, now_utc(), token_row["id"]
    )
    return {"status": "verified", "message": "PAN verified successfully"}

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
        await db_pool.execute(
            "INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at) VALUES ($1, $2, $3, $4, 1, $5)",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc()
        )
    await db_pool.execute(
        "UPDATE loan_applications SET aadhaar_last4 = $1, aadhaar_number_encrypted = $2, aadhaar_verified = true, aadhaar_verification_timestamp = $3 WHERE token_id = $4",
        last4, aadhaar_number, now_utc(), token_row["id"]
    )
    return {"status": "verified", "message": "Aadhaar verified successfully", "last4": last4}

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
        row = await db_pool.fetchrow(
            """INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at)
               VALUES ($1, $2, $3, $4, 4, $5) RETURNING *""",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc()
        )
        app_data = _row_to_dict(row)
    else:
        app_data = _row_to_dict(app_row)
    await db_pool.execute("UPDATE loan_applications SET is_complete = true, status = 'submitted', submitted_at = $1 WHERE id = $2", now_utc(), uuid.UUID(app_data["id"]))
    await db_pool.execute("UPDATE form_tokens SET is_used = true, form_status = 'submitted' WHERE id = $1", token_row["id"])
    la = float(token_row["loan_amount"]) if token_row["loan_amount"] else 0
    message = (
        f"Dear {token_row['customer_name']},\n\nYour loan application has been submitted successfully!\n\n"
        f"Loan ID: {token_row['loan_id']}\nAmount: Rs.{la:,.2f}\n\n"
        f"Our team will review within 24-48 hours.\n\n- Your Bank Name"
    )
    await send_whatsapp_message(token_row["phone"], message)
    return {"status": "submitted", "message": "Application submitted successfully", "loan_id": token_row["loan_id"], "application_id": app_data["id"]}

@app.post("/api/admin/login")
async def admin_login(payload: AdminLogin):
    row = await db_pool.fetchrow("SELECT * FROM admin_users WHERE email = $1", payload.email)
    if not row:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not bcrypt.checkpw(payload.password.encode('utf-8'), row["password_hash"].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="Account deactivated")
    token = jwt.encode({"user_id": str(row["id"]), "email": row["email"], "role": row["role"], "exp": now_utc() + timedelta(days=7)}, JWT_SECRET, algorithm="HS256")
    await db_pool.execute("UPDATE admin_users SET last_login_at = $1 WHERE id = $2", now_utc(), row["id"])
    return {"token": token, "user": {"id": str(row["id"]), "email": row["email"], "name": row["full_name"], "role": row["role"]}}

@app.get("/api/admin/applications")
async def get_applications(status: Optional[str] = None, credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if status:
        rows = await db_pool.fetch("SELECT * FROM loan_applications WHERE status = $1 ORDER BY created_at DESC", status)
    else:
        rows = await db_pool.fetch("SELECT * FROM loan_applications ORDER BY created_at DESC")
    return {"applications": _rows_to_list(rows)}

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
    if payload.action == "approve":
        message = f"Congratulations {app_row['customer_name']}!\n\nYour loan application has been APPROVED.\n\nLoan ID: {app_row['loan_id']}\n\nOur team will contact you within 24 hours.\n\n- Your Bank Name"
    else:
        message = f"Dear {app_row['customer_name']},\n\nYour loan application has been reviewed.\n\nLoan ID: {app_row['loan_id']}\nStatus: Not Approved\n\nReason: {payload.rejection_reason or 'Contact customer service'}\n\n- Your Bank Name"
    await send_whatsapp_message(app_row["phone"], message)
    return {"status": "success", "message": f"Application {payload.action}d successfully"}

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
# PHONE-BASED AUTHENTICATION
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
        # Check form_tokens — admin may have created a token for this phone
        token_row = await db_pool.fetchrow(
            "SELECT * FROM form_tokens WHERE phone = $1 ORDER BY created_at DESC LIMIT 1", phone
        )
        if not token_row:
            raise HTTPException(status_code=404, detail="No loan application found for this number. Please contact your bank.")
        # Create the application row from token data
        app_row = await db_pool.fetchrow(
            """INSERT INTO loan_applications (token_id, customer_name, phone, loan_id, current_step, last_saved_at)
               VALUES ($1, $2, $3, $4, 1, $5) RETURNING *""",
            token_row["id"], token_row["customer_name"], token_row["phone"], token_row["loan_id"], now_utc()
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
    print(f"\n{'='*50}\nOTP for {phone}: {otp}\nCustomer: {app_row['customer_name']}\nLoan ID: {app_row['loan_id']}\nValid for 10 minutes\n{'='*50}\n")
    if WHATSAPP_API_TOKEN and WHATSAPP_PHONE_ID:
        message = f"Your loan application OTP: *{otp}*\n\nValid for 10 minutes.\nDo not share this OTP.\n\n- Your Bank"
        await send_whatsapp_message(phone, message)
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
    if safe_data:
        sets = ", ".join(f"{k} = ${i+1}" for i, k in enumerate(safe_data.keys()))
        vals = list(safe_data.values())
        vals.extend([step, now_utc(), session["application_id"]])
        n = len(safe_data)
        await db_pool.execute(
            f"UPDATE loan_applications SET {sets}, current_step = ${n+1}, last_saved_at = ${n+2} WHERE id = ${n+3}", *vals
        )
    else:
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
    await db_pool.execute(
        "UPDATE loan_applications SET pan_number = $1, pan_verified = true, pan_verification_timestamp = $2 WHERE id = $3",
        pan_number, now_utc(), session["application_id"]
    )
    return {"status": "verified", "message": "PAN verified successfully"}


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
    if WHATSAPP_API_TOKEN and WHATSAPP_PHONE_ID:
        message = f"Dear {app_row['customer_name']},\n\nYour loan application has been submitted!\n\nLoan ID: {app_row['loan_id']}\n\nOur team will review within 24-48 hours.\n\n- Your Bank"
        await send_whatsapp_message(app_row["phone"], message)
    return {"status": "submitted", "message": "Application submitted successfully", "loan_id": app_row["loan_id"]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8200)
