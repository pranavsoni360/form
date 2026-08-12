"use client";

// Finix tinted pill (design_handoff_finix/README.md §Tinted pills).
//
// Every status, category and tag is a quiet tinted pill, never a saturated
// filled badge:
//   padding 2px 9px; radius 999px; font 11.5px;
//   background = status colour at 16% (dark) / 10% (light) alpha;
//   colour = status colour; neutral statuses use text2 so they recede.
// Most pills carry a 5px round dot in the status colour before the label.
//
// Alpha is applied with the oklch alpha channel on the SAME token used for the
// text colour, so the tint tracks the theme automatically.

import * as React from "react";
import { cn } from "@/lib/utils";

export type FinixTone = "accent" | "green" | "amber" | "orange" | "red" | "neutral";

const TOKEN: Record<Exclude<FinixTone, "neutral">, { color: string; tint: string }> = {
  accent: { color: "--fx-accent", tint: "--fx-accent-tint" },
  green: { color: "--fx-green", tint: "--fx-green-tint" },
  amber: { color: "--fx-amber", tint: "--fx-amber-tint" },
  orange: { color: "--fx-orange", tint: "--fx-orange-tint" },
  red: { color: "--fx-red", tint: "--fx-red-tint" },
};

export function Pill({
  tone = "neutral",
  dot = true,
  className,
  children,
}: {
  tone?: FinixTone;
  /** Show the 5px leading dot. Neutral pills default to no dot. */
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  // Neutral: recede — text2 label, faint surface2 fill, no dot by default.
  if (tone === "neutral") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-[9px] py-0.5 text-[11.5px] leading-none",
          "bg-fx-surface2 text-fx-text2",
          className,
        )}
      >
        {dot && <span className="h-[5px] w-[5px] rounded-full bg-[var(--fx-text3)]" />}
        {children}
      </span>
    );
  }

  const token = TOKEN[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-[9px] py-0.5 text-[11.5px] leading-none",
        className,
      )}
      style={{
        background: `var(${token.tint})`, // 16% dark / 10% light, per data-theme
        color: `var(${token.color})`,
      }}
    >
      {dot && (
        <span
          className="h-[5px] w-[5px] rounded-full"
          style={{ background: `var(${token.color})` }}
        />
      )}
      {children}
    </span>
  );
}
