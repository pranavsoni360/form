// lib/api/vendor.ts — vendor portal client (matches backend routers/vendors.py)
//
// Routes (live on origin/feature/m6-realtime-backbone):
//   POST /api/vendor/login                          — JWT
//   GET  /api/vendor/me
//   GET  /api/vendor/applications[?status=...]      — assigned apps
//   GET  /api/vendor/applications/{aid}             — detail
//   POST /api/vendor/assignments/{ava_id}/accept
//   POST /api/vendor/assignments/{ava_id}/reject    — { reason }
//   POST /api/vendor/assignments/{ava_id}/disburse  — { disbursed_amount, disbursement_ref }
//   GET  /api/vendor/settlements[?status=...]
import { apiFetch, authHeaders } from "./index";

// ── AUTH ──────────────────────────────────────────
export async function vendorLogin(username: string, password: string) {
  return apiFetch("/api/vendor/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function getVendorMe(token: string) {
  return apiFetch("/api/vendor/me", { headers: authHeaders(token) });
}

// ── ASSIGNED APPLICATIONS ─────────────────────────
export type VendorAssignmentStatus =
  | "pending" | "accepted" | "disbursed" | "vendor_rejected" | "withdrawn";

export async function getVendorApplications(
  token: string,
  status?: VendorAssignmentStatus,
) {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(`/api/vendor/applications${qs}`, { headers: authHeaders(token) });
}

export async function getVendorApplicationDetail(token: string, appId: string) {
  return apiFetch(`/api/vendor/applications/${appId}`, { headers: authHeaders(token) });
}

// ── ASSIGNMENT ACTIONS (vendor side) ──────────────
// All three target the assignment_id (ava_id), NOT the application_id.
export async function vendorAccept(token: string, avaId: string) {
  return apiFetch(`/api/vendor/assignments/${avaId}/accept`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function vendorReject(token: string, avaId: string, reason: string) {
  return apiFetch(`/api/vendor/assignments/${avaId}/reject`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ reason }),
  });
}

export async function vendorDisburse(
  token: string,
  avaId: string,
  disbursed_amount: number,
  disbursement_ref: string,
) {
  return apiFetch(`/api/vendor/assignments/${avaId}/disburse`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ disbursed_amount, disbursement_ref }),
  });
}

// ── SETTLEMENTS ───────────────────────────────────
export type SettlementStatus = "pending" | "paid" | "failed" | "disputed";

export async function getVendorSettlements(token: string, status?: SettlementStatus) {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(`/api/vendor/settlements${qs}`, { headers: authHeaders(token) });
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN-FACING vendor management (used by /admin/vendors page)
// ════════════════════════════════════════════════════════════════════════════
export async function adminListVendors(token: string, status?: string) {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(`/api/admin/vendors${qs}`, { headers: authHeaders(token) });
}

export async function adminGetVendor(token: string, vendorId: string) {
  return apiFetch(`/api/admin/vendors/${vendorId}`, { headers: authHeaders(token) });
}

export async function adminCreateVendor(
  token: string,
  data: {
    name: string;
    code: string;
    contact_email?: string;
    contact_phone?: string;
    address?: string;
    gstin?: string;
    pan_number?: string;
  },
) {
  return apiFetch("/api/admin/vendors", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function adminUpdateVendor(
  token: string,
  vendorId: string,
  data: Record<string, any>,
) {
  return apiFetch(`/api/admin/vendors/${vendorId}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function adminDeactivateVendor(token: string, vendorId: string) {
  return apiFetch(`/api/admin/vendors/${vendorId}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
}

export async function adminCreateVendorUser(
  token: string,
  vendorId: string,
  data: {
    full_name: string;
    username: string;
    password: string;
    email?: string;
    role?: "vendor" | "vendor_manager";
  },
) {
  return apiFetch(`/api/admin/vendors/${vendorId}/users`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

// ── PARTNERSHIPS (M:N bank<->vendor) ──────────────
export async function adminListPartnerships(
  token: string,
  filters?: { bank_id?: string; vendor_id?: string },
) {
  const params = new URLSearchParams();
  if (filters?.bank_id) params.set("bank_id", filters.bank_id);
  if (filters?.vendor_id) params.set("vendor_id", filters.vendor_id);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiFetch(`/api/admin/partnerships${qs}`, { headers: authHeaders(token) });
}

export async function adminCreatePartnership(
  token: string,
  data: { bank_id: string; vendor_id: string; commission_pct?: number; notes?: string },
) {
  return apiFetch("/api/admin/partnerships", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function adminUpdatePartnership(
  token: string,
  partnershipId: string,
  data: { status?: string; commission_pct?: number; notes?: string },
) {
  return apiFetch(`/api/admin/partnerships/${partnershipId}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function adminTerminatePartnership(token: string, partnershipId: string) {
  return apiFetch(`/api/admin/partnerships/${partnershipId}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// BANK-side vendor actions (bank user views partnered vendors + assigns)
// ════════════════════════════════════════════════════════════════════════════
export async function bankListPartneredVendors(token: string) {
  return apiFetch("/api/bank/vendors", { headers: authHeaders(token) });
}

export async function bankAssignVendor(
  token: string,
  applicationId: string,
  vendorId: string,
  notes?: string,
) {
  return apiFetch(`/api/bank/applications/${applicationId}/assign-vendor`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ vendor_id: vendorId, notes }),
  });
}

export async function bankWithdrawAssignment(token: string, applicationId: string) {
  return apiFetch(`/api/bank/applications/${applicationId}/withdraw-assignment`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function bankGetAssignmentHistory(token: string, applicationId: string) {
  return apiFetch(`/api/bank/applications/${applicationId}/assignments`, {
    headers: authHeaders(token),
  });
}
