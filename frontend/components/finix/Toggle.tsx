"use client";

// Finix toggle (design_handoff_finix/README.md §5 Settings).
//
// 38×21px, 999px radius. On = accent gradient + glow, white 15px knob at left
// 20px. Off = transparent with a border ring and a text3 knob at left 3px.

import * as React from "react";
import { cn } from "@/lib/utils";

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      id={id}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[21px] w-[38px] shrink-0 rounded-full transition-all disabled:opacity-50 disabled:pointer-events-none",
      )}
      style={
        checked
          ? { background: "var(--fx-accent-grad)", boxShadow: "var(--fx-accent-glow)" }
          : { background: "transparent", boxShadow: "inset 0 0 0 1px var(--fx-border)" }
      }
    >
      <span
        className="absolute top-[3px] h-[15px] w-[15px] rounded-full transition-all"
        style={{
          left: checked ? 20 : 3,
          background: checked ? "#ffffff" : "var(--fx-text3)",
        }}
      />
    </button>
  );
}
