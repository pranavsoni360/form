// lib/utils/statusConfig.ts — application status labels + Tailwind color classes

export type ApplicationStatus =
  | "draft"
  | "submitted"
  | "system_reviewed"
  | "officer_approved"
  | "officer_rejected"
  | "documents_submitted"
  | "approved"
  | "supervisor_rejected"
  | "disbursed"
  | "cancelled"
  | "withdrawn";

export type AISuggestion = "approve" | "deny" | "review";

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  system_reviewed: "Reviewed",
  officer_approved: "Officer Approved",
  officer_rejected: "Rejected",
  documents_submitted: "Documents Submitted",
  approved: "Approved",
  supervisor_rejected: "Rejected",
  disbursed: "Disbursed",
  cancelled: "Cancelled",
  withdrawn: "Withdrawn",
};

export const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  submitted: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  system_reviewed:
    "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  officer_approved:
    "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  officer_rejected:
    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  documents_submitted:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  approved:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  supervisor_rejected:
    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  disbursed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
  withdrawn: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-400",
};

export const SUGGESTION_COLORS: Record<string, string> = {
  approve: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  deny: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  review:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
};

export function getStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function getStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? STATUS_COLORS.draft;
}

export function getSuggestionColor(suggestion: string): string {
  return SUGGESTION_COLORS[suggestion] ?? "";
}
