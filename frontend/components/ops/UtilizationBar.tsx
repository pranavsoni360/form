import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Active-calls / capacity progress bar.
 *
 * Thresholds (matches plan):
 *   - <80% used → green
 *   - 80-99%    → amber
 *   - 100%+     → red (overloaded, shouldn't happen but visible if it does)
 *
 * Renders inline as "3 / 5" mono label + bar, suitable inside table cells.
 */
export function UtilizationBar({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tone =
    pct >= 100
      ? "bg-destructive"
      : pct >= 80
      ? "bg-[hsl(var(--warning))]"
      : "bg-success";

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="min-w-[2.75rem] font-mono text-xs tabular-nums text-foreground/80">
        {value} / {max}
      </span>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full transition-all", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
