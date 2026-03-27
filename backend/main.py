# main.py - FastAPI Backend for Bank Loan Form System
from fastapi import FastAPI, HTTPException, Depends, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional, List
from datetime import datetime, timedelta, timezone
import secrets
import bcrypt
import re
from supabase import create_client, Client
import os
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
    allow_origins=["http://localhost:3000", "https://yourdomain.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

supabase: Client = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_KEY")
)

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
        print(f"WhatsApp not configured. Would send to {phone}: {message}")
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
            print(f"WhatsApp send error: {str(e)}")
            return {"status": "failed", "error": str(e)}


async def send_whatsapp_aisensy(phone: str, customer_name: str, template_params: list = None):
    """Send WhatsApp message via AiSensy campaign API"""
    if not AISENSY_API_KEY:
        print(f"AiSensy not configured. Would send to {phone}")
        return {"status": "simulated"}

    phone_formatted = phone.replace('+', '').replace(' ', '')

    payload = {
        "apiKey": AISENSY_API_KEY,
        "campaignName": AISENSY_CAMPAIGN_NAME,
        "destination": phone_formatted,
        "userName": AISENSY_USERNAME,
        "templateParams": template_params or [customer_name],
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
            response = await client.post(
                "https://backend.aisensy.com/campaign/t1/api/v2",
                json=payload
            )
            print(f"AiSensy Status: {response.status_code}")
            print(f"AiSensy Response: {response.text}")
            return response.json() if response.text else {"status": "sent"}
        except Exception as e:
            print(f"AiSensy error: {str(e)}")
            return {"status": "failed", "error": str(e)}

# ============================================
# API ENDPOINTS
# ============================================

@app.get("/")
async def root():
    return {
        "status": "running",
        "service": "Bank Loan Form API",
        "version": "1.0.0"
    }

@app.post("/api/generate-form-links")
async def generate_form_links(customers: List[CustomerData], request: Request):
    results = []

    for customer in customers:
        try:
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
                "phone": customer.phone,
                "loan_id": customer.loan_id,
                "status": "success",
                "token": token,
                "form_url": form_url
            })

        except Exception as e:
            results.append({
                "phone": customer.phone,
                "status": "failed",
                "reason": str(e)
            })

    return {"results": results}


@app.get("/api/validate-token/{token}")
async def validate_token(token: str, request: Request):
    result = supabase.table("form_tokens").select("*").eq("token", token).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Invalid or expired link")

    token_data = result.data[0]

    expires_at = datetime.fromisoformat(token_data["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at < now_utc():
        raise HTTPException(status_code=410, detail="Link has expired")

    supabase.table("form_tokens").update({
        "last_accessed_at": now_utc().isoformat(),
        "access_count": token_data["access_count"] + 1
    }).eq("id", token_data["id"]).execute()

    if not token_data["otp_verified"]:
        return {
            "status": "otp_required",
            "phone": token_data["phone"][-4:],
            "token_id": token_data["id"]
        }

    return {
        "status": "valid",
        "data": {
            "customer_name": token_data["customer_name"],
            "phone": token_data["phone"],
            "loan_id": token_data["loan_id"],
            "loan_amount": token_data.get("loan_amount"),
            "loan_type": token_data.get("loan_type"),
            "email": token_data.get("email"),
            "date_of_birth": str(token_data["date_of_birth"]) if token_data.get("date_of_birth") else None,
            "customer_type": token_data.get("customer_type", "new"),
            "current_address": token_data.get("current_address"),
            "permanent_address": token_data.get("permanent_address"),
        },
        "form_status": token_data["form_status"],
        "current_step": 1
    }


@app.post("/api/send-otp")
async def send_otp(token: str, request: Request):
    result = supabase.table("form_tokens").select("*").eq("token", token).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Invalid token")

    token_data = result.data[0]

    if token_data["otp_verified"]:
        raise HTTPException(status_code=400, detail="OTP already verified")

    print(f"Sending OTP to registered number: {token_data['phone']}")

    otp = generate_otp()
    otp_hash = hash_otp(otp)
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
    token_result = supabase.table("form_tokens").select("*").eq("token", payload.token).execute()

    if not token_result.data:
        raise HTTPException(status_code=404, detail="Invalid token")

    token_data = token_result.data[0]

    if token_data["otp_verified"]:
        return {"status": "already_verified", "message": "OTP already verified"}

    otp_result = supabase.table("otp_verifications") \
        .select("*") \
        .eq("token_id", token_data["id"]) \
        .eq("verified", False) \
        .order("created_at", desc=True) \
        .limit(1) \
        .execute()

    if not otp_result.data:
        raise HTTPException(status_code=404, detail="No OTP found. Request a new one.")

    otp_data = otp_result.data[0]

    expires_at = datetime.fromisoformat(otp_data["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at < now_utc():
        raise HTTPException(status_code=410, detail="OTP expired. Request a new one.")

    if otp_data["attempt_count"] >= otp_data["max_attempts"]:
        raise HTTPException(status_code=429, detail="Too many incorrect attempts.")

    if not verify_otp(payload.otp, otp_data["otp_hash"]):
        supabase.table("otp_verifications").update({
            "attempt_count": otp_data["attempt_count"] + 1
        }).eq("id", otp_data["id"]).execute()
        raise HTTPException(status_code=400, detail="Incorrect OTP. Try again.")

    supabase.table("otp_verifications").update({
        "verified": True,
        "verified_at": now_utc().isoformat()
    }).eq("id", otp_data["id"]).execute()

    supabase.table("form_tokens").update({
        "otp_verified": True,
        "otp_verified_at": now_utc().isoformat()
    }).eq("id", token_data["id"]).execute()

    return {
        "status": "verified",
        "message": "OTP verified successfully"
    }


@app.post("/api/autosave")
async def autosave_form(payload: FormStepData, request: Request):
    token_result = supabase.table("form_tokens").select("*").eq("token", payload.token).execute()

    if not token_result.data:
        raise HTTPException(status_code=404, detail="Invalid token")

    token_data = token_result.data[0]

    if not token_data["otp_verified"]:
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
async def review_application(
    payload: ReviewAction,
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    try:
        admin_payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    app_result = supabase.table("loan_applications").select("*").eq("id", payload.application_id).execute()

    if not app_result.data:
        raise HTTPException(status_code=404, detail="Application not found")

    app_data = app_result.data[0]

    update_data = {
        "status": payload.action + "d",
        "reviewed_by": admin_payload["user_id"],
        "reviewed_at": now_utc().isoformat(),
        "review_notes": payload.notes
    }

    if payload.action == "reject":
        update_data["rejection_reason"] = payload.rejection_reason

    supabase.table("loan_applications").update(update_data).eq("id", payload.application_id).execute()

    if payload.action == "approve":
        message = (
            f"Congratulations {app_data['customer_name']}!\n\n"
            f"Your loan application has been APPROVED.\n\n"
            f"Loan ID: {app_data['loan_id']}\n\n"
            f"Our team will contact you within 24 hours.\n\n"
            f"- Your Bank Name"
        )
    else:
        message = (
            f"Dear {app_data['customer_name']},\n\n"
            f"Your loan application has been reviewed.\n\n"
            f"Loan ID: {app_data['loan_id']}\n"
            f"Status: Not Approved\n\n"
            f"Reason: {payload.rejection_reason or 'Contact customer service'}\n\n"
            f"- Your Bank Name"
        )

    await send_whatsapp_message(app_data["phone"], message)

    return {
        "status": "success",
        "message": f"Application {payload.action}d successfully"
    }


# ============================================
# AISENSY CAMPAIGN
# ============================================

@app.post("/api/send-campaign")
async def send_campaign(request: Request):
    """Send WhatsApp message via AiSensy campaign to one or multiple customers"""
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
    """Send AiSensy campaign to all customers with pending applications"""
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

    app_result = supabase.table("loan_applications") \
        .select("*") \
        .eq("phone", phone) \
        .neq("status", "submitted") \
        .order("created_at", desc=True) \
        .limit(1) \
        .execute()

    if not app_result.data:
        raise HTTPException(status_code=404, detail="No active loan application found for this number")

    application = app_result.data[0]

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

    session_result = supabase.table("loan_sessions").select("*").eq("session_token", session_id).execute()

    if not session_result.data:
        raise HTTPException(status_code=404, detail="Invalid session. Request a new OTP.")

    session = session_result.data[0]

    otp_expires = datetime.fromisoformat(session["otp_expires_at"])
    if otp_expires.tzinfo is None:
        otp_expires = otp_expires.replace(tzinfo=timezone.utc)

    if otp_expires < now_utc():
        raise HTTPException(status_code=410, detail="OTP expired. Request a new one.")

    if session["otp_attempts"] >= 5:
        raise HTTPException(status_code=429, detail="Too many incorrect attempts. Request a new OTP.")

    otp_hash = hashlib.sha256(otp.encode()).hexdigest()

    if otp_hash != session["otp_hash"]:
        supabase.table("loan_sessions").update({
            "otp_attempts": session["otp_attempts"] + 1
        }).eq("id", session["id"]).execute()
        remaining = 4 - session["otp_attempts"]
        raise HTTPException(status_code=400, detail=f"Incorrect OTP. {remaining} attempts remaining.")

    new_expiry = now_utc() + timedelta(minutes=30)

    supabase.table("loan_sessions").update({
        "otp_verified": True,
        "expires_at": new_expiry.isoformat(),
        "last_activity_at": now_utc().isoformat()
    }).eq("id", session["id"]).execute()

    return {
        "status": "verified",
        "session_token": session_id,
        "expires_at": new_expiry.isoformat(),
        "message": "OTP verified successfully"
    }


@app.get("/api/get-application")
async def get_application(session_token: str, request: Request):
    session_result = supabase.table("loan_sessions").select("*").eq("session_token", session_token).execute()

    if not session_result.data:
        raise HTTPException(status_code=401, detail="Invalid session. Please login again.")

    session = session_result.data[0]

    if not session["otp_verified"]:
        raise HTTPException(status_code=403, detail="OTP not verified.")

    expires_at = datetime.fromisoformat(session["expires_at"])
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at < now_utc():
        raise HTTPException(status_code=401, detail="Session expired. Please login again.")

    last_activity = datetime.fromisoformat(session["last_activity_at"])
    if last_activity.tzinfo is None:
        last_activity = last_activity.replace(tzinfo=timezone.utc)

    if (now_utc() - last_activity).total_seconds() > 300:
        raise HTTPException(status_code=401, detail="Session inactive for 5 minutes. Please re-verify.")

    supabase.table("loan_sessions").update({
        "last_activity_at": now_utc().isoformat()
    }).eq("id", session["id"]).execute()

    app_result = supabase.table("loan_applications").select("*").eq("id", session["application_id"]).execute()

    if not app_result.data:
        raise HTTPException(status_code=404, detail="Application not found.")

    return {
        "status": "success",
        "data": app_result.data[0],
        "session_valid_until": expires_at.isoformat()
    }


@app.post("/api/autosave-session")
async def autosave_session(request: Request):
    data = await request.json()
    session_token = data.get('session_token')
    form_data = data.get('data', {})
    step = data.get('step', 1)

    if not session_token:
        raise HTTPException(status_code=400, detail="Session token required")

    session_result = supabase.table("loan_sessions").select("*").eq("session_token", session_token).execute()

    if not session_result.data:
        raise HTTPException(status_code=401, detail="Invalid session")

    session = session_result.data[0]

    if not session["otp_verified"]:
        raise HTTPException(status_code=403, detail="OTP not verified")

    last_activity = datetime.fromisoformat(session["last_activity_at"])
    if last_activity.tzinfo is None:
        last_activity = last_activity.replace(tzinfo=timezone.utc)

    if (now_utc() - last_activity).total_seconds() > 300:
        raise HTTPException(status_code=401, detail="Session expired due to inactivity")

    supabase.table("loan_sessions").update({
        "last_activity_at": now_utc().isoformat()
    }).eq("id", session["id"]).execute()

    save_data = {
        "current_step": step,
        "last_saved_at": now_utc().isoformat(),
        **form_data
    }

    supabase.table("loan_applications").update(save_data).eq("id", session["application_id"]).execute()

    return {
        "status": "saved",
        "timestamp": now_utc().isoformat()
    }


@app.post("/api/submit-form-session")
async def submit_form_session(session_token: str, request: Request):
    session_result = supabase.table("loan_sessions").select("*").eq("session_token", session_token).execute()

    if not session_result.data:
        raise HTTPException(status_code=401, detail="Invalid session")

    session = session_result.data[0]

    app_result = supabase.table("loan_applications").select("*").eq("id", session["application_id"]).execute()

    if not app_result.data:
        raise HTTPException(status_code=404, detail="Application not found")

    app_data = app_result.data[0]

    supabase.table("loan_applications").update({
        "is_complete": True,
        "status": "submitted",
        "submitted_at": now_utc().isoformat()
    }).eq("id", app_data["id"]).execute()

    if WHATSAPP_API_TOKEN and WHATSAPP_PHONE_ID:
        message = (
            f"Dear {app_data['customer_name']},\n\n"
            f"Your loan application has been submitted!\n\n"
            f"Loan ID: {app_data['loan_id']}\n\n"
            f"Our team will review within 24-48 hours.\n\n"
            f"- Your Bank"
        )
        await send_whatsapp_message(app_data["phone"], message)

    return {
        "status": "submitted",
        "message": "Application submitted successfully",
        "loan_id": app_data["loan_id"]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)