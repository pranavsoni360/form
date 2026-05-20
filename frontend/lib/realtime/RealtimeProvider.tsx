"use client";

/**
 * RealtimeProvider — single shared EventSource for the whole tab.
 *
 * Phase 0 ships this as a STUB so the AppShell can render a connection-state
 * pill from day one. Phase 1 wires the actual EventSource against
 * /api/realtime/events once the backend SSE endpoint is built.
 *
 * Contract (locked):
 *   useRealtimeConnection() → { state: "connecting"|"open"|"closed"|"error", lastEventAt }
 *   useEventStream<T>(topic, reducer, initial) → T (Phase 1)
 */

import * as React from "react";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

interface RealtimeContextValue {
  state: ConnectionState;
  lastEventAt: number | null;
}

const RealtimeContext = React.createContext<RealtimeContextValue>({
  state: "closed",
  lastEventAt: null,
});

interface RealtimeProviderProps {
  children: React.ReactNode;
  /** Topics to subscribe to. Ignored in Phase 0 stub. */
  topics?: ReadonlyArray<"calls" | "phones" | "workers" | "errors" | "batches">;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  // Phase 0 stub: report "closed" — UI badge will read "offline".
  // Phase 1 will replace this with real EventSource lifecycle.
  const value = React.useMemo<RealtimeContextValue>(
    () => ({ state: "closed", lastEventAt: null }),
    []
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeConnection(): RealtimeContextValue {
  return React.useContext(RealtimeContext);
}
