"use client";

// Finix progress + live-state indicators (Job 2 extension — not in the handoff
// README, which had no long-running or streaming screen in Job 1).
//
// WHY THIS EXISTS: /bank/batch and the /ops/* screens are the first migrated
// pages whose primary content CHANGES WHILE YOU WATCH — a batch dials through
// rows, and the ops console streams over SSE. Two things have to be expressible:
// how far along a run is, and whether the live feed is actually connected.
// Without the second one a stalled stream looks identical to a quiet one, which
// is exactly the confusion the legacy ConnectionDot was added to prevent.
//
// Bar shapes reuse components/finix/Bar.tsx conventions (flat, 999px, token
// colours). Thresholds for utilisation are copied from the legacy
// components/ops/UtilizationBar so the colour means the same thing after the
// migration: <80% green, 80-99% amber, >=100% red.

import * as React from "react";
import { cn } from "@/lib/utils";
import type { FinixTone } from "./Pill";

/**
 * Determinate progress bar with an optional count label.
 * `value` is 0..1. Out-of-range values are clamped, so a backend that reports
 * 105% doesn't overflow the track.
 */
export function Progress({
  value,
  label,
  tone = "accent",
  height = 6,
  showPct = true,
  className,
}: {
  value: number;
  label?: React.ReactNode;
  tone?: Exclude<FinixTone, "neutral">;
  height?: number;
  showPct?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const shown = Math.round(pct * 100);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {(label != null || showPct) && (
        <div className="flex items-baseline gap-2">
          {label != null && <span className="text-[11px] text-fx-text3">{label}</span>}
          {showPct && <span className="fx-mono ml-auto text-[11px] text-fx-text2">{shown}%</span>}
        </div>
      )}
      <div
        className="w-full overflow-hidden rounded-full bg-fx-surface2"
        style={{ height }}
        role="progressbar"
        aria-valuenow={shown}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${pct * 100}%`, background: `var(--fx-${tone})` }}
        />
      </div>
    </div>
  );
}

/**
 * Indeterminate bar for work with no known total (an upload in flight, a
 * cleanup sweep). Animation is suppressed under prefers-reduced-motion by the
 * global rule in globals.css.
 */
export function IndeterminateBar({ height = 6, className }: { height?: number; className?: string }) {
  return (
    <div
      className={cn("w-full overflow-hidden rounded-full bg-fx-surface2", className)}
      style={{ height }}
      role="progressbar"
      aria-label="Working"
    >
      <div
        className="fx-indeterminate h-full rounded-full"
        style={{ width: "35%", background: "var(--fx-accent)" }}
      />
    </div>
  );
}

/**
 * Capacity meter for "3 / 5"-style cells. Thresholds match the legacy
 * components/ops/UtilizationBar exactly — the colour must not change meaning
 * across the migration.
 */
export function Utilization({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const raw = max > 0 ? (value / max) * 100 : 0;
  const tone = raw >= 100 ? "red" : raw >= 80 ? "amber" : "green";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="fx-mono shrink-0 text-[12px] text-fx-text2">
        {value} / {max}
      </span>
      <div className="h-[4px] min-w-[48px] flex-1 overflow-hidden rounded-full bg-fx-surface2">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: `var(--fx-${tone})` }} />
      </div>
    </div>
  );
}

/**
 * SSE / websocket connection state. States and labels mirror the legacy
 * components/shared/ConnectionDot so the migrated ops console reports live
 * status in the same words operators already know.
 */
export type LiveState = "open" | "connecting" | "closed" | "error";

const LIVE_META: Record<LiveState, { label: string; color: string; pulse: boolean }> = {
  open: { label: "Live", color: "var(--fx-green)", pulse: false },
  connecting: { label: "Connecting", color: "var(--fx-amber)", pulse: true },
  closed: { label: "Offline", color: "var(--fx-text3)", pulse: false },
  error: { label: "Disconnected", color: "var(--fx-red)", pulse: true },
};

export function LiveDot({ state, className }: { state: LiveState; className?: string }) {
  const meta = LIVE_META[state];
  return (
    <span className={cn("inline-flex items-center gap-2 text-[12px]", className)}>
      <span
        className={cn("h-[6px] w-[6px] rounded-full", meta.pulse && "fx-pulse")}
        style={{
          background: meta.color,
          boxShadow: state === "open" ? `0 0 8px ${meta.color}` : undefined,
        }}
        aria-hidden
      />
      <span className="text-fx-text2">{meta.label}</span>
    </span>
  );
}
