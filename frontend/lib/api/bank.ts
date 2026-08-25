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

// ── Bank Statement Analysis (Digitap via AcAggregator) ──────────────────────
// A borrower journey, not a synchronous call: the officer issues an upload link,
// the borrower uploads a PDF at Digitap, and the report arrives minutes-to-hours
// later. The officer UI therefore shows a lifecycle, not a result.

export type BsaStatus = "pending" | "processing" | "completed" | "failed" | "expired";

export interface BsaInstitution {
  digitap_id: number;
  name: string;
  inst_type?: string | null;
  form26as_enabled?: boolean;
}

export interface BsaFetch {
  id: string;
  application_id: string;
  status: BsaStatus;
  institution_id?: number | null;
  institution_name?: string | null;
  start_month?: string | null;
  end_month?: string | null;
  upload_url?: string | null;
  expires_at?: string | null;
  /** Digitap's own code, e.g. ReportGenerated / TxnExpired / AAFIDataStatusError. */
  vendor_code?: string | null;
  vendor_message?: string | null;
  /**
   * Derived scorecard inputs plus a coverage report. `coverage.missing` names
   * the inputs the statement could NOT support — shown rather than hidden, so an
   * officer can tell "healthy cash flow" from "we could not tell".
   */
  metrics?: {
    inputs?: Record<string, number | string>;
    coverage?: { derived: string[]; missing: string[] };
    context?: Record<string, unknown>;
  } | null;
  has_report: boolean;
  created_at?: string | null;
  completed_at?: string | null;
}

export async function bsaInstitutions(refresh = false): Promise<{ institutions: BsaInstitution[]; cached: boolean; stale?: boolean }> {
  return apiFetch(`/api/bsa/institutions${refresh ? "?refresh=true" : ""}`);
}

export async function bsaListFetches(applicationId: string): Promise<{ fetches: BsaFetch[] }> {
  return apiFetch(`/api/bsa/applications/${applicationId}/fetches`);
}

export async function bsaStartFetch(body: {
  application_id: string;
  institution_id: number;
  institution_name?: string;
  months?: number;
}): Promise<{ fetch: BsaFetch }> {
  return apiFetch(`/api/bsa/fetches`, { method: "POST", body: JSON.stringify(body) });
}

/** Force a statuscheck now. Used by the officer's Refresh, not on a timer. */
export async function bsaAdvance(fetchId: string): Promise<{ fetch: BsaFetch }> {
  return apiFetch(`/api/bsa/fetches/${fetchId}/advance`, { method: "POST" });
}
