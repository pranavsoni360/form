"use client";

// Finix tabs + sticky decision bar (Job 2 extension).
//
// WHY THIS EXISTS: /bank/applications/[id] is a six-tab record view with a fixed
// action bar at the bottom, and /admin + /vendor detail pages have the same
// shape. Neither pattern is in the handoff README (Job 1 had no record screen),
// so without them each detail page would invent its own tab strip and its own
// footer.
//
// The tab strip follows FilterPills' vocabulary — quiet by default, surface2 +
// accent underline when active, optional count — so a page that has both doesn't
// look like two different systems.

import * as React from "react";
import { cn } from "@/lib/utils";

export type TabDef<T extends string> = {
  id: T;
  label: string;
  /** Monospace glyph, matching the sidebar nav idiom. */
  glyph?: string;
  /** Small trailing count, e.g. "7/9 filled". */
  count?: string | number;
};

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("flex items-stretch gap-1 overflow-x-auto border-b border-fx-border", className)}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "fx-tap relative flex shrink-0 items-center gap-2 px-3 py-2.5 text-[13px] transition-colors",
              active ? "text-fx-text" : "text-fx-text3 hover:text-fx-text2",
            )}
          >
            {t.glyph && <span className="fx-mono text-[12px]">{t.glyph}</span>}
            {t.label}
            {t.count != null && t.count !== "" && (
              <span
                className="fx-mono rounded-full px-1.5 py-0.5 text-[10px]"
                style={{
                  background: active ? "var(--fx-accent-tint)" : "var(--fx-surface2)",
                  color: active ? "var(--fx-accent)" : "var(--fx-text3)",
                }}
              >
                {t.count}
              </span>
            )}
            {/* Underline sits on the strip's own border line. */}
            <span
              className="absolute inset-x-2 -bottom-px h-[2px] rounded-full transition-transform duration-200"
              style={{
                background: "var(--fx-accent)",
                transform: `scaleX(${active ? 1 : 0})`,
                transformOrigin: "left",
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Fixed bottom bar for a pending decision (approve / reject / disburse).
 *
 * Left side states WHY the bar is there and any blocking caveat; right side
 * carries the actions. Rendering it fixed means the page must reserve space at
 * the bottom — callers pass the same `padding-bottom` the legacy page did, so a
 * long record never hides its own last row behind the bar.
 */
export function DecisionBar({
  title,
  detail,
  tone = "amber",
  children,
}: {
  title: React.ReactNode;
  detail?: React.ReactNode;
  /** Dot colour — amber for "awaiting you", red for a blocked/exceeded state. */
  tone?: "amber" | "red" | "accent";
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-4 border-t border-fx-border px-5 py-3"
      style={{ background: "var(--fx-surface)" }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="h-[8px] w-[8px] shrink-0 rounded-full"
          style={{ background: `var(--fx-${tone})` }}
          aria-hidden
        />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px] text-fx-text">{title}</div>
          {detail != null && <div className="truncate text-[11px] text-fx-text3">{detail}</div>}
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Label/value pair for record views. The legacy detail page rendered these as a
 * 1px-gap grid of white tiles; here the grid lines come from the card's own
 * dividers so the surface stays flat.
 */
export function DataField({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  const empty = value == null || value === "";
  return (
    <div className="flex min-w-0 flex-col gap-1 p-3.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-fx-text3">{label}</span>
      <span className={cn("break-words text-[13px] leading-snug", empty ? "text-fx-text3" : "text-fx-text")}>
        {empty ? "—" : value}
      </span>
    </div>
  );
}

/** Grid of DataFields with hairline dividers between them. */
export function DataGrid({
  min = 210,
  className,
  children,
}: {
  min?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("fx-datagrid grid", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))` }}
    >
      {children}
    </div>
  );
}
