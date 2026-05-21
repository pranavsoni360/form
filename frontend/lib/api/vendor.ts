// lib/api/vendor.ts — vendor (NBFC / disbursement partner) endpoints
//
// NOTE: Backend endpoints for vendor are NOT yet implemented (Phase G work).
// These functions WILL 404 until the vendor backend is built. Frontend can
// already be wired up against these signatures.
import { apiFetch, authHeaders } from "./index";

// ── AUTH ──────────────────────────────────────────
export async function vendorLogin(username: string, password: string) {
  return apiFetch("/api/auth/vendor-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

// ── APPLICATIONS ──────────────────────────────────
export async function getVendorApplications(token: string, status?: string) {
  const qs = status ? `?status=${status}` : "";
  return apiFetch(`/api/vendor/applications${qs}`, {
    headers: authHeaders(token),
  });
}

export async function getVendorApplicationDetail(
  token: string,
  appId: string,
) {
  return apiFetch(`/api/vendor/applications/${appId}`, {
    headers: authHeaders(token),
  });
}

export async function vendorDisburse(
  token: string,
  appId: string,
  notes?: string,
) {
  return apiFetch(`/api/vendor/applications/${appId}/disburse`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function vendorReject(
  token: string,
  appId: string,
  notes?: string,
  rejection_reason?: string,
) {
  return apiFetch(`/api/vendor/applications/${appId}/reject`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ notes, rejection_reason }),
  });
}

// ── SETTLEMENTS ───────────────────────────────────
export async function getVendorSettlements(
  token: string,
  filters?: { from_date?: string; to_date?: string },
) {
  const params = new URLSearchParams();
  if (filters?.from_date) params.set("from_date", filters.from_date);
  if (filters?.to_date) params.set("to_date", filters.to_date);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiFetch(`/api/vendor/settlements${qs}`, {
    headers: authHeaders(token),
  });
}

// ── DASHBOARD ─────────────────────────────────────
export async function getVendorStats(token: string) {
  return apiFetch("/api/vendor/stats", { headers: authHeaders(token) });
}

// ── ADMIN-FACING vendor CRUD (super-admin manages vendors) ────
export async function getVendors(token: string) {
  return apiFetch("/api/admin/vendors", { headers: authHeaders(token) });
}

export async function createVendor(
  token: string,
  data: {
    name: string;
    code: string;
    contact_email?: string;
    contact_phone?: string;
    address?: string;
  },
) {
  return apiFetch("/api/admin/vendors", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function updateVendor(
  token: string,
  vendorId: string,
  data: Record<string, any>,
) {
  return apiFetch(`/api/admin/vendors/${vendorId}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function assignApplicationToVendor(
  token: string,
  appId: string,
  vendorId: string,
  notes?: string,
) {
  return apiFetch(`/api/admin/applications/${appId}/assign-vendor`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ vendor_id: vendorId, notes }),
  });
}
