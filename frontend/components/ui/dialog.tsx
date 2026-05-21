"use client";

/**
 * Minimal dialog/modal primitive.
 *
 * Why hand-rolled instead of `@radix-ui/react-dialog`: we already pay the
 * bundle cost of a small set of UI primitives and one extra Radix package
 * is ~12 KB gzipped. For our use case (operator clicks a call → sees details)
 * a portal + backdrop + ESC handler covers everything. We can swap in Radix
 * later without touching consumers — the API mirrors theirs.
 *
 * Features:
 *   • Renders via createPortal so the modal sits above all stacking contexts
 *   • Backdrop click + ESC key both close
 *   • Body scroll-locked while open (no double-scrollbars on tall modals)
 *   • SSR-safe — bails out when window is undefined
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<Size, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  size?: Size;
  /** Render no close button + ignore backdrop/ESC. Use for critical confirms. */
  preventClose?: boolean;
  /** Render a non-default footer (action buttons etc) */
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  preventClose = false,
  footer,
  children,
}: DialogProps) {
  // Lock body scroll while open
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // ESC to close
  React.useEffect(() => {
    if (!open || preventClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, preventClose, onClose]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        // Backdrop click closes; clicks inside the panel don't bubble here
        // because we stopPropagation on the inner div.
        if (!preventClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "relative my-auto w-full rounded-2xl border border-border bg-card text-foreground shadow-2xl",
          SIZE_CLASS[size]
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {(title || !preventClose) && (
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0 flex-1">
              {title && (
                <div className="text-base font-semibold leading-tight">{title}</div>
              )}
              {description && (
                <div className="mt-1 text-xs text-muted-foreground">{description}</div>
              )}
            </div>
            {!preventClose && (
              <button
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
