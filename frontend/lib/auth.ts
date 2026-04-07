import { API_URL } from './api';

type AuthType = 'admin' | 'bank';

const TOKEN_KEYS: Record<AuthType, string> = {
  admin: 'los_admin_token',
  bank: 'los_bank_token',
};

const USER_KEYS: Record<AuthType, string> = {
  admin: 'los_admin_user',
  bank: 'los_bank_user',
};

const LOGIN_PATHS: Record<AuthType, string> = {
  admin: '/admin/login',
  bank: '/bank/login',
};

// ── Token Management ──

export function getAccessToken(type: AuthType): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEYS[type]);
}

export function setAccessToken(type: AuthType, token: string): void {
  localStorage.setItem(TOKEN_KEYS[type], token);
}

export function getCurrentUser(type: AuthType): any | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEYS[type]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setCurrentUser(type: AuthType, user: any): void {
  localStorage.setItem(USER_KEYS[type], JSON.stringify(user));
}

export function clearAuth(type: AuthType): void {
  localStorage.removeItem(TOKEN_KEYS[type]);
  localStorage.removeItem(USER_KEYS[type]);
}

export function isLoggedIn(type: AuthType): boolean {
  return !!getAccessToken(type);
}

// ── Silent Refresh ──

let refreshing: Promise<string | null> | null = null;

async function silentRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include', // sends httpOnly cookies
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null;
  } catch {
    return null;
  }
}

// ── Auth Fetch Wrapper ──

export async function authFetch(
  path: string,
  options: RequestInit = {},
  type: AuthType
): Promise<any> {
  const token = getAccessToken(type);
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  let res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: 'include', // always send cookies for refresh
  });

  // If 401, try silent refresh once
  if (res.status === 401) {
    // Deduplicate concurrent refreshes
    if (!refreshing) {
      refreshing = silentRefresh();
    }
    const newToken = await refreshing;
    refreshing = null;

    if (newToken) {
      // Store new token and retry
      setAccessToken(type, newToken);
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(`${API_URL}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
    } else {
      // Refresh failed — clear auth and redirect to login
      clearAuth(type);
      if (typeof window !== 'undefined') {
        window.location.href = LOGIN_PATHS[type];
      }
      throw new Error('Session expired. Please log in again.');
    }
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

// ── Logout ──

export async function logout(type: AuthType): Promise<void> {
  try {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Best effort — clear local state regardless
  }
  clearAuth(type);
}
