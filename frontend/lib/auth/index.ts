// lib/auth/index.ts
import { API_URL } from '@/lib/api/index';
import type { AuthType } from './roles';
import { TOKEN_KEYS, USER_KEYS, LOGIN_PATHS } from './roles';

// ── Token Management ──────────────────────────────────────

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
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

// ── Silent Refresh ────────────────────────────────────────

let refreshing: Promise<string | null> | null = null;

async function silentRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null;
  } catch {
    return null;
  }
}

// ── Auth Fetch Wrapper ────────────────────────────────────

export async function authFetch(
  path: string,
  options: RequestInit = {},
  type: AuthType
): Promise<any> {
  const token = getAccessToken(type);

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  let res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  // 401 → try silent refresh once
  if (res.status === 401) {
    if (!refreshing) refreshing = silentRefresh();
    const newToken = await refreshing;
    refreshing = null;

    if (newToken) {
      setAccessToken(type, newToken);
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(`${API_URL}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
    } else {
      // ── DEV: if token still exists in localStorage, don't wipe it ──
      // Silent refresh fails in dev because there's no httpOnly cookie.
      // Only clear and redirect if there was no token to begin with.
      const currentToken = getAccessToken(type);
      if (!currentToken) {
        if (typeof window !== 'undefined') {
          window.location.href = LOGIN_PATHS[type];
        }
        throw new Error('Session expired. Please log in again.');
      }
      // Token exists but refresh failed — throw so the caller can handle it
      throw new Error('401');
    }
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

// ── Logout ────────────────────────────────────────────────

export async function logout(type: AuthType): Promise<void> {
  try {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // best effort — clear local state regardless
  }
  clearAuth(type);
}

// Re-export types and constants for convenience
export type { AuthType };
export { TOKEN_KEYS, USER_KEYS, LOGIN_PATHS, DASHBOARD_PATHS } from './roles';
export { hasPermission, ROLE_PERMISSIONS } from './roles';