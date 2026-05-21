// lib/auth/index.ts — token + user storage + authenticated fetch with silent
// refresh. AuthType now includes 'vendor' (was 'admin' | 'bank' only).
//
// Existing imports `import { getAccessToken } from '@/lib/auth'` continue to
// work — the file moved into a folder + index.ts barrel.

import { API_URL } from "@/lib/api";
import type { AuthType } from "./roles";
import { TOKEN_KEYS, USER_KEYS, LOGIN_PATHS } from "./roles";

// ── Token + user storage ─────────────────────────────────────

export function getAccessToken(type: AuthType): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEYS[type]);
}

export function setAccessToken(type: AuthType, token: string): void {
  localStorage.setItem(TOKEN_KEYS[type], token);
}

export function getCurrentUser(type: AuthType): any | null {
  if (typeof window === "undefined") return null;
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

// ── Silent refresh (single-flight) ───────────────────────────

let refreshing: Promise<string | null> | null = null;

async function silentRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: "POST",
      credentials: "include", // sends httpOnly refresh cookie
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null;
  } catch {
    return null;
  }
}

// ── Auth fetch wrapper ───────────────────────────────────────

export async function authFetch(
  path: string,
  options: RequestInit = {},
  type: AuthType,
): Promise<any> {
  const token = getAccessToken(type);
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!headers["Content-Type"] && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  let res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  if (res.status === 401) {
    if (!refreshing) refreshing = silentRefresh();
    const newToken = await refreshing;
    refreshing = null;

    if (newToken) {
      setAccessToken(type, newToken);
      headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(`${API_URL}${path}`, {
        ...options,
        headers,
        credentials: "include",
      });
    } else {
      clearAuth(type);
      if (typeof window !== "undefined") {
        window.location.href = LOGIN_PATHS[type];
      }
      throw new Error("Session expired. Please log in again.");
    }
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Request failed");
  return data;
}

// ── Logout ───────────────────────────────────────────────────

export async function logout(type: AuthType): Promise<void> {
  try {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // best effort — clear local state regardless
  }
  clearAuth(type);
}

// ── Re-exports for ergonomics ────────────────────────────────

export type { AuthType };
export {
  TOKEN_KEYS,
  USER_KEYS,
  LOGIN_PATHS,
  DASHBOARD_PATHS,
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
} from "./roles";
export type { Role } from "./roles";
