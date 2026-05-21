// lib/api/admin.ts — admin (super-admin) endpoints
import { apiFetch, authHeaders } from "./index";

// ── AUTH ──────────────────────────────────────────
export async function adminLogin(email: string, password: string) {
  return apiFetch("/api/auth/admin-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

// ── STATS ─────────────────────────────────────────
export async function getAdminStats(token: string) {
  return apiFetch("/api/admin/stats", { headers: authHeaders(token) });
}

export async function seedMockData(token: string) {
  return apiFetch("/api/admin/seed-mock-data", {
    method: "POST",
    headers: authHeaders(token),
  });
}

// ── BANKS ─────────────────────────────────────────
export async function getBanks(token: string) {
  return apiFetch("/api/admin/banks", { headers: authHeaders(token) });
}

export async function createBank(
  token: string,
  data: {
    name: string;
    code: string;
    contact_email?: string;
    contact_phone?: string;
    address?: string;
  },
) {
  return apiFetch("/api/admin/banks", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function updateBank(
  token: string,
  bankId: string,
  data: Record<string, any>,
) {
  return apiFetch(`/api/admin/banks/${bankId}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function getBankDetail(token: string, bankId: string) {
  return apiFetch(`/api/admin/banks/${bankId}`, {
    headers: authHeaders(token),
  });
}

export async function createBankUser(
  token: string,
  bankId: string,
  data: {
    full_name: string;
    username: string;
    email?: string;
    role: string;
  },
) {
  return apiFetch(`/api/admin/banks/${bankId}/users`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function updateBankUser(
  token: string,
  bankId: string,
  userId: string,
  data: Record<string, any>,
) {
  return apiFetch(`/api/admin/banks/${bankId}/users/${userId}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function deactivateBankUser(
  token: string,
  bankId: string,
  userId: string,
) {
  return apiFetch(`/api/admin/banks/${bankId}/users/${userId}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
}

// ── APPLICATIONS ──────────────────────────────────
export async function getAdminApplications(
  token: string,
  filters?: { status?: string; bank_id?: string },
) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.bank_id) params.set("bank_id", filters.bank_id);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiFetch(`/api/admin/applications${qs}`, {
    headers: authHeaders(token),
  });
}

export async function adminGetApplicationDetail(token: string, appId: string) {
  return apiFetch(`/api/admin/applications/${appId}`, {
    headers: authHeaders(token),
  });
}

// Legacy review endpoint kept for backwards compat with existing admin pages.
export async function reviewApplication(
  token: string,
  id: string,
  action: string,
  notes?: string,
  rejection_reason?: string,
) {
  return apiFetch("/api/admin/review", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ application_id: id, action, notes, rejection_reason }),
  });
}

// Legacy: kept for backwards compat with frontend/components/AdminTable.tsx
export async function getApplications(token: string, status?: string) {
  const url = status
    ? `/api/admin/applications?status=${status}`
    : "/api/admin/applications";
  return apiFetch(url, { headers: authHeaders(token) });
}
