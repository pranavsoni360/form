// lib/api/apply.ts — customer-facing apply / form / OTP / DigiLocker endpoints
import { API_URL, apiFetch } from "./index";

// ── OTP (session-based, design-upgrade pattern) ──────────────
export async function requestOTP(phone: string) {
  return apiFetch("/api/request-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
}

export async function verifyOTPSession(phone: string, otp: string) {
  return apiFetch("/api/verify-otp-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, otp }),
  });
}

// ── OTP (legacy token-based) ─────────────────────────────────
export async function sendOTP(phone: string) {
  return apiFetch("/api/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
}

export async function verifyOTP(phone: string, otp: string) {
  return apiFetch("/api/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, otp }),
  });
}

// ── FORM (session-based, design-upgrade pattern) ─────────────
export async function getApplication(sessionToken: string) {
  return apiFetch("/api/get-application", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: sessionToken }),
  });
}

export async function autoSaveSession(
  sessionToken: string,
  formData: Record<string, any>,
) {
  return apiFetch("/api/autosave-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: sessionToken, form_data: formData }),
  });
}

export async function verifyPANSession(sessionToken: string, pan: string) {
  return apiFetch("/api/verify-pan-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: sessionToken, pan_number: pan }),
  });
}

export async function submitFormSession(sessionToken: string) {
  return apiFetch("/api/submit-form-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: sessionToken }),
  });
}

export async function uploadDocumentSession(
  sessionToken: string,
  documentType: string,
  file: File,
) {
  const formData = new FormData();
  formData.append("session_token", sessionToken);
  formData.append("document_type", documentType);
  formData.append("file", file);
  const res = await fetch(`${API_URL}/api/upload-document-session`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Upload failed");
  return data;
}

// ── DIGILOCKER / AADHAAR ─────────────────────────────────────
export async function aadhaarLink(
  tokenOrSession: string,
  aadhaarNumber: string,
) {
  return apiFetch("/api/aadhaar-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: tokenOrSession,
      session_token: tokenOrSession,
      aadhaar_number: aadhaarNumber,
    }),
  });
}

export async function aadhaarDocuments(
  tokenOrSession: string,
  requestId: string,
) {
  return apiFetch("/api/aadhaar-documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: tokenOrSession,
      session_token: tokenOrSession,
      request_id: requestId,
    }),
  });
}

export async function aadhaarDownload(
  tokenOrSession: string,
  requestId: string,
  uri: string,
) {
  return apiFetch("/api/aadhaar-download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: tokenOrSession,
      session_token: tokenOrSession,
      request_id: requestId,
      uri,
    }),
  });
}

// ── LEGACY TOKEN-BASED FORM (existing /form/[token] flow) ─────
export async function validateToken(token: string) {
  return apiFetch(`/api/validate-token/${token}`);
}

export async function autoSave(token: string, formData: Record<string, any>) {
  return apiFetch("/api/autosave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, form_data: formData }),
  });
}

export async function uploadDocument(
  token: string,
  documentType: string,
  file: File,
) {
  const formData = new FormData();
  formData.append("token", token);
  formData.append("document_type", documentType);
  formData.append("file", file);
  const res = await fetch(`${API_URL}/api/upload-document`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Upload failed");
  return data;
}

export async function verifyPAN(token: string, pan: string) {
  return apiFetch(`/api/verify-pan?token=${token}&pan_number=${pan}`, {
    method: "POST",
  });
}

export async function verifyAadhaar(token: string, aadhaar: string) {
  return apiFetch(
    `/api/verify-aadhaar?token=${token}&aadhaar_number=${aadhaar}`,
    { method: "POST" },
  );
}

export async function submitForm(token: string) {
  return apiFetch(`/api/submit-form?token=${token}`, { method: "POST" });
}

// ── DROPDOWNS (Galaxy code-list API) ─────────────────────────
export async function getCodeList(
  sqlMstId: number,
  param?: string,
): Promise<{
  status: string;
  data: { code_mst_id: string; code_desc: string }[];
  fallback: boolean;
}> {
  const qs = param ? `?param=${encodeURIComponent(param)}` : "";
  const res = await fetch(`${API_URL}/api/code-list/${sqlMstId}${qs}`);
  return res.json();
}
