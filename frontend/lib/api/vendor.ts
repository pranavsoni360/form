// lib/api/vendor.ts
// Vendor = NBFCs / private lenders who disburse loans
import { apiFetch, authHeaders } from './index';

export async function vendorLogin(username: string, password: string) {
  return apiFetch('/api/auth/vendor-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

// ── APPLICATIONS ──────────────────────────────────
export async function getVendorApplications(
  token: string,
  status?: string
) {
  const qs = status ? `?status=${status}` : '';
  return apiFetch(`/api/vendor/applications${qs}`, {
    headers: authHeaders(token),
  });
}

export async function getVendorApplicationDetail(
  token: string,
  appId: string
) {
  return apiFetch(`/api/vendor/applications/${appId}`, {
    headers: authHeaders(token),
  });
}

export async function vendorDisburse(
  token: string,
  appId: string,
  notes?: string
) {
  return apiFetch(`/api/vendor/applications/${appId}/disburse`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function vendorReject(
  token: string,
  appId: string,
  notes?: string,
  rejection_reason?: string
) {
  return apiFetch(`/api/vendor/applications/${appId}/reject`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes, rejection_reason }),
  });
}

// ── SETTLEMENTS ───────────────────────────────────
export async function getVendorSettlements(
  token: string,
  filters?: { from_date?: string; to_date?: string }
) {
  const params = new URLSearchParams();
  if (filters?.from_date) params.set('from_date', filters.from_date);
  if (filters?.to_date) params.set('to_date', filters.to_date);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(`/api/vendor/settlements${qs}`, {
    headers: authHeaders(token),
  });
}

// ── DASHBOARD ─────────────────────────────────────
export async function getVendorStats(token: string) {
  return apiFetch('/api/vendor/stats', { headers: authHeaders(token) });
}

// ── ADMIN VENDOR MANAGEMENT (admin token required) ────────────────────────────
export async function adminListVendors(token: string) {
  return apiFetch('/api/admin/vendors', { headers: authHeaders(token) });
}

export async function adminGetVendor(token: string, vendorId: string) {
  return apiFetch(`/api/admin/vendors/${vendorId}`, { headers: authHeaders(token) });
}

export async function adminCreateVendor(
  token: string,
  body: { name: string; code: string; contact_email?: string; contact_phone?: string; address?: string; gstin?: string; pan_number?: string }
) {
  return apiFetch('/api/admin/vendors', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

export async function adminDeactivateVendor(token: string, vendorId: string) {
  return apiFetch(`/api/admin/vendors/${vendorId}/deactivate`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

export async function adminCreateVendorUser(
  token: string,
  vendorId: string,
  body: { full_name: string; username: string; email?: string; password: string; role?: string }
) {
  return apiFetch(`/api/admin/vendors/${vendorId}/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

export async function adminListPartnerships(
  token: string,
  filters?: { vendor_id?: string; bank_id?: string }
) {
  const params = new URLSearchParams();
  if (filters?.vendor_id) params.set('vendor_id', filters.vendor_id);
  if (filters?.bank_id) params.set('bank_id', filters.bank_id);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(`/api/admin/partnerships${qs}`, { headers: authHeaders(token) });
}

export async function adminCreatePartnership(
  token: string,
  body: { bank_id: string; vendor_id: string; commission_pct?: number; notes?: string }
) {
  return apiFetch('/api/admin/partnerships', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

export async function adminTerminatePartnership(token: string, partnershipId: string) {
  return apiFetch(`/api/admin/partnerships/${partnershipId}/terminate`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

// ── BANK-SIDE VENDOR ASSIGNMENT (bank token required) ────────────────────────
export async function bankListPartneredVendors(token: string) {
  return apiFetch('/api/bank/vendors', { headers: authHeaders(token) });
}

export async function bankAssignVendor(
  token: string,
  appId: string,
  vendorId: string,
  notes?: string
) {
  return apiFetch(`/api/bank/applications/${appId}/assign-vendor`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ vendor_id: vendorId, notes }),
  });
}

export async function bankWithdrawAssignment(token: string, appId: string) {
  return apiFetch(`/api/bank/applications/${appId}/withdraw-vendor`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

export async function bankGetAssignmentHistory(token: string, appId: string) {
  return apiFetch(`/api/bank/applications/${appId}/vendor-history`, {
    headers: authHeaders(token),
  });
}