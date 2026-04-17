// Unified API client for LOS v3 portals.
// - Access tokens live in-memory only (XSS-safe).
// - Refresh tokens travel as httpOnly cookies via /api/auth/refresh.

let accessToken: string | null = null
let refreshPromise: Promise<string | null> | null = null

export const API_URL = (() => {
  if (typeof window === 'undefined') return ''
  if (window.location.hostname === 'localhost') return ''  // use Vite proxy
  return import.meta.env.VITE_API_URL || ''
})()

export function setAccessToken(token: string | null) {
  accessToken = token
}
export function getAccessToken() {
  return accessToken
}

async function silentRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    try {
      const resp = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!resp.ok) return null
      const data = await resp.json()
      accessToken = data.token || null
      return accessToken
    } catch {
      return null
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const doFetch = async (token: string | null) => {
    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json')
    }
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' })
  }

  let resp = await doFetch(accessToken)
  if (resp.status === 401 && accessToken) {
    const fresh = await silentRefresh()
    if (fresh) resp = await doFetch(fresh)
  }
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`
    try {
      const body = await resp.json()
      detail = body.detail || detail
    } catch { /* non-JSON */ }
    throw new Error(detail)
  }
  if (resp.status === 204) return null as T
  return resp.json() as Promise<T>
}

// ─────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────
export type User = {
  id: string
  username: string
  email: string | null
  name: string | null
  role: 'admin' | 'bank_user' | 'vendor_user' | 'customer'
  is_active: boolean
  bank_id?: string
  bank_name?: string
  bank_code?: string
  vendor_id?: string
  vendor_name?: string
  vendor_code?: string
}

export async function adminLogin(email: string, password: string) {
  const data = await apiFetch<{ token: string; user: User }>('/api/auth/admin-login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  accessToken = data.token
  return data
}

export async function portalLogin(username: string, password: string, portal: 'bank' | 'vendor') {
  const data = await apiFetch<{ token: string; user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, portal }),
  })
  accessToken = data.token
  return data
}

export async function fetchMe() {
  return apiFetch<User>('/api/auth/me')
}

export async function logout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
  accessToken = null
}

export async function restoreSession(): Promise<User | null> {
  const token = await silentRefresh()
  if (!token) return null
  try {
    return await fetchMe()
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────
export const adminApi = {
  stats:          () => apiFetch<any>('/api/admin/stats'),
  banks:          () => apiFetch<{ banks: any[] }>('/api/admin/banks'),
  bank:           (id: string) => apiFetch<{ bank: any }>(`/api/admin/banks/${id}`),
  createBank:     (b: any) => apiFetch<{ bank: any }>('/api/admin/banks', { method: 'POST', body: JSON.stringify(b) }),
  updateBank:     (id: string, b: any) => apiFetch<{ bank: any }>(`/api/admin/banks/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  createBankUser: (bankId: string, u: any) => apiFetch<{ user: any }>(`/api/admin/banks/${bankId}/users`, { method: 'POST', body: JSON.stringify(u) }),
  updateUser:     (id: string, u: any) => apiFetch<{ user: any }>(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(u) }),
  deactivateUser: (id: string) => apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' }),
  vendors:        (bankId?: string) => apiFetch<{ vendors: any[] }>(`/api/admin/vendors${bankId ? `?bank_id=${bankId}` : ''}`),
  vendor:         (id: string) => apiFetch<{ vendor: any }>(`/api/admin/vendors/${id}`),
  createVendor:   (v: any) => apiFetch<{ vendor: any }>('/api/admin/vendors', { method: 'POST', body: JSON.stringify(v) }),
  updateVendor:   (id: string, v: any) => apiFetch<{ vendor: any }>(`/api/admin/vendors/${id}`, { method: 'PUT', body: JSON.stringify(v) }),
  deactivateVendor: (id: string) => apiFetch(`/api/admin/vendors/${id}`, { method: 'DELETE' }),
  createVendorUser: (vendorId: string, u: any) => apiFetch<{ user: any }>(`/api/admin/vendors/${vendorId}/users`, { method: 'POST', body: JSON.stringify(u) }),
  applications:   (filters: { status?: string; bank_id?: string; vendor_id?: string } = {}) => {
    const qs = new URLSearchParams(filters as any).toString()
    return apiFetch<{ applications: any[] }>(`/api/admin/applications${qs ? `?${qs}` : ''}`)
  },
  application:    (id: string) => apiFetch<{ application: any; timeline: any[] }>(`/api/admin/applications/${id}`),
  seedMockData:   () => apiFetch<any>('/api/admin/seed-mock-data', { method: 'POST' }),
}

// ─────────────────────────────────────────────────────────────
// Portal (bank + vendor, role-aware server-side)
// ─────────────────────────────────────────────────────────────
export const portalApi = {
  applications: (status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : ''
    return apiFetch<{ applications: any[] }>(`/api/portal/applications${qs}`)
  },
  application:  (id: string) => apiFetch<{ application: any }>(`/api/portal/applications/${id}`),
  approve:      (id: string, notes?: string) =>
    apiFetch(`/api/portal/applications/${id}/approve`, { method: 'POST', body: JSON.stringify({ notes }) }),
  reject:       (id: string, rejection_reason: string, notes?: string) =>
    apiFetch(`/api/portal/applications/${id}/reject`, { method: 'POST', body: JSON.stringify({ notes, rejection_reason }) }),
  requestDocs:  (id: string, notes?: string) =>
    apiFetch(`/api/portal/applications/${id}/request-documents`, { method: 'POST', body: JSON.stringify({ notes }) }),
  disburse:     (id: string, notes?: string) =>
    apiFetch(`/api/portal/applications/${id}/disburse`, { method: 'POST', body: JSON.stringify({ notes }) }),

  // Bank-only vendor management
  vendors:         () => apiFetch<{ vendors: any[]; vendor_limit: number; vendor_count: number }>('/api/portal/vendors'),
  vendor:          (id: string) => apiFetch<{ vendor: any }>(`/api/portal/vendors/${id}`),
  createVendor:    (v: any) => apiFetch<{ vendor: any }>('/api/portal/vendors', { method: 'POST', body: JSON.stringify(v) }),
  updateVendor:    (id: string, v: any) => apiFetch<{ vendor: any }>(`/api/portal/vendors/${id}`, { method: 'PUT', body: JSON.stringify(v) }),
  deactivateVendor:(id: string) => apiFetch(`/api/portal/vendors/${id}`, { method: 'DELETE' }),
  createVendorUser:(vendorId: string, u: any) => apiFetch<{ user: any }>(`/api/portal/vendors/${vendorId}/users`, { method: 'POST', body: JSON.stringify(u) }),

  // Calls
  calls:           (status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : ''
    return apiFetch<{ calls: any[] }>(`/api/portal/calls${qs}`)
  },
  call:            (id: string) => apiFetch<{ call: any }>(`/api/portal/calls/${id}`),
  initiateCall:    (payload: { customer_name: string; phone: string; loan_type?: string; loan_amount?: string; language?: string }) =>
    apiFetch<{ call: any }>('/api/portal/calls/single', { method: 'POST', body: JSON.stringify(payload) }),
}

// Admin calls
export const adminCallsApi = {
  list: (filters: { status?: string; bank_id?: string; vendor_id?: string } = {}) => {
    const qs = new URLSearchParams(filters as any).toString()
    return apiFetch<{ calls: any[] }>(`/api/admin/calls${qs ? `?${qs}` : ''}`)
  },
  get:  (id: string) => apiFetch<{ call: any }>(`/api/admin/calls/${id}`),
}

// Live transcript — uses fetch+ReadableStream to keep Bearer auth
export async function openLiveTranscript(
  callId: string,
  handlers: {
    onSnapshot?: (entries: any[]) => void
    onEntry?: (entry: any) => void
    onDone?: () => void
    onError?: (err: Error) => void
  },
): Promise<() => void> {
  const controller = new AbortController()
  const token = getAccessToken()
  const run = async () => {
    try {
      const resp = await fetch(`${API_URL}/api/live-transcript/${callId}`, {
        headers: { Authorization: `Bearer ${token || ''}` },
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) throw new Error(`Stream failed (${resp.status})`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        for (const ev of events) {
          if (!ev.trim() || ev.startsWith(':')) continue
          let name = 'message', data = ''
          for (const line of ev.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (!data) continue
          let parsed: any
          try { parsed = JSON.parse(data) } catch { continue }
          if (name === 'snapshot') handlers.onSnapshot?.(parsed)
          else if (name === 'transcript') handlers.onEntry?.(parsed)
          else if (name === 'done') { handlers.onDone?.(); return }
        }
      }
      handlers.onDone?.()
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') handlers.onError?.(err as Error)
    }
  }
  void run()
  return () => controller.abort()
}
