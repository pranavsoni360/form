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

/**
 * Stacked area chart for recent ops activity.
 *
 * Recharts (already on master) over Tremor — Tremor wraps Recharts but adds
 * ~80 KB. Recharts gives us full control of colors + tooltip + animations
 * with about the same code size.
 *
 * Data shape comes from bucketActivity() in lib/realtime/activity-buffer.ts.
 */

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
  return (
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
  );
}
