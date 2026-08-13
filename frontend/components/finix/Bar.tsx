"use client";

// Finix bars (design_handoff_finix/README.md §Charts — proportions and
// rankings: flat bars, 999px radius; leading bar uses the accent gradient, the
// rest accent at reduced alpha).
//
// - Bar: a single value bar (0..1). Optional tone; optional pace tick.
// - SplitBar: two adjacent segments (seat meter: solid active + outlined invited).
// - SegmentedBar: N proportional segments (call outcomes / cost by component).
// - RankBarList: ranked bars, leading in the gradient, meta line wraps.

import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "accent" | "green" | "amber" | "orange" | "red";

function toneVar(t: Tone) {
  return `var(--fx-${t})`;
}

export function Bar({
  value,
  height = 5,
  tone = "accent",
  gradient = false,
  /** A 1px tick at this fraction (0..1), e.g. expected pace. */
  tick,
  className,
}: {
  value: number;
  height?: number;
  tone?: Tone;
  gradient?: boolean;
  tick?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cn("relative w-full overflow-hidden rounded-full", className)}
      style={{ height, background: "var(--fx-border)" }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-out"
        style={{
          width: `${pct}%`,
          background: gradient ? "var(--fx-accent-grad)" : toneVar(tone),
        }}
      />
      {tick != null && (
        <div
          className="absolute top-0 h-full w-px"
          style={{ left: `${Math.max(0, Math.min(1, tick)) * 100}%`, background: "var(--fx-border-strong)" }}
        />
      )}
    </div>
  );
}

/** Seat meter: a solid gradient segment + an outlined segment, on one track. */
export function SplitBar({
  filled,
  outlined,
  height = 6,
}: {
  filled: number; // fraction 0..1 (active — solid gradient)
  outlined: number; // fraction 0..1 (invited — outlined)
  height?: number;
}) {
  const f = Math.max(0, Math.min(1, filled)) * 100;
  const o = Math.max(0, Math.min(1, outlined)) * 100;
  return (
    <div className="flex w-full overflow-hidden rounded-full" style={{ height, background: "var(--fx-border)" }}>
      <div style={{ width: `${f}%`, background: "var(--fx-accent-grad)" }} />
      <div style={{ width: `${o}%`, boxShadow: "inset 0 0 0 1px var(--fx-accent)" }} className="rounded-r-full" />
    </div>
  );
}

export type Segment = { label: string; value: number; tone?: Tone; neutral?: boolean };

/** Proportional segmented bar (call outcomes, cost by component). */
export function SegmentedBar({ segments, height = 10 }: { segments: Segment[]; height?: number }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="flex w-full overflow-hidden rounded-full" style={{ height }}>
      {segments.map((s, i) => (
        <div
          key={i}
          title={`${s.label}: ${s.value}`}
          style={{
            width: `${(s.value / total) * 100}%`,
            background: s.neutral ? "var(--fx-text3)" : s.tone ? toneVar(s.tone) : "var(--fx-accent)",
            opacity: s.neutral ? 0.5 : 1,
          }}
        />
      ))}
    </div>
  );
}

export type RankItem = { label: React.ReactNode; value: number; meta?: React.ReactNode };

/** Ranked bar list; leading bar uses the gradient, the rest accent at low alpha. */
export function RankBarList({ items }: { items: RankItem[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-3">
      {items.map((it, i) => (
        <div key={i}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-fx-text">{it.label}</span>
            <span className="fx-mono text-[12px] text-fx-text2">{it.value.toLocaleString("en-IN")}</span>
          </div>
          <div className="h-[5px] w-full overflow-hidden rounded-full" style={{ background: "var(--fx-border)" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${(it.value / max) * 100}%`,
                background: i === 0 ? "var(--fx-accent-grad)" : "oklch(0.62 0.19 265 / 0.35)",
              }}
            />
          </div>
          {it.meta != null && <div className="mt-1 whitespace-normal break-words text-[11px] text-fx-text3">{it.meta}</div>}
        </div>
      ))}
    </div>
  );
}
