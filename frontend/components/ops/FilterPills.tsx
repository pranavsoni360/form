"use client";

import * as React from "react";
import { Filter } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Filter pill group matching the VirtualVaani applications/calls list.
 *
 * Visual:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ 🔽  [ All ]  [ Submitted ]  [ Reviewed ]  [ Officer Approved ] │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Active pill: solid blue fill, white text, rounded-full.
 * Inactive: transparent, muted text, hover lifts to card.
 *
 * Optional `counts` map renders a small mono number after each label,
 * useful for "All (12)" / "Active (3)" affordances.
 */

export interface FilterOption<V extends string = string> {
  value: V;
  label: string;
}

export function FilterPills<V extends string = string>({
  options,
  value,
  onChange,
  counts,
  className,
}: {
  options: ReadonlyArray<FilterOption<V>>;
  value: V;
  onChange: (next: V) => void;
  counts?: Partial<Record<V, number>>;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2.5 shadow-sm",
        className
      )}
    >
      <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((opt) => {
          const active = opt.value === value;
          const count = counts?.[opt.value];
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-[hsl(var(--accent))] text-white shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <span>{opt.label}</span>
              {typeof count === "number" && (
                <span
                  className={cn(
                    "rounded-full px-1.5 font-mono text-[10px] tabular-nums",
                    active ? "bg-white/20" : "bg-muted text-muted-foreground"
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
