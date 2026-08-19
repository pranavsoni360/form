"use client";

// Module × Read/Write/Edit permission grid for the bank-admin console.
//
// Replaces the flat 30-checkbox list: an admin onboarding a recovery caller
// thinks in modules ("can they see borrower records?"), not in permission codes.
// The mapping from a cell to its underlying codes lives in
// lib/utils/permissionModules.ts — this file is presentation only, so the codes
// remain the unit of storage, enforcement and audit.
//
// THREE CELL STATES, all meaningfully different:
//   ✓  granted
//   ○  available for this module but not granted
//   –  this module has no such level at all (fixed per module, same for every
//      role, so switching role never looks like rights disappearing)
//
// Read gates the row: clearing Read clears Write and Edit, and ticking either of
// those turns Read on. A "can edit but not view" state is incoherent and the
// backend could not honour it.
//
// The header names the baseline ("Officer defaults") and flips to a "Customised
// from …" warning the moment the selection deviates, because on a screen that
// controls lending the difference between an inherited default and a deliberate
// exception has to be visible without hunting.

import * as React from "react";
import { cn } from "@/lib/utils";
import { Pill } from "./Pill";
import { Button } from "./Button";
import {
  LEVELS,
  PERMISSION_MODULES,
  applyCellToggle,
  cellState,
  isPartial,
  levelExists,
  type PermissionLevel,
  type PermissionModule,
} from "@/lib/utils/permissionModules";

const LEVEL_LABEL: Record<PermissionLevel, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
};

function Cell({
  state,
  partial,
  sensitive,
  disabled,
  onToggle,
  label,
}: {
  state: "on" | "off" | "na";
  partial: boolean;
  sensitive: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  label: string;
}) {
  if (state === "na") {
    return (
      <div className="grid place-items-center" aria-label={`${label}: not applicable`}>
        <span className="fx-mono text-[13px] text-fx-text3" aria-hidden>–</span>
      </div>
    );
  }

  const on = state === "on";
  return (
    <div className="grid place-items-center">
      <button
        type="button"
        role="checkbox"
        aria-checked={partial ? "mixed" : on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onToggle(!on)}
        className={cn(
          "fx-tap grid h-[22px] w-[22px] place-items-center rounded-[6px] text-[11px] leading-none transition-colors",
          disabled && "cursor-not-allowed opacity-50",
        )}
        style={
          on
            ? {
                // Sensitive levels carry the red tint so an Edit that can move
                // money never looks like an ordinary tick.
                background: sensitive ? "var(--fx-red-tint)" : "var(--fx-accent)",
                color: sensitive ? "var(--fx-red)" : "#fff",
                boxShadow: sensitive ? "inset 0 0 0 1px var(--fx-red)" : undefined,
              }
            : partial
              ? { background: "var(--fx-amber-tint)", color: "var(--fx-amber)" }
              : { boxShadow: "inset 0 0 0 1px var(--fx-border-strong)", color: "transparent" }
        }
      >
        {on ? "✓" : partial ? "◐" : "○"}
      </button>
    </div>
  );
}

export function PermissionGrid({
  /** Selected permission CODES (the storage unit), not cells. */
  value,
  onChange,
  /** Role default codes — drives the "customised" banner and Reset. */
  roleDefaults,
  /** Baseline name shown in the header, e.g. "Officer". */
  roleLabel,
  modules = PERMISSION_MODULES,
  disabled = false,
  /**
   * Codes held but not represented by any cell. Carried through on save; shown
   * so a lossy grid never silently narrows someone's access.
   */
  unmapped = [],
  className,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  roleDefaults: string[];
  roleLabel: string;
  modules?: PermissionModule[];
  disabled?: boolean;
  unmapped?: string[];
  className?: string;
}) {
  const selected = React.useMemo(() => new Set(value), [value]);
  const defaults = React.useMemo(() => new Set(roleDefaults), [roleDefaults]);

  // Deviation is compared at CELL level, not code level: a role default that
  // only partially covers a cell would otherwise read as "customised" before the
  // admin has touched anything.
  const deviates = React.useMemo(() => {
    for (const m of modules) {
      for (const l of LEVELS) {
        if (!levelExists(m, l)) continue;
        if (cellState(m, l, selected) !== cellState(m, l, defaults)) return true;
      }
    }
    return false;
  }, [modules, selected, defaults]);

  const toggle = (moduleKey: string, level: PermissionLevel, next: boolean) => {
    onChange(applyCellToggle(modules, value, moduleKey, level, next));
  };

  return (
    <div className={cn("space-y-2", className)}>
      {/* Baseline / deviation header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-fx-text3">Rights</span>
        <span className="ml-auto flex items-center gap-2">
          {deviates ? (
            <>
              <span className="text-[11px]" style={{ color: "var(--fx-amber)" }}>
                Customised from {roleLabel.toLowerCase()} defaults
              </span>
              {!disabled && (
                <Button variant="quiet" type="button" onClick={() => onChange(roleDefaults)}>
                  Reset to role
                </Button>
              )}
            </>
          ) : (
            <span className="text-[11px] text-fx-text3">{roleLabel} defaults</span>
          )}
        </span>
      </div>

      <div className="overflow-hidden rounded-[10px]" style={{ background: "var(--fx-bg)" }}>
        {/* Column header */}
        <div
          className="grid items-center gap-2 border-b border-fx-border px-3 py-2"
          style={{ gridTemplateColumns: "1fr repeat(3, 52px)" }}
        >
          <span className="text-[11px] text-fx-text3">Module</span>
          {LEVELS.map((l) => (
            <span key={l} className="text-center text-[11px] text-fx-text3">
              {LEVEL_LABEL[l]}
            </span>
          ))}
        </div>

        {modules.map((m) => (
          <div
            key={m.key}
            className="grid items-center gap-2 border-b border-fx-border px-3 py-2.5 last:border-0"
            style={{ gridTemplateColumns: "1fr repeat(3, 52px)" }}
          >
            <div className="min-w-0 leading-tight">
              <div className="text-[13px] text-fx-text">{m.label}</div>
              <div className="text-[11px] text-fx-text3">{m.caption}</div>
            </div>
            {LEVELS.map((l) => (
              <Cell
                key={l}
                state={cellState(m, l, selected)}
                partial={isPartial(m, l, selected)}
                sensitive={(m.sensitiveLevels ?? []).includes(l)}
                disabled={disabled}
                onToggle={(next) => toggle(m.key, l, next)}
                label={`${m.label} — ${LEVEL_LABEL[l]}`}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-fx-text3">
        <span className="inline-flex items-center gap-1.5">
          <span className="fx-mono">✓</span> granted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="fx-mono">○</span> not granted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="fx-mono">–</span> not applicable
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Pill tone="red">red</Pill> moves money or deletes
        </span>
      </div>

      {unmapped.length > 0 && (
        <p className="text-[11px] text-fx-text3">
          {unmapped.length} additional right{unmapped.length === 1 ? "" : "s"} set outside this grid
          {" "}are kept as-is.
        </p>
      )}
    </div>
  );
}
