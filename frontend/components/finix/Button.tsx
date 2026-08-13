"use client";

// Finix buttons (design_handoff_finix/README.md §Content panel toolbar).
//
// Exactly two flavours matter in the toolbar: quiet actions on surface2, and
// ONE accent-gradient primary per toolbar (with the accent glow). Plus a
// red-tinted destructive for confirm actions, and an inert variant for the
// maker/checker "Approve" that must render disabled-but-present.
//
// 30px tall, 10px radius, sentence-case label, 400/500 weight only. The refined
// hover/press/focus micro-interactions live in globals.css (.fx-btn-*) so the
// motion stays consistent across every control.

import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "quiet" | "danger" | "inert";

const base =
  "fx-btn inline-flex h-[30px] items-center justify-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium disabled:opacity-50 disabled:pointer-events-none";

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
>(function Button({ variant = "quiet", className, style, children, ...props }, ref) {
  if (variant === "primary") {
    return (
      <button ref={ref} className={cn(base, "fx-btn-primary text-white", className)} style={style} {...props}>
        {children}
      </button>
    );
  }
  if (variant === "danger") {
    return (
      <button
        ref={ref}
        className={cn(base, "fx-btn-danger", className)}
        style={{ background: "var(--fx-red-tint)", color: "var(--fx-red)", ...style }}
        {...props}
      >
        {children}
      </button>
    );
  }
  if (variant === "inert") {
    // Maker/checker: visibly present but not actionable.
    return (
      <button
        ref={ref}
        className={cn(base, "cursor-not-allowed bg-transparent text-fx-text3", className)}
        style={{ boxShadow: "inset 0 0 0 1px var(--fx-border)", ...style }}
        aria-disabled
        {...props}
      >
        {children}
      </button>
    );
  }
  // quiet
  return (
    <button ref={ref} className={cn(base, "fx-btn-quiet text-fx-text2 hover:text-fx-text", className)} style={style} {...props}>
      {children}
    </button>
  );
});
