"use client";

import * as React from "react";
import { opsFetch } from "@/lib/ops-fetch";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  FileCheck2,
  Heart,
  PhoneCall,
  PhoneOff,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { FilterPills, type FilterOption } from "@/components/ops/FilterPills";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/api";

/* ───────────────────────── Backend shape ─────────────────────────────── */

interface FunnelResponse {
  date_from: string | null;
  date_to: string | null;
  total: number;
  stages: Array<{ key: string; label: string; count: number }>;
}

type DatePreset = "today" | "yesterday" | "last7" | "last30";

function presetRange(p: DatePreset): { from: string; to: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
      .getDate()
      .toString()
      .padStart(2, "0")}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (p === "today") return { from: fmt(today), to: fmt(today) };
  if (p === "yesterday") {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    return { from: fmt(y), to: fmt(y) };
  }
  if (p === "last7") {
    const a = new Date(today);
    a.setDate(a.getDate() - 6);
    return { from: fmt(a), to: fmt(today) };
  }
  // last30
  const a = new Date(today);
  a.setDate(a.getDate() - 29);
  return { from: fmt(a), to: fmt(today) };
}

const STAGE_META: Record<string, { icon: React.ComponentType<{ className?: string }>; tone: string; barColor: string }> = {
  queued:      { icon: PhoneOff,    tone: "neutral", barColor: "bg-muted-foreground/40" },
  attempted:   { icon: PhoneCall,   tone: "info",    barColor: "bg-info" },
  connected:   { icon: CheckCircle2,tone: "success", barColor: "bg-success" },
  interested:  { icon: Heart,       tone: "warning", barColor: "bg-[hsl(var(--warning))]" },
  form_sent:   { icon: FileCheck2,  tone: "info",    barColor: "bg-primary" },
  application: { icon: Activity,    tone: "success", barColor: "bg-accent" },
};

/* ───────────────────────────── Page ──────────────────────────────────── */

export default function OpsFunnelPage() {
  const [preset, setPreset] = React.useState<DatePreset>("today");
  const range = React.useMemo(() => presetRange(preset), [preset]);

  const funnel = useQuery<FunnelResponse>({
    queryKey: ["funnel", range.from, range.to],
    queryFn: async () => {
      const url = `${API_URL}/api/agent/funnel?date_from=${range.from}&date_to=${range.to}`;
      const res = await opsFetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const presetOptions: ReadonlyArray<FilterOption<DatePreset>> = [
    { value: "today", label: "Today" },
    { value: "yesterday", label: "Yesterday" },
    { value: "last7", label: "Last 7 days" },
    { value: "last30", label: "Last 30 days" },
  ];

  const stages = funnel.data?.stages ?? [];
  const top = stages[0]?.count ?? 0;
  // For conversion percentages we anchor to the previous stage (drop-off
  // rate between consecutive stages — common funnel pattern).
  const rows = stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1].count : s.count;
    const pctOfTop = top > 0 ? (s.count / top) * 100 : 0;
    const pctOfPrev = prev > 0 ? (s.count / prev) * 100 : 0;
    return { ...s, pctOfTop, pctOfPrev };
  });

  return (
    <AppShell
      title="Funnel"
      subtitle={`Conversion from queued → application · ${preset === "today" ? "today" : preset === "yesterday" ? "yesterday" : preset === "last7" ? "last 7 days" : "last 30 days"}`}
    >
      <div className="space-y-6">
        {/* Stat row from the same funnel response */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="QUEUED"
            value={stages.find((s) => s.key === "queued")?.count ?? 0}
            icon={PhoneOff}
            tone="neutral"
          />
          <StatCard
            label="ATTEMPTED"
            value={stages.find((s) => s.key === "attempted")?.count ?? 0}
            icon={PhoneCall}
            tone="info"
          />
          <StatCard
            label="INTERESTED"
            value={stages.find((s) => s.key === "interested")?.count ?? 0}
            icon={Heart}
            tone="warning"
            hint="hot + warm leads"
          />
          <StatCard
            label="APPLICATIONS"
            value={stages.find((s) => s.key === "application")?.count ?? 0}
            icon={Activity}
            tone="success"
          />
        </div>

        <FilterPills options={presetOptions} value={preset} onChange={setPreset} />

        {/* Funnel bars */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Stage progression</CardTitle>
            <CardDescription>
              {funnel.data
                ? `${funnel.data.total} calls in window · click a row to navigate`
                : "Loading funnel data…"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {funnel.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))
            ) : funnel.error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Couldn&apos;t load funnel: {(funnel.error as Error).message}
              </div>
            ) : (
              rows.map((s, i) => {
                const meta = STAGE_META[s.key];
                const Icon = meta?.icon ?? Activity;
                return (
                  <div
                    key={s.key}
                    className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 transition-shadow hover:shadow-sm"
                  >
                    <span className={cn("badge-icon ring-1", `bg-${meta?.tone === "info" ? "info" : meta?.tone === "success" ? "success" : meta?.tone === "warning" ? "warning" : "muted"}/10`, "text-foreground")}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{s.label}</span>
                          {i > 0 && s.pctOfPrev < 100 && (
                            <Badge
                              variant={s.pctOfPrev < 30 ? "destructive" : s.pctOfPrev < 60 ? "warning" : "secondary"}
                              className="font-mono text-[10px]"
                            >
                              −{(100 - s.pctOfPrev).toFixed(0)}% drop
                            </Badge>
                          )}
                        </div>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {s.pctOfTop.toFixed(1)}% of queued
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
                        <div
                          className={cn("h-full transition-all", meta?.barColor)}
                          style={{ width: `${Math.min(100, Math.max(2, s.pctOfTop))}%` }}
                        />
                      </div>
                    </div>
                    <div className="font-mono text-2xl font-bold tabular-nums text-foreground">
                      {s.count}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
