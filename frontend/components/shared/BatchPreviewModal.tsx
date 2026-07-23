"use client";

import * as React from "react";

// Report shape returned by POST /api/agent/upload-excel when commit=false
// (preview) — and also included on the commit=true response.
export type BatchSkippedRow = {
  row: number;
  name: string;
  phone: string;
  reason: "duplicate" | "invalid_number" | "missing_name" | "missing_number";
  duplicate_of_row?: number;
};

export type BatchReport = {
  filename?: string;
  total_rows: number;
  valid: number;
  removed: {
    duplicates: number;
    invalid_numbers: number;
    missing_name: number;
    missing_number: number;
  };
  removed_total: number;
  skipped: BatchSkippedRow[];
  message?: string;
};

const REASON_LABEL: Record<BatchSkippedRow["reason"], string> = {
  duplicate: "Duplicate number",
  invalid_number: "Invalid number (< 10 digits)",
  missing_name: "Missing name",
  missing_number: "Missing number",
};

function Tile({ label, value, tone }: { label: string; value: number; tone?: "green" | "amber" | "slate" }) {
  const toneCls =
    tone === "green"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "amber"
      ? "text-amber-700 dark:text-amber-300"
      : "text-slate-800 dark:text-slate-100";
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5 text-center">
      <div className={`text-2xl font-semibold ${toneCls}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}

/**
 * Preview of CSV/Excel preprocessing before any call is queued. Shows how many
 * rows are clean vs. skipped (duplicates / invalid numbers / missing name or
 * number) and lets the operator confirm to start calling, or cancel.
 *
 * Render it with report=null to hide it. onConfirm re-uploads the same file
 * with commit=true; onCancel discards the pending file.
 */
export function BatchPreviewModal({
  report,
  confirming,
  onConfirm,
  onCancel,
}: {
  report: BatchReport | null;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!report) return null;
  const nothingToCall = report.valid === 0;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-slate-200 px-5 py-4 dark:border-slate-700">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Review before calling</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            The file was preprocessed. Nothing is dialed until you confirm.
            {report.filename ? ` · ${report.filename}` : ""}
          </p>
        </header>

        <div className="overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-3">
            <Tile label="Total rows" value={report.total_rows} tone="slate" />
            <Tile label="Ready to call" value={report.valid} tone="green" />
            <Tile label="Will be skipped" value={report.removed_total} tone="amber" />
          </div>

          {report.removed_total > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ["Duplicates", report.removed.duplicates],
                ["Invalid numbers", report.removed.invalid_numbers],
                ["Missing name", report.removed.missing_name],
                ["Missing number", report.removed.missing_number],
              ] as [string, number][]).map(([label, v]) => (
                <div key={label} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-center dark:bg-slate-800">
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{v}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">{label}</div>
                </div>
              ))}
            </div>
          )}

          {report.skipped.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                Skipped rows{report.skipped.length >= 200 ? " (first 200)" : ""}
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-2.5 py-1.5 font-medium">Row</th>
                      <th className="px-2.5 py-1.5 font-medium">Name</th>
                      <th className="px-2.5 py-1.5 font-medium">Number</th>
                      <th className="px-2.5 py-1.5 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.skipped.map((s, i) => (
                      <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">{s.row}</td>
                        <td className="px-2.5 py-1.5 text-slate-700 dark:text-slate-200">{s.name || <span className="text-slate-400">—</span>}</td>
                        <td className="px-2.5 py-1.5 font-mono text-slate-700 dark:text-slate-200">{s.phone || <span className="font-sans text-slate-400">—</span>}</td>
                        <td className="px-2.5 py-1.5 text-amber-700 dark:text-amber-300">
                          {REASON_LABEL[s.reason]}
                          {s.reason === "duplicate" && s.duplicate_of_row ? ` (of row ${s.duplicate_of_row})` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3.5 dark:border-slate-700">
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={nothingToCall || confirming}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={nothingToCall ? "No valid rows to call" : undefined}
          >
            {confirming ? "Starting…" : `Confirm & Start Calling (${report.valid})`}
          </button>
        </footer>
      </div>
    </div>
  );
}
