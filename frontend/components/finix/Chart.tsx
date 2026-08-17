"use client";

// Finix charts (Job 2 extension). The handoff README specs a LineChart
// (Catmull-Rom spline, 1.5px accent stroke, flat area fill, crosshair + glow dot
// + tooltip) but PLAN.md §1 deferred it: no Job-1 screen needed it.
//
// WHY NOW: /ops/analytics, /ops/funnel, /ops/live and /admin/dashboard are chart
// screens. Those already use recharts via components/ops/ActivityChart, so this
// wraps recharts rather than hand-rolling SVG — same rendering engine, same
// accessibility and resize behaviour, far less to get wrong.
//
// THE TOKEN PROBLEM: the legacy ActivityChart hard-codes `hsl(var(--border))`
// and `hsl(217 91% 60%)`. Those shadcn vars don't exist inside `.finix-root`, so
// a chart dropped into a Finix shell renders with invisible axes. recharts needs
// real colour strings (it writes SVG attributes, not CSS), so the --fx-* tokens
// have to be RESOLVED to values at render time — and re-resolved when the theme
// flips, since the same var yields a different colour per palette.

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useFinixTheme } from "./theme";

/**
 * Resolve --fx-* tokens to concrete colour strings for recharts.
 *
 * Re-runs whenever the Finix theme changes. Reads from a probe element inside a
 * `.finix-root` so the scoped variables actually resolve — reading off
 * documentElement would return empty strings, because the token layer is scoped.
 */
function useChartTokens() {
  const { theme } = useFinixTheme();
  const [tokens, setTokens] = React.useState({
    accent: "#5b7cfa",
    green: "#2fb98b",
    amber: "#d99b28",
    red: "#e05563",
    grid: "#d9dce3",
    text3: "#8a8f9c",
    surface: "#ffffff",
    border: "#e4e7ec",
  });

  React.useEffect(() => {
    const probe = document.createElement("div");
    probe.className = "finix-root";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    setTokens({
      accent: read("--fx-accent", "#5b7cfa"),
      green: read("--fx-green", "#2fb98b"),
      amber: read("--fx-amber", "#d99b28"),
      red: read("--fx-red", "#e05563"),
      grid: read("--fx-border", "#e4e7ec"),
      text3: read("--fx-text3", "#8a8f9c"),
      surface: read("--fx-surface", "#ffffff"),
      border: read("--fx-border-strong", "#d9dce3"),
    });
    document.body.removeChild(probe);
  }, [theme]);

  return tokens;
}

export type SeriesTone = "accent" | "green" | "amber" | "red";

export type ChartSeries = {
  /** Key into each datum. */
  key: string;
  /** Legend/tooltip label. */
  label: string;
  tone?: SeriesTone;
  /** Stack id — series sharing one are stacked (matches the legacy ActivityChart). */
  stackId?: string;
};

type CommonProps = {
  data: ReadonlyArray<Record<string, any>>;
  /** Datum key for the x axis. */
  xKey: string;
  series: ChartSeries[];
  height?: number;
  /** Copy shown centred when every series is all-zero/empty. */
  emptyLabel?: string;
  /** Tick formatter for the y axis and tooltip values. */
  formatValue?: (v: number) => string;
  className?: string;
};

/** Shared axis/grid/tooltip config so every Finix chart reads identically. */
function useChartParts(t: ReturnType<typeof useChartTokens>, formatValue?: (v: number) => string) {
  return {
    grid: <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />,
    xAxis: (xKey: string) => (
      <XAxis
        dataKey={xKey}
        stroke={t.text3}
        fontSize={10}
        tickLine={false}
        axisLine={false}
        tickMargin={6}
        minTickGap={28}
      />
    ),
    yAxis: (
      <YAxis
        stroke={t.text3}
        fontSize={10}
        tickLine={false}
        axisLine={false}
        // 52px, not 40: four-digit counts ("8,642") were being clipped to
        // ".000"/".500", which reads as a wrong number rather than a cramped one.
        width={52}
        allowDecimals={false}
        // Compact by default so thousands stay short (8.6k) instead of needing
        // the extra width; an explicit formatValue still wins.
        tickFormatter={
          formatValue
            ? (v: number) => formatValue(v)
            : (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v))
        }
      />
    ),
    tooltip: (
      <Tooltip
        cursor={{ stroke: t.border }}
        formatter={formatValue ? (v: any) => formatValue(Number(v)) : undefined}
        contentStyle={{
          background: t.surface,
          border: `1px solid ${t.grid}`,
          borderRadius: 10,
          fontSize: 12,
          boxShadow: "var(--fx-elevation)",
        }}
        labelStyle={{ color: t.text3, fontSize: 11 }}
        itemStyle={{ fontSize: 12 }}
      />
    ),
  };
}

/** Centred overlay for the all-zero case — the legacy charts did this too. */
function EmptyOverlay({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <span className="text-[12px] text-fx-text3">{label}</span>
    </div>
  );
}

function isEmpty(data: ReadonlyArray<Record<string, any>>, series: ChartSeries[]) {
  if (!data.length) return true;
  return data.every((d) => series.every((s) => !Number(d[s.key])));
}

function Legend({ series, tones }: { series: ChartSeries[]; tones: Record<SeriesTone, string> }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-[8px] w-[8px] rounded-[2px]"
            style={{ background: tones[s.tone ?? "accent"] }}
          />
          <span className="text-[11px] text-fx-text2">{s.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Area chart with a flat token-tinted fill — the /ops activity shape. */
export function AreaChartFx({
  data, xKey, series, height = 220, emptyLabel = "No data for this period", formatValue, className,
}: CommonProps) {
  const t = useChartTokens();
  const tones: Record<SeriesTone, string> = { accent: t.accent, green: t.green, amber: t.amber, red: t.red };
  const parts = useChartParts(t, formatValue);
  const empty = isEmpty(data, series);

  return (
    <div className={className}>
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={[...data]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {series.map((s) => {
                const c = tones[s.tone ?? "accent"];
                return (
                  <linearGradient key={s.key} id={`fxA-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={c} stopOpacity={0.02} />
                  </linearGradient>
                );
              })}
            </defs>
            {parts.grid}
            {parts.xAxis(xKey)}
            {parts.yAxis}
            {parts.tooltip}
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stackId={s.stackId}
                stroke={tones[s.tone ?? "accent"]}
                strokeWidth={1.5}
                fill={`url(#fxA-${s.key})`}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
        {empty && <EmptyOverlay label={emptyLabel} />}
      </div>
      {series.length > 1 && <Legend series={series} tones={tones} />}
    </div>
  );
}

/** Line chart — the README's spline shape, 1.5px accent stroke, glow dot on hover. */
export function LineChartFx({
  data, xKey, series, height = 220, emptyLabel = "No data for this period", formatValue, className,
}: CommonProps) {
  const t = useChartTokens();
  const tones: Record<SeriesTone, string> = { accent: t.accent, green: t.green, amber: t.amber, red: t.red };
  const parts = useChartParts(t, formatValue);
  const empty = isEmpty(data, series);

  return (
    <div className={className}>
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <RLineChart data={[...data]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            {parts.grid}
            {parts.xAxis(xKey)}
            {parts.yAxis}
            {parts.tooltip}
            {series.map((s) => {
              const c = tones[s.tone ?? "accent"];
              return (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={c}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3.5, fill: c, stroke: t.surface, strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              );
            })}
          </RLineChart>
        </ResponsiveContainer>
        {empty && <EmptyOverlay label={emptyLabel} />}
      </div>
      {series.length > 1 && <Legend series={series} tones={tones} />}
    </div>
  );
}

/** Vertical bar chart — counts per bucket (funnel steps, per-day volumes). */
export function BarChartFx({
  data, xKey, series, height = 220, emptyLabel = "No data for this period", formatValue, className,
}: CommonProps) {
  const t = useChartTokens();
  const tones: Record<SeriesTone, string> = { accent: t.accent, green: t.green, amber: t.amber, red: t.red };
  const parts = useChartParts(t, formatValue);
  const empty = isEmpty(data, series);

  return (
    <div className={className}>
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={[...data]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            {parts.grid}
            {parts.xAxis(xKey)}
            {parts.yAxis}
            {parts.tooltip}
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId={s.stackId}
                fill={tones[s.tone ?? "accent"]}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
        {empty && <EmptyOverlay label={emptyLabel} />}
      </div>
      {series.length > 1 && <Legend series={series} tones={tones} />}
    </div>
  );
}
