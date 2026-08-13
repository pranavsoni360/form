"use client";

// Finix empty / loading / error states (design_handoff_finix/README.md
// §Content rules — "Every screen shows or names its empty, loading and error
// states."). Sentence case throughout; the copy is the product, the demo
// "State: data" cycler is not.

import * as React from "react";
import { Button } from "./Button";

export function EmptyState({
  title,
  description,
  action,
  secondary,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="text-[15px] font-medium text-fx-text">{title}</div>
      {description && <p className="max-w-sm text-[12px] text-fx-text2">{description}</p>}
      {(action || secondary) && (
        <div className="mt-3 flex items-center gap-3">
          {action}
          {secondary}
        </div>
      )}
    </div>
  );
}

export function LoadingState({ label = "Loading…", rows = 6 }: { label?: string; rows?: number }) {
  return (
    <div className="px-[14px] py-4">
      <div className="mb-3 text-[12px] text-fx-text3">{label}</div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-[36px] animate-pulse rounded-[10px] bg-fx-surface" />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="text-[15px] font-medium" style={{ color: "var(--fx-red)" }}>
        {title}
      </div>
      {detail && <p className="max-w-md text-[12px] text-fx-text2">{detail}</p>}
      {onRetry && (
        <div className="mt-3">
          <Button variant="quiet" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
