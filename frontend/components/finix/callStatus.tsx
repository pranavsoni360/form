"use client";

// Shared call-status vocabulary (design_handoff_finix/README.md §Call status
// vocabulary). ONE vocabulary, one set of pills, one legend — reused by the
// bank-admin call log, the ops console, batch results, call detail and exports.
//
// The keys are the backend `agent_calls.status` values in use today (see
// backend/agent/state.py STATUS_OPTIONS and frontend/app/bank/calls/page.tsx).
// The design's display labels are sentence case.

import * as React from "react";
import { Pill, type FinixTone } from "./Pill";

export type CallStatusMeta = {
  label: string;
  tone: FinixTone;
  /** Excluded from the answered count (wrong contact). */
  excludedFromAnswered?: boolean;
  /** Carries a scheduled callback slot. */
  carriesSlot?: boolean;
};

// Maps every known backend status string → display meta. Statuses the design
// calls "neutral" (not interested, busy, no answer) use the neutral tone so
// they recede.
export const CALL_STATUS: Record<string, CallStatusMeta> = {
  "Called - Interested": { label: "Interested", tone: "green" },
  "Called - Callback Requested": { label: "Called, callback requested", tone: "amber", carriesSlot: true },
  "Wrong Contact": { label: "Wrong contact", tone: "orange", excludedFromAnswered: true },
  "Called - Not Interested": { label: "Not interested", tone: "neutral" },
  "Busy": { label: "Busy", tone: "neutral" },
  "Not Answered": { label: "No answer", tone: "neutral" },
  "Invalid Phone": { label: "Invalid number", tone: "amber" },
  "Failed": { label: "Failed", tone: "red" },
  "Call Not Connected": { label: "Failed", tone: "red" },
  // In-flight / neutral operational states.
  "Pending": { label: "Pending", tone: "neutral" },
  "Calling": { label: "Calling", tone: "accent" },
  "Scheduled": { label: "Scheduled", tone: "neutral" },
  "Called": { label: "Called", tone: "neutral" },
};

export function callStatusMeta(status: string): CallStatusMeta {
  return CALL_STATUS[status] ?? { label: status, tone: "neutral" };
}

/** A status pill rendered from the shared vocabulary. */
export function CallStatusPill({ status }: { status: string }) {
  const meta = callStatusMeta(status);
  return <Pill tone={meta.tone} dot={meta.tone !== "neutral"}>{meta.label}</Pill>;
}

// The legend row that sits at the bottom of every call table. Includes the
// "Form sent on WhatsApp" marker. Order matches the design's filter tabs.
export const CALL_LEGEND: { label: string; tone: FinixTone }[] = [
  { label: "Interested", tone: "green" },
  { label: "Called, callback requested", tone: "amber" },
  { label: "Wrong contact", tone: "orange" },
  { label: "Not interested", tone: "neutral" },
  { label: "Invalid number", tone: "amber" },
  { label: "Failed", tone: "red" },
  { label: "Form sent on WhatsApp", tone: "green" },
];

export function CallLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-[14px] py-3 text-[11px] text-fx-text3">
      {CALL_LEGEND.map((l) => (
        <span key={l.label} className="inline-flex items-center gap-1.5">
          <span
            className="h-[5px] w-[5px] rounded-full"
            style={{ background: l.tone === "neutral" ? "var(--fx-text3)" : `var(--fx-${l.tone})` }}
          />
          {l.label}
        </span>
      ))}
    </div>
  );
}

/** Green ✆ form-sent indicator — a 22px round pill for the "Form" table column. */
export function FormSentMark({ sent }: { sent: boolean }) {
  if (!sent) return <span className="text-fx-text3">–</span>;
  return (
    <span
      className="inline-grid h-[22px] w-[22px] place-items-center rounded-full text-[12px]"
      style={{ background: "var(--fx-green-tint)", color: "var(--fx-green)" }}
      title="Form sent on WhatsApp"
      aria-label="Form sent on WhatsApp"
    >
      ✆
    </span>
  );
}
