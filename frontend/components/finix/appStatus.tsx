"use client";

// Application-status + AI-suggestion pills for the Finix migration (Job 2).
//
// The legacy screens each carried their own Tailwind colour map
// (lib/utils/statusConfig.ts STATUS_COLORS / SUGGESTION_COLORS, plus inline
// ternaries for interest and form status). Those classes are hard-coded
// slate/blue/emerald and cannot follow the --fx-* token layer, so the migration
// needs one mapping from status -> FinixTone that every screen shares. Defining
// it once here is what keeps /bank, /admin and /vendor showing the SAME colour
// for the same status.
//
// NO FEATURE LOSS: labels come from STATUS_LABELS so wording is unchanged, and
// every status in the legacy map has an entry — including the ones no current
// screen filters on (disbursed, cancelled, withdrawn), so nothing renders
// unstyled if the backend starts returning them.
//
// Tone choices mirror the legacy intent: approvals green, rejections red,
// in-flight blue/accent, review amber, terminal-neutral states grey.

import * as React from "react";
import { STATUS_LABELS } from "@/lib/utils/statusConfig";
import { Pill, type FinixTone } from "./Pill";

/** status -> tone. Purple/indigo/teal collapse onto the token palette's accent. */
const STATUS_TONE: Record<string, FinixTone> = {
  draft: "neutral",
  submitted: "accent",
  system_reviewed: "accent",
  officer_approved: "green",
  officer_rejected: "red",
  documents_submitted: "accent",
  approved: "green",
  supervisor_rejected: "red",
  disbursed: "green",
  cancelled: "neutral",
  withdrawn: "neutral",
};

export function appStatusTone(status: string): FinixTone {
  return STATUS_TONE[status] ?? "neutral";
}

/** Application status pill. Falls back to the raw status if unmapped. */
export function AppStatusPill({ status }: { status: string }) {
  if (!status) return <span className="text-fx-text3">—</span>;
  return <Pill tone={appStatusTone(status)}>{STATUS_LABELS[status] ?? status}</Pill>;
}

const SUGGESTION_TONE: Record<string, FinixTone> = {
  approve: "green",
  deny: "red",
  review: "amber",
};

/**
 * AI/system suggestion pill. The legacy screens rendered a ◆ clipboard glyph
 * beside it and title-cased the raw value; both are preserved.
 */
export function SuggestionPill({ suggestion }: { suggestion?: string | null }) {
  if (!suggestion) return <span className="text-fx-text3">—</span>;
  const label = suggestion.charAt(0).toUpperCase() + suggestion.slice(1);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="fx-mono text-[11px] text-fx-text3">◆</span>
      <Pill tone={SUGGESTION_TONE[suggestion] ?? "neutral"}>{label}</Pill>
    </span>
  );
}

/**
 * Tri-state interest cell (true / false / unknown). The legacy dashboards
 * rendered Yes/No pills; the call log rendered "Interested"/"Not interested"
 * text. Both spellings are kept via `labels`.
 */
export function InterestPill({
  interested,
  labels = ["Yes", "No"],
}: {
  interested?: boolean | null;
  labels?: [string, string];
}) {
  if (interested === true) return <Pill tone="green">{labels[0]}</Pill>;
  if (interested === false) return <Pill tone="red">{labels[1]}</Pill>;
  return <span className="text-fx-text3">—</span>;
}

/** Form-completion status: completed / in_progress / pending / absent. */
export function FormStatusPill({ status }: { status?: string | null }) {
  if (status === "completed") return <Pill tone="green">Submitted</Pill>;
  if (status === "in_progress") return <Pill tone="amber">In progress</Pill>;
  if (status === "pending") return <Pill tone="neutral">Pending</Pill>;
  return <span className="text-fx-text3">—</span>;
}

/**
 * AI/system score pill. Thresholds copied from the legacy applications list:
 * >=70 green, >=50 amber, below that red. Kept here so every screen that shows
 * a score bands it identically.
 */
export function ScorePill({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-fx-text3">—</span>;
  const tone: FinixTone = score >= 70 ? "green" : score >= 50 ? "amber" : "red";
  return (
    <Pill tone={tone} dot={false}>
      <span className="fx-mono">{score}</span>
    </Pill>
  );
}

/**
 * KYC verification marks. Legacy rendered one green check per verified document
 * with a title tooltip, and an em dash when neither is verified.
 */
export function KycMarks({
  panVerified,
  aadhaarVerified,
}: {
  panVerified?: boolean;
  aadhaarVerified?: boolean;
}) {
  if (!panVerified && !aadhaarVerified) return <span className="text-fx-text3">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {panVerified && (
        <span title="PAN verified" className="fx-mono text-[12px]" style={{ color: "var(--fx-green)" }}>
          ✓<span className="ml-0.5 text-[10px] text-fx-text3">PAN</span>
        </span>
      )}
      {aadhaarVerified && (
        <span title="Aadhaar verified" className="fx-mono text-[12px]" style={{ color: "var(--fx-green)" }}>
          ✓<span className="ml-0.5 text-[10px] text-fx-text3">AADH</span>
        </span>
      )}
    </span>
  );
}
