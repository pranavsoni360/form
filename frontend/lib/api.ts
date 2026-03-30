const API_URL = 'https://virtualvaani.vgipl.com:8200';

export async function adminLogin(email: string, password: string) {
  const res = await fetch(`${API_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Login failed');
  return data;
}

export async function getApplications(token: string, status?: string) {
  const url = status ? `${API_URL}/api/admin/applications?status=${status}` : `${API_URL}/api/admin/applications`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Failed to fetch');
  return data;
}

export async function reviewApplication(token: string, id: string, action: string, notes?: string, rejection_reason?: string) {
  const res = await fetch(`${API_URL}/api/admin/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ application_id: id, action, notes, rejection_reason }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Review failed');
  return data;
}

export function formatCurrency(amount: number) {
  return `₹${amount.toLocaleString('en-IN')}`;
}

export function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-IN');
}

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

export function validatePANFormat(pan: string) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan);
}

export function validateAadhaarFormat(aadhaar: string) {
  return /^\d{12}$/.test(aadhaar);
}

export async function verifyPAN(token: string, pan: string) {
  const res = await fetch(`${API_URL}/api/verify-pan?token=${token}&pan_number=${pan}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'PAN verification failed');
  return data;
}

export async function verifyAadhaar(token: string, aadhaar: string) {
  const res = await fetch(`${API_URL}/api/verify-aadhaar?token=${token}&aadhaar_number=${aadhaar}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Aadhaar verification failed');
  return data;
}

export async function submitForm(token: string) {
  const res = await fetch(`${API_URL}/api/submit-form?token=${token}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Submission failed');
  return data;
}

export function maskPAN(pan: string) {
  if (!pan || pan.length < 4) return pan;
  return pan.slice(0, 2) + '***' + pan.slice(-2);
}

export function maskAadhaar(aadhaar: string) {
  if (!aadhaar) return '';
  return 'XXXX XXXX ' + aadhaar.slice(-4);
}