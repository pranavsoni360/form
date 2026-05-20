import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Simple 4-up stat card matching the VirtualVaani bank dashboard.
 * Difference from KpiCard (in /ops/page.tsx):
 *   - StatCard is for the page-top stat row (4 in a line), no sub-text.
 *   - KpiCard is for the overview grid (6 in 3×2), with sub-label + delta.
 *
 * Layout:
 *   ┌─────────────────────────────┐
 *   │ LABEL (uppercase)    [icon] │
 *   │                             │
 *   │ 2  ←─── mono, large         │
 *   └─────────────────────────────┘
 */

export type StatTone = "info" | "success" | "warning" | "danger" | "neutral";

const TONE_RING = {
  info:    "bg-info/10 text-info ring-info/20",
  success: "bg-success/10 text-success ring-success/25",
  warning: "bg-warning/15 text-[hsl(var(--warning))] ring-warning/25",
  danger:  "bg-destructive/10 text-destructive ring-destructive/20",
  neutral: "bg-muted text-muted-foreground ring-border",
} as const;

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "info",
  hint,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: StatTone;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </div>
          {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
        </div>
        <span className={cn("grid h-9 w-9 place-items-center rounded-xl ring-1", TONE_RING[tone])}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-4 font-mono text-3xl font-bold tracking-tight tabular-nums">
        {value}
      </div>
    </div>
  );
}
