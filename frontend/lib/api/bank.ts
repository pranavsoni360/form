// lib/api/bank.ts — bank user (officer + supervisor) endpoints
import { apiFetch, authHeaders } from "./index";

// ── AUTH ──────────────────────────────────────────
export async function bankLogin(username: string, password: string) {
  return apiFetch("/api/auth/bank-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function getMe(token: string) {
  return apiFetch("/api/auth/me", { headers: authHeaders(token) });
}

export async function authLogout() {
  return apiFetch("/api/auth/logout", { method: "POST" });
}

// ── OFFICER ───────────────────────────────────────
export async function getBankApplications(
  token: string,
  status?: string,
  dateFrom?: string,
  dateTo?: string,
) {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (dateFrom) p.set("date_from", dateFrom);
  if (dateTo) p.set("date_to", dateTo);
  const qs = p.toString() ? `?${p.toString()}` : "";
  return apiFetch(`/api/bank/applications${qs}`, {
    headers: authHeaders(token),
  });
}

export async function getApplicationDetail(token: string, appId: string) {
  return apiFetch(`/api/bank/applications/${appId}`, {
    headers: authHeaders(token),
  });
}

export async function officerApprove(
  token: string,
  appId: string,
  notes?: string,
) {
  return apiFetch(`/api/bank/applications/${appId}/officer-approve`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function officerReject(
  token: string,
  appId: string,
  notes?: string,
  rejection_reason?: string,
) {
  return apiFetch(`/api/bank/applications/${appId}/officer-reject`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes, rejection_reason }),
  });
}

// ── SUPERVISOR ────────────────────────────────────
export async function getSupervisorApplications(token: string) {
  return apiFetch("/api/bank/supervisor/applications", {
    headers: authHeaders(token),
  });
}

export async function supervisorApprove(
  token: string,
  appId: string,
  notes?: string,
) {
  return apiFetch(`/api/bank/applications/${appId}/supervisor-approve`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function supervisorReject(
  token: string,
  appId: string,
  notes?: string,
  rejection_reason?: string,
) {
  return apiFetch(`/api/bank/applications/${appId}/supervisor-reject`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes, rejection_reason }),
  });
}

export async function requestDocuments(
  token: string,
  appId: string,
  notes?: string,
) {
  return apiFetch(`/api/bank/applications/${appId}/request-documents`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function initiateDisbursement(
  token: string,
  appId: string,
  notes?: string,
) {
  return apiFetch(`/api/bank/applications/${appId}/disburse`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

// Staff cancel — voids an application before disbursement. Works for both
// bank_officer and bank_supervisor (backend enforces role + disbursed guard).
export async function cancelApplication(
  token: string,
  appId: string,
  reason?: string,
) {
  return apiFetch(`/api/bank/applications/${appId}/cancel`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ reason }),
  });
}

// ── LRS (Loan Recommendation System) ──────────────
export async function getLRSScore(token: string, appId: string) {
  return apiFetch(`/api/lrs/score/${appId}`, {
    headers: authHeaders(token),
  });
}

export async function rescoreLRS(token: string, appId: string) {
  return apiFetch(`/api/lrs/rescore/${appId}`, {
    method: "POST",
    headers: authHeaders(token),
  });
}
