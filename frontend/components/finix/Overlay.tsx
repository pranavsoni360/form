"use client";

// Finix modal + side panel (design_handoff_finix/README.md §Surfaces — modal
// and popover elevation `0 24px 60px oklch(0.1 0.02 265 / 0.5)`; §3 Users
// invite side panel 420px / create modal 520px).
//
// Both sit on `surface`, are elevated, close on backdrop click and Escape, and
// trap nothing fancy — just enough focus handling for a form dialog.

import * as React from "react";
import { cn } from "@/lib/utils";

function useEscape(onClose: () => void) {
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);
}

function Backdrop({ onClose, children, align }: { onClose: () => void; children: React.ReactNode; align: "center" | "right" }) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex",
        align === "center" ? "items-center justify-center p-4" : "items-stretch justify-end",
      )}
      style={{ background: "oklch(0.1 0.02 265 / 0.5)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

/** Centred modal. Default width 520px. */
export function Modal({
  open,
  onClose,
  width = 520,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  className?: string;
  children: React.ReactNode;
}) {
  useEscape(onClose);
  if (!open) return null;
  return (
    <Backdrop onClose={onClose} align="center">
      <div
        role="dialog"
        aria-modal
        className={cn("finix-root max-h-[90vh] w-full overflow-y-auto rounded-[18px] bg-fx-surface", className)}
        style={{ maxWidth: width, boxShadow: "var(--fx-elevation)" }}
      >
        {children}
      </div>
    </Backdrop>
  );
}

/** Right-anchored side panel. Default width 420px, full height. */
export function SidePanel({
  open,
  onClose,
  width = 420,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  className?: string;
  children: React.ReactNode;
}) {
  useEscape(onClose);
  if (!open) return null;
  return (
    <Backdrop onClose={onClose} align="right">
      <div
        role="dialog"
        aria-modal
        className={cn("finix-root m-3 flex w-full flex-col overflow-y-auto rounded-[18px] bg-fx-surface", className)}
        style={{ maxWidth: width, boxShadow: "var(--fx-elevation)" }}
      >
        {children}
      </div>
    </Backdrop>
  );
}

/** Shared header for a modal/panel: title + optional sub-line + close. */
export function OverlayHeader({
  title,
  subtitle,
  onClose,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-5 pt-5">
      <div className="min-w-0">
        <div className="text-[15px] font-medium text-fx-text">{title}</div>
        {subtitle != null && <div className="mt-0.5 text-[12px] text-fx-text2">{subtitle}</div>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="fx-mono ml-auto grid h-[26px] w-[26px] place-items-center rounded-[8px] bg-fx-surface2 text-fx-text2 hover:text-fx-text"
      >
        ✕
      </button>
    </div>
  );
}
