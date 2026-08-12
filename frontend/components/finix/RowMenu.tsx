"use client";

// Finix row-action menu (design_handoff_finix/README.md §Tables — a 26px ⋯
// button opening a 196px popover on `surface`, 12px radius, 5px padding, 30px
// items with 8px radius, destructive items in red).

import * as React from "react";
import { cn } from "@/lib/utils";

export type MenuItem = {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  /** amber label (e.g. "suspend user"). */
  warn?: boolean;
};

export function RowMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        aria-label="Row actions"
        onClick={() => setOpen((v) => !v)}
        className="fx-mono grid h-[26px] w-[26px] place-items-center rounded-[8px] text-fx-text2 hover:bg-fx-surface hover:text-fx-text"
      >
        ⋯
      </button>
      {open && (
        <div
          className="absolute right-0 z-40 mt-1 w-[196px] rounded-[12px] bg-fx-surface p-[5px]"
          style={{ boxShadow: "var(--fx-elevation)" }}
        >
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={cn(
                "flex h-[30px] w-full items-center rounded-[8px] px-2.5 text-left text-[13px] hover:bg-fx-surface2",
                it.destructive ? "text-fx-red" : it.warn ? "text-fx-amber" : "text-fx-text",
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
