"use client";

import * as React from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pill that counts DOWN to a target timestamp (ms epoch).
 *
 * Used in /ops/phones for cooldown timers. Ticks once per second via
 * setTimeout. When the target passes, swaps to a muted "Ready" state
 * with no countdown shown.
 *
 * If `until` is null/undefined → renders nothing (the cell shows blank).
 */
export function CountdownPill({
  until,
  className,
}: {
  until: number | null | undefined;
  className?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!until || until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);

  if (!until) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const remainingMs = until - now;
  if (remainingMs <= 0) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success ring-1 ring-success/20",
          className
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
        Ready
      </span>
    );
  }

  const totalSec = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-0.5 text-[11px] font-medium text-[hsl(var(--warning))] ring-1 ring-warning/20",
        className
      )}
    >
      <Clock className="h-3 w-3" />
      <span className="font-mono tabular-nums">
        {m}:{s.toString().padStart(2, "0")}
      </span>
    </span>
  );
}
