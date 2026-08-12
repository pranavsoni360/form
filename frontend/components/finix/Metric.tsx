"use client";

// Finix metric card + delta chip (design_handoff_finix/README.md §Content panel
// metric row).
//
// Card on surface2, 14px radius, 14px padding: 11px label, optional delta chip
// on the right, 26px/500 value with a 12px unit beside it, 11px/text3 note.
// Ring variants carry meaning: amber warning, red exceeded.

import * as React from "react";
import { cn } from "@/lib/utils";
import { Card, type CardRing } from "./Card";

export function DeltaChip({ value }: { value: number }) {
  // Positive = green ↑, negative = red ↓. `value` is the delta already in the
  // unit the caller wants (e.g. 12.4 for "↑ 12.4%").
  const up = value >= 0;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-[9px] py-0.5 text-[11.5px] leading-none"
      style={{
        background: up ? "var(--fx-green-tint)" : "var(--fx-red-tint)",
        color: up ? "var(--fx-green)" : "var(--fx-red)",
      }}
    >
      {up ? "↑" : "↓"} {Math.abs(value)}
      {Number.isInteger(value) ? "" : ""}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  unit,
  note,
  delta,
  ring = "none",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  note?: React.ReactNode;
  /** Rendered as a green/red delta chip. Pass the numeric delta (e.g. 12.4 or -2.6). */
  delta?: React.ReactNode;
  ring?: CardRing;
  className?: string;
}) {
  return (
    <Card ring={ring} className={cn("p-[14px]", className)}>
      <div className="flex items-start gap-2">
        <span className="text-[11px] text-fx-text3">{label}</span>
        {delta != null && <span className="ml-auto">{delta}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className="text-[26px] font-medium leading-none text-fx-text"
          style={{ letterSpacing: "-0.02em" }}
        >
          {value}
        </span>
        {unit != null && <span className="text-[12px] text-fx-text2">{unit}</span>}
      </div>
      {note != null && <div className="mt-1.5 text-[11px] text-fx-text3">{note}</div>}
    </Card>
  );
}
