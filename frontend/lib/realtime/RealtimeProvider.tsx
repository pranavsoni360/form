"use client";

/**
 * RealtimeProvider — single shared EventSource for the tab.
 *
 * Lifecycle:
 *   1. On mount, look up an admin or bank session JWT from localStorage.
 *      If neither exists → stay in "closed" state (visitor not logged in).
 *   2. POST /api/realtime/stream-token with that JWT → receive a short-lived
 *      SSE-scoped JWT + the topics this user is allowed to subscribe to.
 *   3. Open EventSource at /api/realtime/events with `token=…&topics=…`.
 *   4. Fan every event out to registered subscribers via the context.
 *   5. Refresh the SSE token at (expires_in - 60) seconds — closes the
 *      current EventSource and re-connects with a fresh token.
 *   6. On unexpected error: exponential backoff (1s, 2s, 4s, 8s, 16s, 30s).
 *
 * Consumers use `useEventStream(...)` or `useRealtimeConnection()` —
 * they don't touch the EventSource directly.
 */

import * as React from "react";
import { API_URL } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export type RealtimeEvent = {
  type: string;
  topic?: string;
  ts?: number;
  [k: string]: unknown;
};

type Listener = (event: RealtimeEvent) => void;

const ALL_TOPICS = ["calls", "phones", "workers", "errors", "batches"] as const;
const STREAM_TOKEN_REFRESH_BEFORE_EXPIRY_S = 60;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

interface ContextValue {
  state: ConnectionState;
  lastEventAt: number | null;
  /** Subscribe to all events. Returns unsubscribe fn. */
  subscribe: (listener: Listener) => () => void;
  /** Total topics the current session is allowed to receive. */
  allowedTopics: ReadonlyArray<string>;
}

const RealtimeContext = React.createContext<ContextValue>({
  state: "closed",
  lastEventAt: null,
  subscribe: () => () => {},
  allowedTopics: [],
});

export interface RealtimeProviderProps {
  children: React.ReactNode;
  /** Topics to request. Intersected server-side with what the JWT allows. */
  topics?: ReadonlyArray<(typeof ALL_TOPICS)[number]>;
}

export function RealtimeProvider({
  children,
  topics = ALL_TOPICS,
}: RealtimeProviderProps) {
  const [state, setState] = React.useState<ConnectionState>("closed");
  const [allowedTopics, setAllowedTopics] = React.useState<ReadonlyArray<string>>([]);
  // lastEventAt is mutated on every event → use a ref + a setter that updates
  // a tiny React state only when consumers actually need to re-render.
  const lastEventAtRef = React.useRef<number | null>(null);
  const [lastEventAt, setLastEventAt] = React.useState<number | null>(null);
  // Throttle "last event" UI updates to avoid re-rendering everything on
  // bursty traffic. The connection-dot only cares within ~1s precision.
  const lastEventThrottleRef = React.useRef<number>(0);

  const listenersRef = React.useRef<Set<Listener>>(new Set());
  const subscribe = React.useCallback((l: Listener) => {
    listenersRef.current.add(l);
    return () => {
      listenersRef.current.delete(l);
    };
  }, []);

  const topicsKey = React.useMemo(() => topics.join(","), [topics]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    let es: EventSource | null = null;
    let refreshTimer: number | null = null;
    let reconnectIndex = 0;

    const cleanup = () => {
      if (es) {
        es.close();
        es = null;
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectIndex, RECONNECT_BACKOFF_MS.length - 1)];
      reconnectIndex += 1;
      window.setTimeout(() => {
        if (!cancelled) connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled) return;
      cleanup();

      const sessionToken = getAccessToken("admin") || getAccessToken("bank");
      if (!sessionToken) {
        // No login → stay closed. Don't spam the server.
        setState("closed");
        setAllowedTopics([]);
        return;
      }

      setState("connecting");
      try {
        const res = await fetch(`${API_URL}/api/realtime/stream-token`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sessionToken}` },
          credentials: "include",
        });
        if (cancelled) return;
        if (!res.ok) {
          // 401 = session expired; 403 = role not allowed → stay closed
          setState(res.status === 401 ? "closed" : "error");
          if (res.status >= 500) scheduleReconnect();
          return;
        }
        const data = (await res.json()) as {
          token: string;
          expires_in: number;
          allowed_topics: string[];
        };
        if (cancelled) return;

        setAllowedTopics(data.allowed_topics);
        const effective = topics.filter((t) => data.allowed_topics.includes(t));
        if (effective.length === 0) {
          setState("closed");
          return;
        }

        const url = `${API_URL}/api/realtime/events?token=${encodeURIComponent(
          data.token
        )}&topics=${effective.join(",")}`;
        es = new EventSource(url);

        es.onopen = () => {
          if (cancelled) return;
          reconnectIndex = 0;
          setState("open");
        };

        es.onmessage = (msg) => {
          if (cancelled) return;
          let event: RealtimeEvent;
          try {
            event = JSON.parse(msg.data) as RealtimeEvent;
          } catch (e) {
            console.warn("SSE parse error", e, msg.data);
            return;
          }
          const now = Date.now();
          lastEventAtRef.current = now;
          // Throttle UI-visible "last seen" to once/second.
          if (now - lastEventThrottleRef.current > 1000) {
            lastEventThrottleRef.current = now;
            setLastEventAt(now);
          }
          listenersRef.current.forEach((l) => {
            try {
              l(event);
            } catch (err) {
              console.error("Realtime listener threw", err);
            }
          });
        };

        es.onerror = () => {
          if (cancelled) return;
          // EventSource fires `error` on any disconnect — including the
          // backend's planned 25-min auto-close. Reconnect via fresh token.
          if (es && es.readyState === EventSource.CLOSED) {
            setState("error");
            scheduleReconnect();
          }
        };

        // Refresh token a minute before it expires (auto-disconnects + new
        // connect cycle, no visible blip if everything's healthy).
        const refreshInMs = (data.expires_in - STREAM_TOKEN_REFRESH_BEFORE_EXPIRY_S) * 1000;
        if (refreshInMs > 0) {
          refreshTimer = window.setTimeout(() => {
            if (cancelled) return;
            connect();
          }, refreshInMs);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("RealtimeProvider connect failed", e);
        setState("error");
        scheduleReconnect();
      }
    };

    connect();

    // Reconnect when the tab regains focus after sleep — desktops do this
    // routinely and EventSource often won't recover on its own.
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && (state === "closed" || state === "error")) {
        connect();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicsKey]);

  const value = React.useMemo<ContextValue>(
    () => ({ state, lastEventAt, subscribe, allowedTopics }),
    [state, lastEventAt, subscribe, allowedTopics]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeConnection() {
  return React.useContext(RealtimeContext);
}

/**
 * Low-level: subscribe to every event. Most consumers should use
 * useEventStream() (in ./useEventStream.ts) which adds topic filtering +
 * a reducer over state.
 */
export function useRealtimeSubscribe(handler: Listener) {
  const { subscribe } = React.useContext(RealtimeContext);
  React.useEffect(() => subscribe(handler), [subscribe, handler]);
}

// Internal: exported for use by useEventStream.ts
export { RealtimeContext };
