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
import json

load_dotenv()

app = FastAPI(
    title="Bank Loan Form API",
    description="Production-grade loan form system with OTP verification",
    version="1.0.0"
)

APP_URL = os.getenv("APP_URL", "http://localhost:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://virtualvaani.vgipl.com",
        "https://virtualvaani.vgipl.com:3001",
    ],
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

# VG Doc Verify API config
VG_API_BASE = os.getenv("VG_API_BASE", "http://10.200.10.43/VGDocverify/VGKVerify.asmx")
VG_USER_ID = os.getenv("PAN_API_USER_ID", "33")
VG_KEY = os.getenv("PAN_API_KEY", "CONV27032026")
VG_BANK_CODE = os.getenv("BANK_SHORT_CODE", "VGIL")
VG_BANK_NAME = os.getenv("BANK_NAME", "VIRTUAL URBAN CO-OPERATIVE BANK LTD")

def vg_base_obj(api_code: str) -> dict:
    """Base object for all VG API calls"""
    return {
        "UserId": VG_USER_ID,
        "VerificationKey": VG_KEY,
        "Longitude": "", "Latitude": "", "Accuracy": "",
        "App_Mode": "", "Request From": "", "Device_Id": "",
        "Bank_short_code": VG_BANK_CODE,
        "Bank_Name": VG_BANK_NAME,
        "APICode": api_code
    }

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

def clean_phone(phone: str) -> str:
    """Normalize phone to 12-digit Indian format (91XXXXXXXXXX)"""
    digits = phone.replace('+', '').replace(' ', '').replace('-', '')
    if digits.startswith('91') and len(digits) == 12:
        return digits
    if len(digits) == 10:
        return f"91{digits}"
    return digits

def parse_vg_response(raw: str) -> dict:
    """Parse VG API response, handling double-JSON issue"""
    raw = raw.strip()
    if '}{' in raw:
        raw = raw.split('}{')[0] + '}'
    return json.loads(raw)

async def get_token_and_app_id(token: str):
    """Resolve token to (token_row, application_id). Works for both form_tokens and loan_sessions."""
    session_result = supabase.table("loan_sessions").select("*").eq("session_token", token).execute()
    token_result = supabase.table("form_tokens").select("*").eq("token", token).execute()

    if not session_result.data and not token_result.data:
        raise HTTPException(status_code=404, detail="Invalid token or session")

    application_id = None
    token_row = None

    if session_result.data:
        application_id = session_result.data[0]["application_id"]
        token_row = session_result.data[0]
    elif token_result.data:
        token_row = token_result.data[0]
        app_result = supabase.table("loan_applications").select("id").eq("token_id", token_row["id"]).execute()
        if app_result.data:
            application_id = app_result.data[0]["id"]

    return token_row, application_id


async def send_otp_via_aisensy(phone: str, customer_name: str, otp: str):
    """Send OTP via AiSensy otp_verification campaign"""
    if not AISENSY_API_KEY:
        print(f"[AiSensy] Not configured. OTP for {phone}: {otp}")
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
        "buttons": [
            {
                "type": "button",
                "sub_type": "url",
                "index": 0,
                "parameters": [
                    {
                        "type": "text",
                        "text": otp
                    }
                ]
            }
        ],
        "carouselCards": [],
        "location": {},
        "attributes": {},
        "paramsFallbackValue": {
            "FirstName": "user"
        }
    }

    async with httpx.AsyncClient(verify=False, timeout=10) as client:
        try:
            response = await client.post(
                "https://backend.aisensy.com/campaign/t1/api/v2",
                json=payload
            )
            print(f"[AiSensy OTP] {phone_formatted} -> {response.status_code} | {response.text}")
            return response.json() if response.text else {"status": "sent"}
        except Exception as e:
            print(f"[AiSensy OTP] Error: {e}")
            return {"status": "failed", "error": str(e)}


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

            try:
                response_data = response.json()
            except Exception:
                response_data = {"error": response.text}

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


async def send_whatsapp_aisensy(phone: str, customer_name: str):
    """Send WhatsApp message via AiSensy campaign API"""
    if not AISENSY_API_KEY:
        print(f"AiSensy not configured. Would send to {phone}")
        return {"status": "simulated"}

    phone_formatted = clean_phone(phone)
    first_name = customer_name.split()[0]

    payload = {
        "apiKey": AISENSY_API_KEY,
        "campaignName": AISENSY_CAMPAIGN_NAME,
        "destination": phone_formatted,
        "userName": AISENSY_USERNAME,
        "templateParams": [first_name, first_name],
        "source": "loan-form-system",
        "media": {
            "url": "https://d3jt6ku4g6z5l8.cloudfront.net/IMAGE/6353da2e153a147b991dd812/4958901_highanglekidcheatingschooltestmin.jpg",
            "filename": "sample_media"
        },
        "buttons": [],
        "carouselCards": [],
        "location": {},
        "attributes": {},
        "paramsFallbackValue": {"FirstName": "user"}
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
            form_url = f"{APP_URL}/loan-form"

            message = (
                f"Dear {customer.customer_name},\n\n"
                f"Complete your loan application.\n\n"
                f"Loan ID: {customer.loan_id}\n\n"
                f"Click to fill the form:\n{form_url}\n\n"
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

    print(f"[OTP] Sending to {token_data['phone']} via AiSensy")

    await send_otp_via_aisensy(
        phone=token_data["phone"],
        customer_name=token_data["customer_name"],
        otp=otp
    )

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


# ============================================
# PAN VERIFICATION
# ============================================

@app.post("/api/verify-pan")
async def verify_pan(request: Request):
    data = await request.json()
    token = data.get('token')
    pan_number = data.get('pan_number')

    if not token or not pan_number:
        raise HTTPException(status_code=400, detail="Token and PAN number required")

    if not re.match(r'^[A-Z]{5}[0-9]{4}[A-Z]{1}$', pan_number):
        raise HTTPException(status_code=400, detail="Invalid PAN format. Must be like ABCDE1234F")

    token_row, application_id = await get_token_and_app_id(token)

    pan_payload = {
        "obj": [{
            **vg_base_obj("pancard"),
            "PanNo": pan_number
        }]
    }

    try:
        # Mock mode for testing outside office network
        if pan_number.startswith("ABCDE"):
            print("MOCK MODE: Simulating PAN verification")
            api_data = {"status-code": "101", "result": {"name": "TEST USER NAME", "pan": pan_number}}
        else:
            async with httpx.AsyncClient(verify=False, timeout=20.0) as client:
                response = await client.post(
                    os.getenv("PAN_API_URL", f"{VG_API_BASE}/Pan"),
                    json=pan_payload,
                    headers={"Content-Type": "application/json"}
                )
            print("RAW PAN RESPONSE:", response.text)
            api_data = parse_vg_response(response.text)

        print("PAN API Response:", api_data)
        status_code = str(api_data.get("status-code"))

        if status_code != "101":
            raise HTTPException(status_code=400, detail=f"PAN verification failed. Code: {status_code}")

        pan_name = api_data.get("result", {}).get("name", "")

        # Save to DB
        try:
            pan_update = {
                "pan_number": pan_number,
                "pan_verified": True,
                "pan_name": pan_name,
                "full_name": pan_name,
                "pan_verification_timestamp": now_utc().isoformat()
            }
            if application_id:
                supabase.table("loan_applications").update(pan_update).eq("id", application_id).execute()
            else:
                pan_update["token_id"] = token_row["id"]
                supabase.table("loan_applications").insert(pan_update).execute()
        except Exception as e:
            print(f"Warning: DB save failed for PAN: {e}")

        return {
            "status": "verified",
            "pan_name": pan_name,
            "message": "PAN verified successfully"
        }

    except HTTPException:
        raise
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="PAN API unreachable (Internal Network only)")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="PAN API request timed out")
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"PAN API Error: {str(e)}")


# ============================================
# AADHAAR VERIFICATION (DigiLocker - 3 steps)
# ============================================

@app.post("/api/aadhaar-link")
async def generate_aadhaar_link(request: Request):
    """
    Step 1 - Generate DigiLocker auth link.
    Customer clicks this link, logs in with Aadhaar OTP on DigiLocker, then returns.
    """
    data = await request.json()
    token = data.get('token')
    aadhaar_number = data.get('aadhaar_number', '')

    if not token:
        raise HTTPException(status_code=400, detail="Token required")

    token_row, application_id = await get_token_and_app_id(token)

    payload = {
        "obj": [{
            **vg_base_obj("digilocker_link"),
            "redirectUrl": f"{APP_URL}/aadhaar-success",
            "oAuthState": "123",
            "aadhaarFlowRequired": "true",
            "pinlessAuth": "true",
            "customDocList": "ADHAR",
            "aadhaar_number": aadhaar_number,
            "aadhaarNumber": aadhaar_number,
            "uid": aadhaar_number,
            "UID": aadhaar_number,
        }]
    }

    try:
        async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
            response = await client.post(
                f"{VG_API_BASE}/Digilockerlink",
                json=payload,
                headers={"Content-Type": "application/json"}
            )

        print("AADHAAR LINK RAW:", response.text)
        api_data = parse_vg_response(response.text)
        print("AADHAAR LINK PARSED:", api_data)

        if str(api_data.get("statusCode")) != "101":
            raise HTTPException(status_code=400, detail=f"Aadhaar link generation failed: {api_data.get('message', '')}")

        request_id = api_data.get("requestId")
        link = api_data.get("result", {}).get("link")

        if not link:
            raise HTTPException(status_code=400, detail="No DigiLocker link returned from API")

        return {
            "status": "success",
            "request_id": request_id,
            "link": link
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Aadhaar Link Error: {repr(e)}")


@app.post("/api/aadhaar-documents")
async def fetch_aadhaar_documents(request: Request):
    """
    Step 2 - After customer completes DigiLocker auth, fetch available documents.
    Returns the Aadhaar document URI needed for Step 3.
    """
    data = await request.json()
    token = data.get('token')
    request_id = data.get('request_id')

    if not token or not request_id:
        raise HTTPException(status_code=400, detail="Token and request_id required")

    token_row, _ = await get_token_and_app_id(token)

    payload = {
        "obj": [{
            **vg_base_obj("digilocker_doc"),
            "AccessRequestId": request_id
        }]
    }

    try:
        async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
            response = await client.post(
                f"{VG_API_BASE}/Digilockerdocuments",
                json=payload,
                headers={"Content-Type": "application/json"}
            )

        print("AADHAAR DOCS RAW:", response.text)
        api_data = parse_vg_response(response.text)
        print("AADHAAR DOCS PARSED:", api_data)

        if str(api_data.get("statusCode")) != "101":
            raise HTTPException(status_code=400, detail="Failed to fetch Aadhaar documents")

        raw_results = api_data.get("result", [])
        results = raw_results if isinstance(raw_results, list) else [raw_results]

        uri = None
        for doc in results:
            if isinstance(doc, dict) and doc.get("doctype") == "ADHAR":
                uri = doc.get("uri")
                break

        if not uri:
            raise HTTPException(status_code=400, detail="Aadhaar document not found in DigiLocker")

        return {
            "status": "success",
            "request_id": request_id,
            "uri": uri
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Aadhaar Documents Error: {repr(e)}")


@app.post("/api/aadhaar-download")
async def download_aadhaar(request: Request):
    """
    Step 3 - Download and parse Aadhaar XML.
    Returns name, dob, gender, address, last4 — all saved to loan_applications.
    """
    data = await request.json()
    token = data.get('token')
    request_id = data.get('request_id')
    uri = data.get('uri')

    if not token or not request_id or not uri:
        raise HTTPException(status_code=400, detail="token, request_id and uri are all required")

    token_row, application_id = await get_token_and_app_id(token)

    payload = {
        "obj": [{
            **vg_base_obj("digilocker_download"),
            "AccessRequestId": request_id,
            "uri": uri,
            "pdfB64": "true",
            "parsed": "true",
            "xml": "true",
            "json": "true"
        }]
    }

    try:
        async with httpx.AsyncClient(verify=False, timeout=40.0) as client:
            response = await client.post(
                f"{VG_API_BASE}/Digilockerdownload",
                json=payload,
                headers={"Content-Type": "application/json"}
            )

        print("AADHAAR DOWNLOAD RAW:", response.text)
        api_data = parse_vg_response(response.text)
        print("AADHAAR DOWNLOAD PARSED:", api_data)

        if str(api_data.get("statusCode")) != "101":
            raise HTTPException(status_code=400, detail="Aadhaar download failed")

        raw_result_list = api_data.get("result", [])
        result_list = raw_result_list if isinstance(raw_result_list, list) else [raw_result_list]

        if not result_list:
            raise HTTPException(status_code=400, detail="No Aadhaar data in response")

        parsed = result_list[0].get("parsedFile", {}).get("data", {}).get("issuedTo", {})
        additional = result_list[0].get("parsedFile", {}).get("data", {}).get("additionalData", {})

        # Extract fields
        name = parsed.get("name", "")
        uid = parsed.get("uid", "")
        dob = additional.get("dob", parsed.get("dob", ""))

        # Gender normalization
        raw_gender = additional.get("gender", parsed.get("gender", ""))
        gender = ""
        if raw_gender:
            g = raw_gender.strip().lower()
            if g in ["m", "male"]:
                gender = "Male"
            elif g in ["f", "female"]:
                gender = "Female"
            else:
                gender = raw_gender

        # Address — handles dict or string from API
        address_raw = parsed.get("address", "")
        if isinstance(address_raw, dict):
            address = ", ".join([str(v).strip() for v in address_raw.values() if v and str(v).strip()])
        elif isinstance(address_raw, str) and address_raw:
            address = address_raw
        else:
            parts = [
                parsed.get("house", ""), parsed.get("street", ""),
                parsed.get("landmark", ""), parsed.get("loc", ""),
                parsed.get("vtc", ""), parsed.get("dist", ""),
                parsed.get("state", ""), parsed.get("pc", "")
            ]
            address = ", ".join([p.strip() for p in parts if p and p.strip()])

        last4 = uid[-4:] if uid else ""

        # Save all Aadhaar fields to DB
        try:
            aadhaar_update = {
                "aadhaar_verified": True,
                "aadhaar_last4": last4,
                "aadhaar_name": name,
                "aadhaar_dob": dob,
                "aadhaar_gender": gender,
                "aadhaar_address": address,
                "aadhaar_verification_timestamp": now_utc().isoformat()
            }
            if application_id:
                supabase.table("loan_applications").update(aadhaar_update).eq("id", application_id).execute()
            else:
                aadhaar_update["token_id"] = token_row["id"]
                supabase.table("loan_applications").insert(aadhaar_update).execute()
        except Exception as e:
            print(f"Warning: DB save failed for Aadhaar: {e}")

        return {
            "status": "verified",
            "name": name,
            "last4": last4,
            "dob": dob,
            "gender": gender,
            "address": address,
            "message": "Aadhaar verified successfully"
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Aadhaar Download Error: {repr(e)}")


# ============================================
# DOCUMENT UPLOAD
# ============================================

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


# ============================================
# FORM SUBMIT
# ============================================

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
        f"Loan ID: {token_data['loan_id']}\n\n"
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


# ============================================
# ADMIN
# ============================================

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
    data = await request.json()
    phone = data.get('phone')
    customer_name = data.get('customer_name', 'Customer')

    if not phone:
        raise HTTPException(status_code=400, detail="Phone number required")

    result = await send_whatsapp_aisensy(phone, customer_name)
    return {"status": "sent", "phone": phone, "aisensy_response": result}


@app.post("/api/send-campaign-bulk")
async def send_campaign_bulk(request: Request):
    data = await request.json()
    loan_ids = data.get('loan_ids', [])

    query = supabase.table("loan_applications") \
        .select("customer_name, phone, loan_id") \
        .eq("status", "draft")

    if loan_ids:
        query = query.in_("loan_id", loan_ids)

    app_result = query.execute()

    if not app_result.data:
        raise HTTPException(status_code=404, detail="No pending applications found")

    results = []
    for app in app_result.data:
        result = await send_whatsapp_aisensy(phone=app["phone"], customer_name=app["customer_name"])
        results.append({
            "phone": app["phone"],
            "customer_name": app["customer_name"],
            "loan_id": app["loan_id"],
            "status": "sent",
            "response": result
        })

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

    print(f"[OTP] Sending to {phone} via AiSensy | Customer: {application['customer_name']}")

    await send_otp_via_aisensy(
        phone=phone,
        customer_name=application["customer_name"],
        otp=otp
    )

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