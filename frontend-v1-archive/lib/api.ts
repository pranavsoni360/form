export const API_URL = typeof window !== 'undefined' && window.location.hostname === 'localhost'
  ? 'http://localhost:8200'
  : (process.env.NEXT_PUBLIC_API_URL || 'https://virtualvaani.vgipl.com:8200');

// ============================================
// HELPERS
// ============================================

async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, { ...options, credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

function authHeaders(token: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

// ============================================
// AUTH — ADMIN
// ============================================

export async function adminLogin(email: string, password: string) {
  return apiFetch('/api/auth/admin-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export async function authLogout() {
  return apiFetch('/api/auth/logout', { method: 'POST' });
}

// ============================================
// DIGILOCKER AADHAAR VERIFICATION
// ============================================

export async function aadhaarLink(tokenOrSession: string, aadhaarNumber: string) {
  return apiFetch('/api/aadhaar-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tokenOrSession, session_token: tokenOrSession, aadhaar_number: aadhaarNumber }),
  });
}

export async function aadhaarDocuments(tokenOrSession: string, requestId: string) {
  return apiFetch('/api/aadhaar-documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tokenOrSession, session_token: tokenOrSession, request_id: requestId }),
  });
}

export async function aadhaarDownload(tokenOrSession: string, requestId: string, uri: string) {
  return apiFetch('/api/aadhaar-download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tokenOrSession, session_token: tokenOrSession, request_id: requestId, uri }),
  });
}

// ============================================
// AUTH — BANK USER
// ============================================

export async function bankLogin(username: string, password: string) {
  return apiFetch('/api/auth/bank-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export async function getMe(token: string) {
  return apiFetch('/api/auth/me', { headers: authHeaders(token) });
}

// ============================================
// ADMIN — BANK MANAGEMENT
// ============================================

export async function getBanks(token: string) {
  return apiFetch('/api/admin/banks', { headers: authHeaders(token) });
}

export async function createBank(token: string, data: { name: string; code: string; contact_email?: string; contact_phone?: string; address?: string }) {
  return apiFetch('/api/admin/banks', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function updateBank(token: string, bankId: string, data: Record<string, any>) {
  return apiFetch(`/api/admin/banks/${bankId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function getBankDetail(token: string, bankId: string) {
  return apiFetch(`/api/admin/banks/${bankId}`, { headers: authHeaders(token) });
}

export async function createBankUser(token: string, bankId: string, data: { full_name: string; username: string; email?: string; role: string }) {
  return apiFetch(`/api/admin/banks/${bankId}/users`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function updateBankUser(token: string, bankId: string, userId: string, data: Record<string, any>) {
  return apiFetch(`/api/admin/banks/${bankId}/users/${userId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  });
}

export async function deactivateBankUser(token: string, bankId: string, userId: string) {
  return apiFetch(`/api/admin/banks/${bankId}/users/${userId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

export async function getAdminStats(token: string) {
  return apiFetch('/api/admin/stats', { headers: authHeaders(token) });
}

export async function seedMockData(token: string) {
  return apiFetch('/api/admin/seed-mock-data', {
    method: 'POST',
    headers: authHeaders(token),
  });
}

// ============================================
// ADMIN — APPLICATION BROWSER
// ============================================

export async function getAdminApplications(token: string, filters?: { status?: string; bank_id?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.bank_id) params.set('bank_id', filters.bank_id);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(`/api/admin/applications${qs}`, { headers: authHeaders(token) });
}

// ============================================
// BANK — APPLICATIONS (Officer + Supervisor)
// ============================================

export async function getBankApplications(token: string, status?: string) {
  const qs = status ? `?status=${status}` : '';
  return apiFetch(`/api/bank/applications${qs}`, { headers: authHeaders(token) });
}

export async function getApplicationDetail(token: string, appId: string) {
  return apiFetch(`/api/bank/applications/${appId}`, { headers: authHeaders(token) });
}

export async function adminGetApplicationDetail(token: string, appId: string) {
  return apiFetch(`/api/admin/applications/${appId}`, { headers: authHeaders(token) });
}

export async function officerApprove(token: string, appId: string, notes?: string) {
  return apiFetch(`/api/bank/applications/${appId}/officer-approve`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function officerReject(token: string, appId: string, notes?: string, rejection_reason?: string) {
  return apiFetch(`/api/bank/applications/${appId}/officer-reject`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes, rejection_reason }),
  });
}

// ============================================
// BANK — SUPERVISOR ACTIONS
// ============================================

export async function getSupervisorApplications(token: string) {
  return apiFetch('/api/bank/supervisor/applications', { headers: authHeaders(token) });
}

export async function supervisorApprove(token: string, appId: string, notes?: string) {
  return apiFetch(`/api/bank/applications/${appId}/supervisor-approve`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function supervisorReject(token: string, appId: string, notes?: string, rejection_reason?: string) {
  return apiFetch(`/api/bank/applications/${appId}/supervisor-reject`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes, rejection_reason }),
  });
}

export async function requestDocuments(token: string, appId: string, notes?: string) {
  return apiFetch(`/api/bank/applications/${appId}/request-documents`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

export async function initiateDisbursement(token: string, appId: string, notes?: string) {
  return apiFetch(`/api/bank/applications/${appId}/disburse`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ notes }),
  });
}

// ============================================
// LEGACY ADMIN ENDPOINTS (kept for backwards compat)
// ============================================

export async function getApplications(token: string, status?: string) {
  const url = status ? `/api/admin/applications?status=${status}` : '/api/admin/applications';
  return apiFetch(url, { headers: authHeaders(token) });
}

export async function reviewApplication(token: string, id: string, action: string, notes?: string, rejection_reason?: string) {
  return apiFetch('/api/admin/review', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ application_id: id, action, notes, rejection_reason }),
  });
}

// ============================================
// FORM OPERATIONS (unchanged)
// ============================================

export async function uploadDocument(token: string, documentType: string, file: File) {
  const formData = new FormData();
  formData.append('token', token);
  formData.append('document_type', documentType);
  formData.append('file', file);
  const res = await fetch(`${API_URL}/api/upload-document`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Upload failed');
  return data;
}

export async function verifyPAN(token: string, pan: string) {
  return apiFetch(`/api/verify-pan?token=${token}&pan_number=${pan}`, { method: 'POST' });
}

export async function verifyAadhaar(token: string, aadhaar: string) {
  return apiFetch(`/api/verify-aadhaar?token=${token}&aadhaar_number=${aadhaar}`, { method: 'POST' });
}

export async function submitForm(token: string) {
  return apiFetch(`/api/submit-form?token=${token}`, { method: 'POST' });
}

// ============================================
// CODE LIST (API Dropdown Options)
// ============================================

export async function getCodeList(sqlMstId: number, param?: string): Promise<{status: string, data: {code_mst_id: string, code_desc: string}[], fallback: boolean}> {
  const qs = param ? `?param=${encodeURIComponent(param)}` : '';
  const res = await fetch(`${API_URL}/api/code-list/${sqlMstId}${qs}`);
  return res.json();
}

// ============================================
// UTILITIES
// ============================================

export function formatCurrency(amount: number) {
  return `₹${amount.toLocaleString('en-IN')}`;
}

export function formatDate(date: string) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(date: string) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function validatePANFormat(pan: string) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan);
}

export function validateAadhaarFormat(aadhaar: string) {
  return /^\d{12}$/.test(aadhaar);
}

export function maskPAN(pan: string) {
  if (!pan || pan.length < 4) return pan;
  return pan.slice(0, 2) + '***' + pan.slice(-2);
}

export function maskAadhaar(aadhaar: string) {
  if (!aadhaar) return '';
  return 'XXXX XXXX ' + aadhaar.slice(-4);
}

// Status display helpers
export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  system_reviewed: 'Reviewed',
  officer_approved: 'Officer Approved',
  officer_rejected: 'Rejected',
  documents_submitted: 'Documents Submitted',
  approved: 'Approved',
  supervisor_rejected: 'Rejected',
};

export const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  system_reviewed: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  officer_approved: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  officer_rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  documents_submitted: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  supervisor_rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

export const SUGGESTION_COLORS: Record<string, string> = {
  approve: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  deny: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  review: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
};
