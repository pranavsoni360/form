"use client";

import { cn } from "@/lib/utils";
import { useRealtimeConnection } from "@/lib/realtime/RealtimeProvider";

/**
 * Tiny live-state dot used in the TopBar. Reads SSE connection state from
 * RealtimeProvider. In Phase 0 the provider reports "closed" — so the dot
 * shows offline until Phase 1 lights up the actual SSE.
 */
const STATE_META = {
  open: { color: "bg-success shadow-[0_0_8px] shadow-success/60", label: "Live" },
  connecting: { color: "bg-warning animate-pulse-dot", label: "Connecting" },
  closed: { color: "bg-muted-foreground/40", label: "Offline" },
  error: { color: "bg-destructive animate-pulse-dot", label: "Disconnected" },
} as const;

export function ConnectionDot({ className }: { className?: string }) {
  const { state } = useRealtimeConnection();
  const meta = STATE_META[state];
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs", className)}>
      <span className={cn("h-2 w-2 rounded-full", meta.color)} aria-hidden />
      <span className="text-muted-foreground">{meta.label}</span>
    </span>
  );
}
