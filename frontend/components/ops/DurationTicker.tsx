"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Counts up from `startedAt` (ms epoch) every frame via requestAnimationFrame.
 *
 * We use rAF (not setInterval) so:
 *   1. tabs in the background pause the ticker (browser-native rAF pause)
 *   2. multiple tickers share one frame loop
 *   3. visually smooth — no drift from setInterval rounding errors
 *
 * If `endedAt` is provided, the ticker freezes at the final value.
 */
export function DurationTicker({
  startedAt,
  endedAt,
  className,
}: {
  startedAt: number;
  endedAt?: number | null;
  className?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (endedAt) {
      setNow(endedAt);
      return;
    }
    let raf = 0;
    let lastUpdate = 0;
    const tick = (t: number) => {
      // rAF runs at 60Hz — re-render at most every 100ms (10 fps is enough
      // for a seconds-precision ticker; spares the GC).
      if (t - lastUpdate > 100) {
        lastUpdate = t;
        setNow(Date.now());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [endedAt]);

  const elapsedMs = Math.max(0, (endedAt ?? now) - startedAt);
  const totalSec = Math.floor(elapsedMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}
