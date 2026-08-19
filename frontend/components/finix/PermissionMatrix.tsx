"use client";

// Permission matrix for the bank-admin console.
//
// WHAT IT IS FOR: an admin picks a role, the grid prefills with that role's
// defaults, and they can then tick or untick any individual right — including
// rights the role does not normally carry. That is the "default is set by role
// but editable, and any specific right can be given to a particular person"
// requirement.
//
// The key thing this component makes visible is WHY a box is in its state. A
// plain checkbox grid cannot distinguish "off because this role never had it"
// from "off because someone deliberately took it away from this person", and on
// a screen that controls loan approvals that difference matters. So each row
// shows its origin: inherited from the role, or an explicit exception, with a
// one-click way back to the role default.
//
// Dangerous permissions (money out, deletions) are marked. They are never part
// of a `custom` role's default set, so granting one is always a deliberate act.

import * as React from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./Field";
import { Pill } from "./Pill";
import { Button } from "./Button";

export type PermissionSource = "role" | "granted" | "revoked" | "none";

export interface PermissionItem {
  permission_code: string;
  category: string;
  description: string;
  is_dangerous: boolean;
  /** Does the user's ROLE grant this by default? */
  role_default: boolean;
}

/** Human labels for the category keys the backend groups by. */
const CATEGORY_LABEL: Record<string, string> = {
  applications: "Applications",
  decisions: "Lending decisions",
  calling: "Calling",
  scoring: "Scoring",
  administration: "Administration",
};

/**
 * Derive the per-row origin. Kept as a pure function (not state) so the badge can
 * never drift out of sync with the checkbox: it is always computed from the
 * current selection versus the role default.
 */
function sourceOf(checked: boolean, roleDefault: boolean): PermissionSource {
  if (checked && !roleDefault) return "granted";
  if (!checked && roleDefault) return "revoked";
  return checked ? "role" : "none";
}

const SOURCE_META: Record<PermissionSource, { label: string; tone: "accent" | "amber" | "neutral" } | null> = {
  role: null,                                             // inherited: no badge, it's the norm
  none: null,                                             // not held and not expected: no badge
  granted: { label: "added", tone: "accent" },
  revoked: { label: "removed", tone: "amber" },
};

export function PermissionMatrix({
  items,
  /** Currently-ticked permission codes. */
  value,
  onChange,
  /** Role default codes — drives the "added"/"removed" badges and Reset. */
  roleDefaults,
  disabled = false,
  className,
}: {
  items: PermissionItem[];
  value: string[];
  onChange: (codes: string[]) => void;
  roleDefaults: string[];
  disabled?: boolean;
  className?: string;
}) {
  const selected = React.useMemo(() => new Set(value), [value]);
  const defaults = React.useMemo(() => new Set(roleDefaults), [roleDefaults]);

  const grouped = React.useMemo(() => {
    const by = new Map<string, PermissionItem[]>();
    for (const it of items) {
      const arr = by.get(it.category) ?? [];
      arr.push(it);
      by.set(it.category, arr);
    }
    return Array.from(by.entries());
  }, [items]);

  const toggle = (code: string, next: boolean) => {
    const s = new Set(selected);
    if (next) s.add(code);
    else s.delete(code);
    onChange(Array.from(s));
  };

  const toggleCategory = (cat: string, next: boolean) => {
    const s = new Set(selected);
    for (const it of items) {
      if (it.category !== cat) continue;
      if (next) s.add(it.permission_code);
      else s.delete(it.permission_code);
    }
    onChange(Array.from(s));
  };

  // How far this selection strays from the plain role default. Surfacing the
  // count means an admin can see at a glance that they've customised something,
  // rather than discovering it later.
  const exceptions = React.useMemo(() => {
    let added = 0, removed = 0;
    for (const it of items) {
      const on = selected.has(it.permission_code);
      const def = defaults.has(it.permission_code);
      if (on && !def) added++;
      if (!on && def) removed++;
    }
    return { added, removed };
  }, [items, selected, defaults]);

  const resetToRole = () => onChange(Array.from(defaults));

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-fx-text3">
          {selected.size} of {items.length} rights
        </span>
        {(exceptions.added > 0 || exceptions.removed > 0) && (
          <span className="flex items-center gap-1.5">
            {exceptions.added > 0 && <Pill tone="accent">{exceptions.added} added</Pill>}
            {exceptions.removed > 0 && <Pill tone="amber">{exceptions.removed} removed</Pill>}
          </span>
        )}
        {(exceptions.added > 0 || exceptions.removed > 0) && !disabled && (
          <span className="ml-auto">
            <Button variant="quiet" type="button" onClick={resetToRole}>
              Reset to role default
            </Button>
          </span>
        )}
      </div>

      <div className="space-y-3">
        {grouped.map(([cat, rows]) => {
          const allOn = rows.every((r) => selected.has(r.permission_code));
          return (
            <div key={cat} className="overflow-hidden rounded-[10px]" style={{ background: "var(--fx-bg)" }}>
              <div className="flex items-center gap-3 border-b border-fx-border px-3 py-2">
                <span className="text-[11px] uppercase tracking-[0.1em] text-fx-text3">
                  {CATEGORY_LABEL[cat] ?? cat}
                </span>
                <span className="fx-mono text-[10px] text-fx-text3">
                  {rows.filter((r) => selected.has(r.permission_code)).length}/{rows.length}
                </span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => toggleCategory(cat, !allOn)}
                    className="fx-tap ml-auto text-[11px] text-fx-text3 hover:text-fx-text2"
                  >
                    {allOn ? "Clear all" : "Select all"}
                  </button>
                )}
              </div>

              <div>
                {rows.map((r) => {
                  const on = selected.has(r.permission_code);
                  const def = defaults.has(r.permission_code);
                  const meta = SOURCE_META[sourceOf(on, def)];
                  return (
                    <div
                      key={r.permission_code}
                      className="flex items-start gap-3 border-b border-fx-border px-3 py-2 last:border-0"
                    >
                      <span className="pt-0.5">
                        <Checkbox
                          checked={on}
                          disabled={disabled}
                          onChange={(next) => toggle(r.permission_code, next)}
                          label={undefined}
                        />
                      </span>
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] text-fx-text">{r.description}</span>
                          {r.is_dangerous && <Pill tone="red">sensitive</Pill>}
                          {meta && <Pill tone={meta.tone}>{meta.label}</Pill>}
                        </div>
                        <div className="fx-mono mt-0.5 text-[10px] text-fx-text3">{r.permission_code}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
