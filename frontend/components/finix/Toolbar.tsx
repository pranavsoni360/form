"use client";

// Finix toolbar row + page title (design_handoff_finix/README.md §Content
// panel). Toolbar: left = period chip (surface2, 10px radius, 30px, monospace
// glyph + date range) and/or breadcrumb (12px/text3); right = quiet actions +
// exactly one accent-gradient primary. Page title 22px/500 with a 12px/text2
// sub-line.

import * as React from "react";
import { cn } from "@/lib/utils";

export function Toolbar({ left, right }: { left?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-3">{left}</div>
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </div>
  );
}

/** Period chip — surface2, 10px radius, 30px tall, monospace glyph + range. */
export function PeriodChip({ children, glyph = "▦" }: { children: React.ReactNode; glyph?: string }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-2 rounded-[10px] bg-fx-surface2 px-3 text-[12px] text-fx-text2">
      <span className="fx-mono text-fx-text3">{glyph}</span>
      <span className="fx-mono">{children}</span>
    </span>
  );
}

export function Breadcrumb({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] text-fx-text3">{children}</span>;
}

export function PageTitle({ title, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-[22px] font-medium text-fx-text" style={{ letterSpacing: "-0.015em" }}>
        {title}
      </h1>
      {subtitle != null && <p className="mt-1 text-[12px] text-fx-text2">{subtitle}</p>}
    </div>
  );
}

/** Header filter pills (All + one per status/category, each with a count). */
export function FilterPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-[9px] py-1 text-[11.5px] transition-colors",
              active ? "bg-fx-surface2 text-fx-text" : "text-fx-text3 hover:text-fx-text2",
            )}
          >
            {o.label}
            {o.count != null && <span className="fx-mono text-fx-text3">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
