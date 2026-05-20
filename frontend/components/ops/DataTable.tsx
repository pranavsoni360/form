"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Clean table matching the VirtualVaani applications/calls list look.
 *
 * Visual:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ CUSTOMER       LOAN ID    TYPE   AMOUNT   STATUS   ...       │  ← uppercase header
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ Test User                                                  > │  ← hover row, optional ›
 *   │ +91...                                                       │
 *   │ Pranav Soni                                                  │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Generic over the row shape — columns declare how to render each cell.
 */

export interface DataTableColumn<T> {
  /** Stable key for React + sort */
  key: string;
  /** Uppercase header label (will be rendered with tracking) */
  header: string;
  /** How to render the cell. Receives the full row. */
  render: (row: T) => React.ReactNode;
  /** Optional class on the <td>/<th> — for width control etc. */
  className?: string;
  /** Right-align numeric columns by default */
  align?: "left" | "right" | "center";
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  className,
}: {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  /** Required when rows don't carry an `id` field. */
  rowKey: (row: T, idx: number) => string;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && empty) {
    return (
      <div className={cn("rounded-2xl border border-border bg-card shadow-sm", className)}>
        {empty}
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border bg-card shadow-sm", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "px-5 py-3 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground",
                  col.align === "right" && "text-right",
                  col.align === "center" && "text-center",
                  col.align !== "right" && col.align !== "center" && "text-left",
                  col.className
                )}
              >
                {col.header}
              </th>
            ))}
            {onRowClick && <th className="w-10" aria-hidden />}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => {
            const key = rowKey(row, i);
            const clickable = !!onRowClick;
            return (
              <tr
                key={key}
                onClick={clickable ? () => onRowClick!(row) : undefined}
                className={cn(
                  "group transition-colors",
                  clickable && "cursor-pointer hover:bg-muted/40"
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "px-5 py-4 align-middle text-foreground/90",
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                      col.className
                    )}
                  >
                    {col.render(row)}
                  </td>
                ))}
                {clickable && (
                  <td className="pr-4 text-muted-foreground/60 group-hover:text-foreground">
                    <ChevronRight className="h-4 w-4" />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
