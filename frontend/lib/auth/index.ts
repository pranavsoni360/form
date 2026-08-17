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

// Merge the Bearer access token for a role into a headers object. Use on raw
// fetch() calls (e.g. the /ops/* pages) that send `credentials:"include"` but
// must ALSO present the access token so the backend can authenticate/scope the
// request. No-op (returns `extra` unchanged) when no token is stored.
export function authHeader(
  type: AuthType,
  extra: Record<string, string> = {},
): Record<string, string> {
  const token = getAccessToken(type);
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

// Decode a JWT payload WITHOUT verifying the signature. This is a client-side
// convenience only (to read `exp`); the backend remains the real authority.
// Returns null for a malformed token.
function decodeJwtPayload(token: string): any | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// True when the token is missing, malformed, or past its `exp`. Used by route
// guards so an expired/stale token can't slip past a mere presence check.
export function isTokenExpired(token: string | null | undefined): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp * 1000 <= Date.now();
}

export function setAccessToken(type: AuthType, token: string): void {
  localStorage.setItem(TOKEN_KEYS[type], token);
  notifyAuthChange(type, "login");
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
  notifyAuthChange(type, "logout");
}

// ── Auth-change broadcast (for RealtimeProvider, etc.) ──────
// The RealtimeProvider mounts before the user has logged in, so it sees no
// token in localStorage and stays in "closed" state. Without a signal it
// never re-attempts — the user has to hard-refresh after login to get SSE.
//
// We fire a custom DOM event here on every login/logout. Listeners in the
// same tab pick it up via window.addEventListener("los-auth-changed", ...).
// (The native `storage` event only fires in OTHER tabs, not the writer, so
// it's not enough on its own.)
export const AUTH_CHANGED_EVENT = "los-auth-changed";

function notifyAuthChange(type: AuthType, action: "login" | "logout"): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(AUTH_CHANGED_EVENT, { detail: { type, action } }),
    );
  } catch {
    // Old browsers without CustomEvent constructor — fall back to a plain Event.
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  }
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

// ── Route-guard helper ───────────────────────────────────────
// Returns a usable access token for `type`, or null if the visitor is not
// authenticated. If the stored token is missing or expired, it attempts one
// silent refresh via the httpOnly refresh cookie (same path authFetch uses),
// so an active session (30-min access token, 9-hour refresh cookie) is NOT
// bounced to login just because the short-lived access token lapsed. Only when
// the refresh also fails do we clear state and report "not authenticated" —
// that's the signal for a guard to redirect to the login page.
export async function ensureValidToken(type: AuthType): Promise<string | null> {
  const token = getAccessToken(type);
  if (token && !isTokenExpired(token)) return token;
  if (!refreshing) refreshing = silentRefresh();
  const newToken = await refreshing;
  refreshing = null;
  if (newToken) {
    setAccessToken(type, newToken);
    return newToken;
  }
  clearAuth(type);
  return null;
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
