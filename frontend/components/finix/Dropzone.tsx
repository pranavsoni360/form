"use client";

// Finix file dropzone (Job 2 extension — not in the handoff README).
//
// WHY THIS EXISTS: /bank/batch and /bank/account-form upload spreadsheets, and
// today that is a hidden <input type="file"> inside a gradient <label>. That
// pattern works but it can't show what was picked, can't accept a drag, and its
// styling is hard-coded blue. The migrated screens need one control that carries
// the file name, the busy state and the reject reason.
//
// Deliberately NOT a general uploader: no queueing, no progress-per-file, no
// retry. It reports a picked file to the caller and the caller keeps owning the
// upload request, exactly as the legacy pages do (they POST and then poll).
// Progress belongs to <Progress>, which the batch screen already needs for its
// live counters.
//
// Accessibility: the drop area is a real <label> wrapping a real file input, so
// click, keyboard focus and screen-reader labelling come from the platform. The
// drag handlers are additive.

import * as React from "react";
import { cn } from "@/lib/utils";

export function Dropzone({
  onFile,
  accept,
  busy = false,
  disabled = false,
  /** File name to display as the current selection (caller-owned). */
  fileName,
  /** Rejection/validation message — rings the zone red. */
  error,
  label = "Drop a file here or click to browse",
  hint,
  /** Bytes. A file larger than this is rejected locally before onFile fires. */
  maxSize,
  className,
}: {
  onFile: (file: File) => void;
  accept?: string;
  busy?: boolean;
  disabled?: boolean;
  fileName?: string | null;
  error?: string | null;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  maxSize?: number;
  className?: string;
}) {
  const [dragging, setDragging] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const shownError = error ?? localError;
  const inert = disabled || busy;

  // Accept is a comma list of extensions and/or MIME types, matching the native
  // attribute the legacy pages already pass (".xlsx,.xls,.csv").
  const matchesAccept = React.useCallback(
    (file: File) => {
      if (!accept) return true;
      const parts = accept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!parts.length) return true;
      const name = file.name.toLowerCase();
      const type = (file.type || "").toLowerCase();
      return parts.some((p) =>
        p.startsWith(".")
          ? name.endsWith(p)
          : p.endsWith("/*")
            ? type.startsWith(p.slice(0, -1))
            : type === p,
      );
    },
    [accept],
  );

  const take = React.useCallback(
    (file: File | undefined | null) => {
      if (!file) return;
      if (!matchesAccept(file)) {
        setLocalError(`${file.name} isn't an accepted file type${accept ? ` (${accept})` : ""}.`);
        return;
      }
      if (maxSize != null && file.size > maxSize) {
        const mb = (maxSize / (1024 * 1024)).toFixed(maxSize % (1024 * 1024) === 0 ? 0 : 1);
        setLocalError(`${file.name} is larger than ${mb} MB.`);
        return;
      }
      setLocalError(null);
      onFile(file);
    },
    [matchesAccept, maxSize, accept, onFile],
  );

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        onDragOver={(e) => {
          if (inert) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (inert) return;
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 rounded-[14px] border border-dashed px-6 py-7 text-center transition-colors",
          inert ? "cursor-default opacity-60" : "cursor-pointer",
          dragging ? "bg-fx-accent-tint" : "bg-fx-surface2",
        )}
        style={{
          // A real DASHED border, not an inset ring: the dash is what signals
          // "drop target" rather than "another card". box-shadow can't dash, so
          // this is a border — and since it's always present (just recoloured),
          // it never shifts layout.
          borderColor: shownError
            ? "var(--fx-red)"
            : dragging
              ? "var(--fx-accent)"
              : "var(--fx-border-strong)",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          disabled={inert}
          className="hidden"
          onChange={(e) => {
            take(e.target.files?.[0]);
            // Clear so re-picking the SAME file still fires onChange.
            e.target.value = "";
          }}
        />
        <span className="fx-mono text-[15px] text-fx-text3" aria-hidden>
          {busy ? "◌" : fileName ? "▣" : "▤"}
        </span>
        <span className="text-[13px] text-fx-text">
          {busy ? "Uploading…" : fileName || label}
        </span>
        {!busy && (hint != null || accept) && (
          <span className="text-[11px] text-fx-text3">{hint ?? accept}</span>
        )}
      </label>
      {shownError && (
        <span className="text-[11px]" style={{ color: "var(--fx-red)" }}>
          {shownError}
        </span>
      )}
    </div>
  );
}
