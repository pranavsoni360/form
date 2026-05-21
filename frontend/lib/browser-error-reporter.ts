// lib/browser-error-reporter.ts
//
// Installs window listeners that POST every uncaught browser error to the
// backend's /api/internal/frontend-error endpoint. From there events flow
// to the same event_bus "errors" topic that /ops/errors reads, so browser
// crashes appear in the same single-pane-of-glass as backend / agent /
// livekit / sip / docker / postgres errors.
//
// Sentry still captures errors separately (it's our long-term archive).
// This reporter exists so the LIVE /ops/errors view doesn't need a Sentry
// roundtrip to show what just broke in someone's browser.
//
// Design:
//   - Listen to window.error AND window.unhandledrejection — covers thrown
//     errors, async failures, React renders that escape error boundaries
//   - Deduplicate by (message, file, line) within a 10s window so a noisy
//     loop doesn't spam the endpoint
//   - Best-effort: never throw, never block, never await — fire-and-forget
//   - Read auth token from localStorage on each post (silent if no token)
//   - Use fetch with keepalive so the post survives page unload
//
// Wire-up: import installBrowserErrorReporter() from app/layout.tsx
// (a client component) so it runs once per tab.

import { API_URL } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";

const ENDPOINT = "/api/internal/frontend-error";
const DEDUP_WINDOW_MS = 10_000;
const MAX_TRACE_LEN = 4_000;
const MAX_MESSAGE_LEN = 500;

// We share dedup state across both listeners so the same error reported via
// `error` + `unhandledrejection` only goes once.
const seen = new Map<string, number>();

function pickToken(): string | null {
  // Whichever portal the user is in — admin/bank/vendor.
  return getAccessToken("admin") || getAccessToken("bank") || getAccessToken("vendor");
}

function shouldSkip(key: string): boolean {
  const now = Date.now();
  // Sweep old entries opportunistically.
  if (seen.size > 100) {
    for (const [k, t] of seen) {
      if (now - t > DEDUP_WINDOW_MS) seen.delete(k);
    }
  }
  const last = seen.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  seen.set(key, now);
  return false;
}

function post(payload: Record<string, unknown>): void {
  try {
    const token = pickToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    // keepalive lets the request survive an immediate page unload.
    fetch(`${API_URL}${ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {
      /* never block UI on reporter failure */
    });
  } catch {
    /* report itself cannot throw */
  }
}

function trimMessage(s: unknown): string {
  return String(s ?? "").slice(0, MAX_MESSAGE_LEN);
}

function trimTrace(s: unknown): string | undefined {
  if (s === undefined || s === null) return undefined;
  return String(s).slice(0, MAX_TRACE_LEN);
}

let installed = false;

/**
 * Mount the listeners. Safe to call multiple times — only the first call
 * installs handlers. Call from a client component near the root of the tree.
 */
export function installBrowserErrorReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (ev: ErrorEvent) => {
    const msg = trimMessage(ev.message || (ev.error && ev.error.message));
    if (!msg) return;
    const key = `e:${msg}|${ev.filename || "?"}:${ev.lineno || 0}`;
    if (shouldSkip(key)) return;
    post({
      exc_type: (ev.error && ev.error.name) || "Error",
      message: msg,
      route: window.location.pathname,
      trace: trimTrace(ev.error && ev.error.stack),
      metadata: {
        file: ev.filename || null,
        line: ev.lineno || null,
        col: ev.colno || null,
        userAgent: navigator.userAgent.slice(0, 200),
      },
      level: "error",
    });
  });

  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    const msg = trimMessage(
      reason && typeof reason === "object"
        ? reason.message || JSON.stringify(reason)
        : reason,
    );
    if (!msg) return;
    const key = `r:${msg}`;
    if (shouldSkip(key)) return;
    post({
      exc_type: (reason && reason.name) || "UnhandledRejection",
      message: msg,
      route: window.location.pathname,
      trace: trimTrace(reason && reason.stack),
      metadata: { userAgent: navigator.userAgent.slice(0, 200) },
      level: "error",
    });
  });
}

/**
 * Manually report an error from a try/catch or an error boundary.
 * Goes through the same pipeline so /ops/errors stays comprehensive.
 */
export function reportBrowserError(
  err: unknown,
  context?: { route?: string; metadata?: Record<string, unknown> },
): void {
  const e = err as { message?: string; name?: string; stack?: string };
  const msg = trimMessage(e?.message ?? err);
  if (!msg) return;
  const key = `m:${msg}`;
  if (shouldSkip(key)) return;
  post({
    exc_type: e?.name || "ReportedError",
    message: msg,
    route: context?.route || (typeof window !== "undefined" ? window.location.pathname : undefined),
    trace: trimTrace(e?.stack),
    metadata: { ...context?.metadata, userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : undefined },
    level: "error",
  });
}
