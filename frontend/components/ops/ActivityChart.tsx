"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface ChartRow {
  label: string;
  calls: number;
  errors: number;
}

export function ActivityChart({
  data,
  height = 220,
}: {
  data: ReadonlyArray<ChartRow>;
  height?: number;
}) {
  const isEmpty = data.every((d) => d.calls === 0 && d.errors === 0);

  return (
    <div className="space-y-3">
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={[...data]} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="aCalls" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(217 91% 60%)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="hsl(217 91% 60%)" stopOpacity={0.04} />
              </linearGradient>
              <linearGradient id="aErr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(0 84% 60%)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="hsl(0 84% 60%)" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={32}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              width={32}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ stroke: "hsl(var(--border))" }}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 10,
                fontSize: 12,
                fontFamily: "var(--font-sans)",
              }}
              labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600 }}
              itemStyle={{ color: "hsl(var(--foreground))" }}
            />
            <Area
              type="monotone"
              dataKey="calls"
              stroke="hsl(217 91% 60%)"
              strokeWidth={2}
              fill="url(#aCalls)"
              name="Calls"
              stackId="a"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="errors"
              stroke="hsl(0 84% 60%)"
              strokeWidth={2}
              fill="url(#aErr)"
              name="Errors"
              stackId="a"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>

        {/* Empty state overlay */}
        {isEmpty && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none"
            style={{ top: 8, bottom: 0 }}
          >
            <svg
              className="w-8 h-8 text-muted-foreground/30"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.5l4-4 4 4 4-6 4 4" />
            </svg>
            <p className="text-xs text-muted-foreground/60 font-medium">No call activity in the last 2 minutes</p>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5 px-1">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: "hsl(217 91% 60%)", opacity: 0.85 }}
          />
          <span className="text-xs text-muted-foreground">Calls</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: "hsl(0 84% 60%)", opacity: 0.85 }}
          />
          <span className="text-xs text-muted-foreground">Errors</span>
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground/50">10 s buckets · last 2 min</span>
      </div>
    </div>
  );
}
