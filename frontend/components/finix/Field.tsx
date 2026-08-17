"use client";

// Finix form controls (Job 2 extension — the handoff README specifies inputs
// only implicitly, via the settings screen's "monospace time inputs" and the
// create-user modal's inline validation).
//
// WHY THIS EXISTS: the heavy screens still to be migrated (/bank/scorecard,
// /bank/batch, /bank/account-form, /admin/*, every login) are form-dense —
// scorecard alone has number, text, range, checkbox and select controls. Without
// a shared set, each screen would improvise its own input styling and the
// "consistent design" goal fails exactly where there is the most surface area.
//
// Shape follows the existing primitives: 30px controls (matching Button and
// PeriodChip), 10px radius, surface2 fill, NO border — focus is an accent inset
// ring, the same idiom Card uses for its meaning-carrying rings. Numeric inputs
// get the mono face so figures align down a column, like Table's right-aligned
// cells.
//
// Validation is presentational only: pass `error` and the control rings red and
// wires aria-invalid + aria-describedby. The screens keep their own validation
// logic — these components never validate anything themselves.

import * as React from "react";
import { cn } from "@/lib/utils";

/** Shared control chrome. `invalid` swaps the focus ring for a persistent red one. */
function controlClass(invalid: boolean, mono: boolean, extra?: string) {
  return cn(
    "w-full rounded-[10px] bg-fx-surface2 px-3 text-[13px] text-fx-text outline-none",
    "placeholder:text-fx-text3 disabled:opacity-50",
    mono && "fx-mono",
    invalid
      ? "shadow-[inset_0_0_0_1px_var(--fx-red)]"
      : "focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]",
    extra,
  );
}

/**
 * Label + optional hint/error wrapper. Use for every control so the vertical
 * rhythm and the error slot are identical everywhere.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  className,
  children,
}: {
  label?: React.ReactNode;
  /** Quiet helper text. Hidden while an error is showing so the two never stack. */
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label != null && (
        <label htmlFor={htmlFor} className="text-[11px] text-fx-text3">
          {label}
          {required && <span style={{ color: "var(--fx-red)" }}> *</span>}
        </label>
      )}
      {children}
      {error ? (
        <span id={htmlFor ? `${htmlFor}-err` : undefined} className="text-[11px]" style={{ color: "var(--fx-red)" }}>
          {error}
        </span>
      ) : hint != null ? (
        <span className="text-[11px] text-fx-text3">{hint}</span>
      ) : null}
    </div>
  );
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }
>(function Input({ invalid = false, mono, className, type = "text", ...props }, ref) {
  // Numbers, dates, times and tel are figures — mono keeps them aligned.
  const isFigure = ["number", "date", "time", "tel", "datetime-local"].includes(type);
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid && props.id ? `${props.id}-err` : undefined}
      className={cn(controlClass(invalid, mono ?? isFigure, "h-[30px]"), className)}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ invalid = false, className, rows = 3, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(controlClass(invalid, false, "py-2 leading-normal"), className)}
      {...props}
    />
  );
});

/**
 * Native select. Kept native (not a custom popover) so keyboard, mobile and
 * screen-reader behaviour comes free; the appearance is normalised and a chevron
 * is drawn in via background-image so no wrapper element is needed.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ invalid = false, className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        controlClass(invalid, false, "h-[30px] cursor-pointer appearance-none pr-8"),
        className,
      )}
      style={{
        // Chevron drawn as a data-URI so it inherits no extra DOM. currentColor
        // isn't available in background-image, so this uses a neutral stroke that
        // reads correctly on both palettes.
        backgroundImage:
          "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238a8f9c' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
      }}
      {...props}
    >
      {children}
    </select>
  );
});

/** Checkbox + inline label. 15px box, accent fill when checked. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-[13px] text-fx-text2",
        disabled ? "opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <span className="relative inline-flex h-[15px] w-[15px] items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 cursor-inherit appearance-none rounded-[4px] bg-fx-surface2 outline-none focus-visible:shadow-[0_0_0_2px_var(--fx-bg),0_0_0_4px_var(--fx-accent-tint)]"
          style={{ boxShadow: checked ? undefined : "inset 0 0 0 1px var(--fx-border-strong)" }}
        />
        {checked && (
          <>
            <span
              className="pointer-events-none absolute inset-0 rounded-[4px]"
              style={{ background: "var(--fx-accent)" }}
            />
            <span className="pointer-events-none relative text-[10px] font-medium leading-none text-white">✓</span>
          </>
        )}
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}

/**
 * Range slider paired with its numeric value. /bank/scorecard drives weights
 * with a range + number pair, so the value is part of the control, not decoration.
 */
export function Range({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  suffix = "",
  disabled,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  className?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="fx-range h-[4px] flex-1 cursor-pointer appearance-none rounded-full disabled:opacity-50"
        style={{
          // Filled portion left of the thumb, track to the right.
          background: `linear-gradient(to right, var(--fx-accent) 0%, var(--fx-accent) ${pct}%, var(--fx-surface2) ${pct}%, var(--fx-surface2) 100%)`,
        }}
      />
      <span className="fx-mono w-[52px] shrink-0 text-right text-[12px] text-fx-text2">
        {value}
        {suffix}
      </span>
    </div>
  );
}

/** Two-column form grid — the layout the settings and scorecard cards use. */
export function FieldRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid gap-4 sm:grid-cols-2", className)}>{children}</div>;
}
