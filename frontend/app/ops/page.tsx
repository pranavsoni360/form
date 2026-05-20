"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  CircleDot,
  Cpu,
  Flame,
  PhoneCall,
  PlusCircle,
  Radio,
  Sparkles,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatusPill } from "@/components/shared/StatusPill";
import { StatCard, type StatTone } from "@/components/ops/StatCard";
import { ActivityChart } from "@/components/ops/ActivityChart";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/api";
import { useEventStream } from "@/lib/realtime/useEventStream";
import { useRealtimeConnection } from "@/lib/realtime/RealtimeProvider";
import {
  callsReducer,
  initialCallsState,
  workersReducer,
  initialWorkersState,
  errorsReducer,
  initialErrorsState,
  type CallsState,
  type WorkersState,
  type ErrorsState,
} from "@/lib/realtime/reducers";
import {
  activityReducer,
  bucketActivity,
  initialActivityState,
  type ActivityState,
} from "@/lib/realtime/activity-buffer";

/* ───────────────────────── Backend response shape ────────────────────── */

interface DashboardStats {
  total_calls: number;
  whatsapp_forms_sent: number;
  hot_leads: number;
  by_status?: Record<string, number>;
  by_category?: Record<string, number>;
}

/* ───────────────────────────── Page ──────────────────────────────────── */

export default function OpsOverviewPage() {
  // REST snapshot — today's volume + lead counts
  const stats = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/agent/dashboard-stats`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // SSE — live state
  const calls = useEventStream<CallsState>("calls", callsReducer, initialCallsState);
  const workers = useEventStream<WorkersState>("workers", workersReducer, initialWorkersState);
  const errors = useEventStream<ErrorsState>("errors", errorsReducer, initialErrorsState);
  const activity = useEventStream<ActivityState>(
    ["calls", "errors", "batches"],
    activityReducer,
    initialActivityState
  );
  const { state: connState } = useRealtimeConnection();

  // 1Hz tick so the 5-minute error window + activity chart re-derive
  const [tickNow, setTickNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  /* ─── Derived metrics ──────────────────────────────────────────────── */

  const activeCallsCount = React.useMemo(
    () =>
      Object.values(calls.byId).filter(
        (c) => c.status === "dispatching" || c.status === "calling"
      ).length,
    [calls]
  );

  const errorsLast5m = React.useMemo(() => {
    const cutoff = tickNow - 5 * 60_000;
    return errors.recent.filter((e) => e.ts >= cutoff).length;
  }, [errors, tickNow]);

  const queue = workers.queueDepth;

  // Activity chart series: last 2 minutes, 10-second buckets
  const activitySeries = React.useMemo(
    () => bucketActivity(activity.events, 2 * 60_000, 10_000),
    [activity, tickNow]
  );

  /* ─── KPIs ─────────────────────────────────────────────────────────── */

  const KPIS = [
    {
      label: "CALLS TODAY",
      value: stats.data?.total_calls ?? 0,
      icon: PhoneCall,
      tone: "info" as StatTone,
      hint: `${stats.data?.hot_leads ?? 0} hot · ${stats.data?.whatsapp_forms_sent ?? 0} forms`,
    },
    {
      label: "ACTIVE NOW",
      value: activeCallsCount,
      icon: CircleDot,
      tone: (activeCallsCount > 0 ? "success" : "neutral") as StatTone,
      hint: connState === "open" ? "live SSE" : "stream offline",
    },
    {
      label: "QUEUE PENDING",
      value: queue?.pending ?? 0,
      icon: Activity,
      tone: ((queue?.pending ?? 0) > 50 ? "warning" : "info") as StatTone,
      hint: queue ? `${queue.running} running · ${queue.dead} dead` : undefined,
    },
    {
      label: "ERRORS · 5M",
      value: errorsLast5m,
      icon: Flame,
      tone: (errorsLast5m > 0 ? "danger" : "success") as StatTone,
      hint: errorsLast5m === 0 ? "all clear" : "see /ops/errors",
    },
    {
      label: "WORKERS",
      value: queue ? `${queue.workers_alive} / ${queue.workers_total}` : "—",
      icon: Cpu,
      tone: (queue && queue.workers_alive < queue.workers_total ? "warning" : "success") as StatTone,
      hint: "job_worker pool",
    },
    {
      label: "HOT LEADS",
      value: stats.data?.hot_leads ?? 0,
      icon: Sparkles,
      tone: "info" as StatTone,
      hint: "interested + form_sent",
    },
  ];

  return (
    <AppShell
      title="Operations dashboard"
      subtitle="Live calls · queue depth · worker health · recent errors"
    >
      <div className="space-y-7">
        <HeaderActions connState={connState} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {KPIS.map((k) => (
            <StatCard key={k.label} {...k} />
          ))}
        </div>
        <RecentActivityCard series={activitySeries} activeCalls={activeCallsCount} errors5m={errorsLast5m} />
        <ActiveCallsPreview activeCount={activeCallsCount} />
        <DesignReference />
      </div>
    </AppShell>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function HeaderActions({ connState }: { connState: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <StatusPill
          tone={connState === "open" ? "success" : connState === "connecting" ? "warning" : "danger"}
          label={
            connState === "open"
              ? "Backend healthy"
              : connState === "connecting"
              ? "Connecting…"
              : connState === "error"
              ? "Realtime stream down"
              : "Not connected"
          }
        />
        <StatusPill tone="info" label="SSE pipeline" dot={false} />
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/bank/batch"
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <PlusCircle className="h-4 w-4" />
          Batch upload
        </Link>
        <Link href="/ops/live" className="btn-solid">
          <Radio className="h-4 w-4" />
          Live calls
        </Link>
      </div>
    </div>
  );
}

function RecentActivityCard({
  series,
  activeCalls,
  errors5m,
}: {
  series: ReturnType<typeof bucketActivity>;
  activeCalls: number;
  errors5m: number;
}) {
  const totalCalls = series.reduce((a, b) => a + b.calls, 0);
  const totalErrors = series.reduce((a, b) => a + b.errors, 0);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-4">
        <div className="space-y-1">
          <CardTitle className="text-lg">Recent activity</CardTitle>
          <CardDescription>
            Last 2 minutes · 10-second buckets · {totalCalls} call event
            {totalCalls === 1 ? "" : "s"} · {totalErrors} error
            {totalErrors === 1 ? "" : "s"}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="info" className="gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse-dot" />
            Calls · {activeCalls}
          </Badge>
          {errors5m > 0 && (
            <Badge variant="destructive" className="gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              Errors · {errors5m}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ActivityChart data={series} />
      </CardContent>
    </Card>
  );
}

function ActiveCallsPreview({ activeCount }: { activeCount: number }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-4">
        <div className="space-y-1">
          <CardTitle className="text-lg">Live call monitor</CardTitle>
          <CardDescription>
            {activeCount === 0
              ? "No calls in-flight right now. Cards appear here within ~200 ms of dispatch."
              : `${activeCount} call${activeCount === 1 ? "" : "s"} in-flight — hop to /ops/live for the full grid.`}
          </CardDescription>
        </div>
        <Badge variant={activeCount > 0 ? "info" : "secondary"} className="font-mono text-[10px] uppercase">
          {activeCount} active
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="grid place-items-center rounded-xl border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-card shadow-sm">
            <Radio className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-3 text-sm font-semibold">
            {activeCount === 0 ? "Ready for the next batch" : "Cards on /ops/live"}
          </div>
          <div className="mt-1 max-w-sm text-xs text-muted-foreground">
            Upload a CSV from{" "}
            <Link href="/bank/batch" className="font-medium text-primary hover:underline">
              Batch
            </Link>{" "}
            — the dispatcher picks it up within seconds, and live cards appear at{" "}
            <Link href="/ops/live" className="font-medium text-primary hover:underline">
              /ops/live
            </Link>
            .
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Link href="/bank/batch" className="btn-gradient">
              <PlusCircle className="h-4 w-4" />
              Upload a batch
            </Link>
            <Link href="/ops/live" className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted">
              View live grid
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DesignReference() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2.5">
          <span className="badge-icon bg-primary/10 text-primary ring-primary/20">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <CardTitle className="text-base">Design language</CardTitle>
            <CardDescription className="text-xs">
              VirtualVaani aesthetic · Sen font · cream + dark navy + admin purple
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Status pills
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="success" label="Connected" />
            <StatusPill tone="info" label="Dialing" />
            <StatusPill tone="warning" label="Cooldown 2m 14s" />
            <StatusPill tone="danger" label="Circuit open" />
            <StatusPill tone="neutral" label="Pending" />
            <StatusPill tone="success" label="Healthy" dot={false} />
          </div>
        </div>
        <Separator />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              CTAs
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-solid">
                <PlusCircle className="h-4 w-4" />
                Dark navy
              </button>
              <button className="btn-gradient">
                <PlusCircle className="h-4 w-4" />
                Blue gradient
              </button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
            </div>
          </div>
          <div>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Badges
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="default">Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="success">Success</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="info">Info</Badge>
              <Badge variant="outline">Outline</Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
