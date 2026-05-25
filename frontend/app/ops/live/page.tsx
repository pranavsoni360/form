"use client";

import * as React from "react";
import { Radio } from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/shared/StatusPill";
import { LiveCallCard } from "@/components/ops/LiveCallCard";
import { API_URL } from "@/lib/api";
import { useEventStream } from "@/lib/realtime/useEventStream";
import { useRealtimeConnection } from "@/lib/realtime/RealtimeProvider";
import {
  callsReducer,
  initialCallsState,
  removeCall,
  type CallsState,
} from "@/lib/realtime/reducers";
import type { RealtimeEvent } from "@/lib/realtime/RealtimeProvider";

/**
 * REST seed for the live page. SSE `calls` topic has no history replay
 * (each event is delta-only), so a user landing on /ops/live mid-call would
 * see an empty grid even though the dispatcher is actively running calls.
 * Fetch every row currently in 'Calling' status and feed them through the
 * same reducer as a `call_state` event — the SSE handler's dedup-by-call_id
 * means the live `completed`/`failed` events that arrive later cleanly
 * supersede the seeded `calling` entries.
 */
async function seedInFlightCalls(): Promise<RealtimeEvent[]> {
  try {
    const res = await fetch(`${API_URL}/api/ops/in-flight-calls?_t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.calls ?? []) as RealtimeEvent[];
  } catch {
    return [];
  }
}

/**
 * /ops/live — Live Call Monitor.
 *
 * Initial state seeded via /api/ops/in-flight-calls so cards appear instantly
 * on navigation even mid-call. SSE `calls` topic delivers state transitions
 * (dispatching → completed/failed) on top of the seed. Terminal-state cards
 * linger ~6s so users see the outcome flash before vanishing.
 */
export default function OpsLivePage() {
  const calls = useEventStream<CallsState>(
    "calls",
    callsReducer,
    initialCallsState,
    { seed: seedInFlightCalls },
  );
  const { state: connState } = useRealtimeConnection();

  // Terminal-state cleanup: keep completed/failed cards visible for 6s,
  // then remove them so the grid doesn't pile up infinitely.
  const [tombstone, setTombstone] = React.useState<CallsState>(initialCallsState);
  const removalTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  React.useEffect(() => {
    Object.entries(calls.byId).forEach(([id, entry]) => {
      const isTerminal = entry.status === "completed" || entry.status === "failed";
      if (isTerminal && !removalTimersRef.current[id]) {
        removalTimersRef.current[id] = setTimeout(() => {
          setTombstone((prev) => removeCall(prev, id));
          delete removalTimersRef.current[id];
        }, 6000);
      }
    });
    setTombstone(calls);
    // Cleanup timers on unmount
    return () => {
      // intentionally not clearing timers on every render — they're cheap
      // and the unmount cleanup happens via the outer effect below.
    };
  }, [calls]);

  React.useEffect(() => {
    const timers = removalTimersRef.current;
    return () => {
      Object.values(timers).forEach((t) => clearTimeout(t));
    };
  }, []);

  const visible = Object.values(tombstone.byId);
  // Active (non-terminal) calls first, then recently-completed
  const active = visible.filter((c) => c.status === "dispatching" || c.status === "calling");
  const terminal = visible.filter((c) => c.status === "completed" || c.status === "failed");
  const sortedActive = active.sort((a, b) => b.started_at - a.started_at);
  const sortedTerminal = terminal.sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
  const all = [...sortedActive, ...sortedTerminal];

  return (
    <AppShell
      title="Live Calls"
      subtitle={`${active.length} active · ${terminal.length} completing · realtime SSE`}
    >
      <div className="mx-auto max-w-7xl space-y-6">
        <Card>
          <CardHeader className="flex-row items-center justify-between pb-4">
            <div>
              <CardTitle>Active calls</CardTitle>
              <CardDescription>
                Cards appear the moment the dispatcher picks a call up. They
                stay 6 seconds after completion so you see the outcome.
              </CardDescription>
            </div>
            <StatusPill
              tone={
                connState === "open"
                  ? "success"
                  : connState === "connecting"
                  ? "warning"
                  : connState === "error"
                  ? "danger"
                  : "neutral"
              }
              label={
                connState === "open"
                  ? `Live · ${active.length}`
                  : connState === "connecting"
                  ? "Connecting"
                  : connState === "error"
                  ? "Disconnected"
                  : "Offline"
              }
            />
          </CardHeader>
          <CardContent>
            {all.length === 0 ? (
              <EmptyState connectionState={connState} />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {all.map((call) => (
                  <LiveCallCard key={call.call_id} call={call} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function EmptyState({ connectionState }: { connectionState: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-border/50 bg-muted/10 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-muted/40">
          <Radio className="h-5 w-5 text-muted-foreground" />
        </span>
        <div className="space-y-1">
          <div className="text-sm font-medium">No active calls</div>
          <div className="text-xs text-muted-foreground">
            {connectionState === "open"
              ? "Waiting for the dispatcher to pick up the next batch."
              : connectionState === "closed"
              ? "Not connected to the realtime stream. Log in to see live activity."
              : "Reconnecting to the realtime stream…"}
          </div>
        </div>
      </div>
    </div>
  );
}
