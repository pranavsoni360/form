"use client";

// Finix content card (design_handoff_finix/README.md §Content panel, §Surfaces).
//
// Cards sit on surface2, 14px radius, NO border — separation is by surface lift.
// A ring carries meaning only: amber (warning metric), red (exceeded quota),
// borderStrong (read-only "managed by Virtual Galaxy"). Rings are drawn as an
// inset box-shadow so they don't affect layout.
//
// Header is 46px: title 15px/500, optional 11px/text3 qualifier, right-side
// controls, then a 1px top border above the body.

import * as React from "react";
import { cn } from "@/lib/utils";

export type CardRing = "none" | "amber" | "red" | "strong";

const RING: Record<CardRing, string> = {
  none: "none",
  amber: "inset 0 0 0 1px var(--fx-amber)",
  red: "inset 0 0 0 1px var(--fx-red)",
  strong: "inset 0 0 0 1px var(--fx-border-strong)",
};

export function Card({
  ring = "none",
  /** `page` sits the card on the page bg instead of surface2 (VG-managed section). */
  surface = "surface2",
  className,
  style,
  children,
}: {
  ring?: CardRing;
  surface?: "surface2" | "page";
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("rounded-[14px]", surface === "surface2" ? "bg-fx-surface2" : "bg-fx-bg", className)}
      style={{ boxShadow: RING[ring] === "none" ? undefined : RING[ring], ...style }}
    >
      {children}
    </div>
  );
}

/** 46px card header with a 1px bottom divider. Body content follows below it. */
export function CardHeader({
  title,
  qualifier,
  right,
  onOpenFull,
}: {
  title: React.ReactNode;
  qualifier?: React.ReactNode;
  right?: React.ReactNode;
  /** Renders the ↗ open-in-full button (26px square) and calls this on click. */
  onOpenFull?: () => void;
}) {
  return (
    <div className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-fx-border px-[14px] py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[15px] font-medium text-fx-text">{title}</span>
        {qualifier != null && <span className="truncate text-[11px] text-fx-text3">{qualifier}</span>}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {right}
        {onOpenFull && (
          <button
            type="button"
            onClick={onOpenFull}
            aria-label="Open in full"
            className="fx-mono grid h-[26px] w-[26px] place-items-center rounded-[8px] bg-fx-surface text-fx-text2 transition-colors hover:text-fx-text"
          >
            ↗
          </button>
        )}
      </div>
    </div>
  );
}

/** Body padding wrapper for card content below the header. */
export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("p-[14px]", className)}>{children}</div>;
}
