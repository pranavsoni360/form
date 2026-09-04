"use client";

// Finix table (design_handoff_finix/README.md §Tables).
//
// Header row 32px, 11px/text3 labels, 1px border top+bottom, no fill.
// Body rows 44px, 1px bottom border, hover surface. Cell padding 7px 14px.
// Numbers right-aligned tabular; text left; icon columns centred. Two-line
// cells common (primary 13px over secondary 11px/text3). Wide tables scroll in
// an overflow-x wrapper inside the card.

import * as React from "react";
import { cn } from "@/lib/utils";

export type Align = "left" | "right" | "center";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  align?: Align;
  width?: number | string;
  /**
   * Keep the cell on one line. Short mono values — IDs, dates, durations,
   * amounts — wrap mid-token in a narrow column ("LN-\n24019", "14 Aug\n2026"),
   * which is unreadable and misaligns the row. Right-aligned columns get this
   * automatically since they are numeric by convention.
   */
  nowrap?: boolean;
  render: (row: T, index: number) => React.ReactNode;
};

const alignClass: Record<Align, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  /** Wrap in overflow-x for wide tables. Narrow in-card legend tables pass false. */
  scroll = true,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  scroll?: boolean;
  className?: string;
}) {
  const table = (
    <table className={cn("w-full border-collapse", className)}>
      <thead>
        <tr className="border-y border-fx-border">
          {columns.map((c) => (
            <th
              key={c.key}
              className={cn(
                "h-[32px] whitespace-nowrap px-[10px] md:px-[14px] text-[11px] font-normal text-fx-text3",
                alignClass[c.align ?? "left"],
              )}
              style={{ width: c.width }}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={rowKey(row, i)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn(
              "border-b border-fx-border transition-colors hover:bg-fx-surface",
              onRowClick && "cursor-pointer",
            )}
          >
            {columns.map((c) => (
              <td
                key={c.key}
                className={cn(
                  "min-h-[44px] px-[10px] py-[7px] md:px-[14px] align-middle text-[13px] text-fx-text",
                  alignClass[c.align ?? "left"],
                  (c.align ?? "left") === "right" && "fx-mono whitespace-nowrap",
                  c.nowrap && "whitespace-nowrap",
                )}
              >
                {c.render(row, i)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return scroll ? <div className="overflow-x-auto">{table}</div> : table;
}

/** Two-line cell: primary value over a 11px/text3 secondary line. */
export function TwoLine({ primary, secondary }: { primary: React.ReactNode; secondary?: React.ReactNode }) {
  return (
    <div className="leading-tight">
      <div className="text-[13px] text-fx-text">{primary}</div>
      {secondary != null && <div className="text-[11px] text-fx-text3">{secondary}</div>}
    </div>
  );
}
