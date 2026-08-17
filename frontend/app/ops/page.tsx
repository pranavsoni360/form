"use client";

import * as React from "react";
import { opsFetch } from "@/lib/ops-fetch";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  Briefcase,
  CircleDot,
  Clock,
  Cpu,
  Eye,
  Flame,
  GraduationCap,
  HeartPulse,
  PhoneCall,
  PhoneOff,
  PlusCircle,
  Radio,
  Sparkles,
  TimerReset,
  User as UserIcon,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatusPill } from "@/components/shared/StatusPill";
import { StatCard, type StatTone } from "@/components/ops/StatCard";
import { ActivityChart } from "@/components/ops/ActivityChart";
import {
  CallDetailDialog,
  fmtDuration,
  maskPhone,
  statusVariant,
} from "@/components/ops/CallDetailDialog";
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
import { Skeleton } from "@/components/ui/skeleton";
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
  warm_leads?: number;
  pending_calls?: number;
  not_answered?: number;
  loan_interests?: { education?: number; business?: number; personal?: number };
  calling_hours?: { start?: string; end?: string; currently_active?: boolean };
  by_status?: Record<string, number>;
  by_category?: Record<string, number>;
}

interface RecentCall {
  id?: string;
  _id?: string;
  customer_name?: string;
  name?: string;
  phone: string;
  status?: string;
  call_status?: string;
  lead_quality?: string;
  call_analysis?: { lead_quality?: string } | null;
  loan_type?: string;
  loan_type_interested?: string;
  whatsapp_form_sent?: boolean;
  form_sent?: boolean;
  call_duration?: number;
  call_duration_seconds?: number;
  started_at?: string;
  created_at?: string;
  call_start_time?: string;
}

/* ───────────────────────────── Page ──────────────────────────────────── */

export default function OpsOverviewPage() {
  // REST snapshot — today's volume + lead counts
  const stats = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/agent/dashboard-stats`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // Recent calls (top 10) — same endpoint old /agent home tab used
  const recent = useQuery<{ calls?: RecentCall[]; recent_calls?: RecentCall[] }>({
    queryKey: ["recent-calls"],
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/agent/recent_calls?limit=10`, {
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

  // Detail dialog
  const [openCallId, setOpenCallId] = React.useState<string | null>(null);
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

  const callingHours = stats.data?.calling_hours;
  const callingActive = Boolean(callingHours?.currently_active);
  const hoursWindow = callingHours
    ? `${callingHours.start ?? "—"} → ${callingHours.end ?? "—"}`
    : undefined;

  // KPI tiles. First strip = today's call funnel (parity with legacy
  // /agent dashboard tiles). Second strip = system health (SSE-driven).
  const FUNNEL_KPIS = [
    {
      label: "CALLS TODAY",
      value: stats.data?.total_calls ?? 0,
      icon: PhoneCall,
      tone: "info" as StatTone,
      hint: `${stats.data?.whatsapp_forms_sent ?? 0} forms · ${stats.data?.pending_calls ?? 0} pending`,
    },
    {
      label: "HOT LEADS",
      value: stats.data?.hot_leads ?? 0,
      icon: Sparkles,
      tone: "info" as StatTone,
      hint: "interested + qualified",
    },
    {
      label: "WARM LEADS",
      value: stats.data?.warm_leads ?? 0,
      icon: HeartPulse,
      tone: "warning" as StatTone,
      hint: "interested · needs nurture",
    },
    {
      label: "PENDING CALLS",
      value: stats.data?.pending_calls ?? 0,
      icon: TimerReset,
      tone: ((stats.data?.pending_calls ?? 0) > 0 ? "warning" : "neutral") as StatTone,
      hint: "status = Pending",
    },
    {
      label: "NOT ANSWERED",
      value: stats.data?.not_answered ?? 0,
      icon: PhoneOff,
      tone: ((stats.data?.not_answered ?? 0) > 0 ? "warning" : "neutral") as StatTone,
      hint: "no-answer + failed",
    },
    {
      label: "CALLING HOURS",
      value: callingActive ? "ON" : "OFF",
      icon: Clock,
      tone: (callingActive ? "success" : "neutral") as StatTone,
      hint: hoursWindow,
    },
  ];

  const SYSTEM_KPIS = [
    {
      label: "ACTIVE NOW",
      value: activeCallsCount,
      icon: CircleDot,
      tone: (activeCallsCount > 0 ? "success" : "neutral") as StatTone,
      hint: connState === "open" ? "live SSE" : "stream offline",
    },
    {
      label: "WORKER QUEUE",
      value: queue?.pending ?? 0,
      icon: Activity,
      tone: ((queue?.pending ?? 0) > 50 ? "warning" : "info") as StatTone,
      hint: queue ? `${queue.running} running · ${queue.dead} dead` : "job_worker pool",
    },
    {
      label: "WORKERS",
      value: queue ? `${queue.workers_alive} / ${queue.workers_total}` : "—",
      icon: Cpu,
      tone: (queue && queue.workers_alive < queue.workers_total ? "warning" : "success") as StatTone,
      hint: "job_worker pool",
    },
    {
      label: "ERRORS · 5M",
      value: errorsLast5m,
      icon: Flame,
      tone: (errorsLast5m > 0 ? "danger" : "success") as StatTone,
      hint: errorsLast5m === 0 ? "all clear" : "see /ops/errors",
    },
  ];

  return (
    <AppShell
      title="Operations dashboard"
      subtitle="Live calls · queue depth · worker health · recent errors"
    >
      <div className="space-y-7">
        <HeaderActions connState={connState} />
        <KpiSectionLabel label="Today's call funnel" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FUNNEL_KPIS.map((k) => (
            <StatCard key={k.label} {...k} />
          ))}
        </div>
        <KpiSectionLabel label="System health" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {SYSTEM_KPIS.map((k) => (
            <StatCard key={k.label} {...k} />
          ))}
        </div>
        <InterestCategoriesRow loans={stats.data?.loan_interests} />
        <RecentActivityCard series={activitySeries} activeCalls={activeCallsCount} errors5m={errorsLast5m} />
        <RecentCallsCard
          rows={(recent.data?.recent_calls ?? recent.data?.calls ?? [])}
          loading={recent.isLoading}
          onOpen={(id) => setOpenCallId(id)}
        />
        <ActiveCallsPreview activeCount={activeCallsCount} />
        <DesignReference />
      </div>

      <CallDetailDialog
        callId={openCallId}
        open={Boolean(openCallId)}
        onClose={() => setOpenCallId(null)}
      />
    </AppShell>
  );
}

/* ───────────────────────── KPI section label ─────────────────────────── */

function KpiSectionLabel({ label }: { label: string }) {
  return (
    <div className="-mb-3 px-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
      {label}
    </div>
  );
}

/* ───────────────────────── Interest categories ───────────────────────── */

function InterestCategoriesRow({ loans }: { loans?: DashboardStats["loan_interests"] }) {
  const edu = loans?.education ?? 0;
  const biz = loans?.business ?? 0;
  const per = loans?.personal ?? 0;
  const sum = edu + biz + per;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Loan interest categories</CardTitle>
        <CardDescription>
          {sum > 0 ? `${sum} customer${sum === 1 ? "" : "s"} expressed interest` : "Nothing categorised yet"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <InterestPill label="Education" count={edu} icon={GraduationCap} tone="info" />
          <InterestPill label="Business" count={biz} icon={Briefcase} tone="success" />
          <InterestPill label="Personal" count={per} icon={UserIcon} tone="warning" />
        </div>
      </CardContent>
    </Card>
  );
}

function InterestPill({
  label, count, icon: Icon, tone,
}: {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "info" | "success" | "warning";
}) {
  const bg =
    tone === "info" ? "bg-info/10 text-info ring-info/20" :
    tone === "success" ? "bg-success/10 text-success ring-success/20" :
    "bg-warning/10 text-[hsl(var(--warning))] ring-warning/20";
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className={cn("badge-icon ring-1", bg)}>
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <div className="text-sm font-semibold text-foreground">{label}</div>
          <div className="text-[10px] text-muted-foreground">interested customers</div>
        </div>
      </div>
      <div className="font-mono text-2xl font-bold tabular-nums text-foreground">
        {count.toLocaleString()}
      </div>
    </div>
  );
}

/* ───────────────────────── Recent calls ──────────────────────────────── */

function RecentCallsCard({
  rows,
  loading,
  onOpen,
}: {
  rows: RecentCall[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">Recent calls</CardTitle>
          <CardDescription>
            Last 10 completed/in-flight calls. Click a row for full details + transcript.
          </CardDescription>
        </div>
        <Link
          href="/ops/calls"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          View all
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="grid place-items-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <PhoneCall className="h-5 w-5 text-muted-foreground" />
            <div className="mt-2 text-sm font-medium">No calls yet</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Upload a batch from <Link href="/ops/batch" className="text-primary hover:underline">/ops/batch</Link>.
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r, i) => {
              const id = r.id || r._id || "";
              const lq = r.call_analysis?.lead_quality ?? r.lead_quality;
              return (
                <button
                  // Defensive: index suffix guarantees uniqueness even if
                  // backend ever returns rows with neither id nor phone.
                  key={id || r.phone || `row-${i}`}
                  type="button"
                  onClick={() => id && onOpen(id)}
                  className="flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {r.customer_name || r.name || "Customer"}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {maskPhone(r.phone)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {lq && <LeadDot q={lq} />}
                    <Badge variant={statusVariant(r.status || r.call_status || "")} className="hidden sm:inline-flex">
                      {r.status || r.call_status || "—"}
                    </Badge>
                    <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">
                      {fmtDuration(r.call_duration_seconds ?? r.call_duration ?? 0)}
                    </span>
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LeadDot({ q }: { q: string }) {
  const cls =
    q === "hot" ? "bg-destructive" :
    q === "warm" ? "bg-[hsl(var(--warning))]" :
    q === "cold" ? "bg-muted-foreground/40" :
    "bg-muted-foreground/20";
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full", cls)}
      title={`Lead: ${q}`}
      aria-label={`Lead quality ${q}`}
    />
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
          href="/ops/batch"
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
  const peakCalls = Math.max(...series.map((d) => d.calls), 0);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-4">
        <div className="space-y-1">
          <CardTitle className="text-lg">Recent activity</CardTitle>
          <CardDescription>
            Live call and error events · stacked area · last 2 minutes
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="info" className="gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse-dot" />
            Live · {activeCalls}
          </Badge>
          {errors5m > 0 && (
            <Badge variant="destructive" className="gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              Errors · {errors5m}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mini stat strip */}
        <div className="grid grid-cols-3 divide-x divide-border rounded-lg border bg-muted/30 text-center">
          <div className="py-2.5 px-3">
            <p className="text-[11px] text-muted-foreground">Calls (2 min)</p>
            <p className="text-xl font-bold tabular-nums" style={{ color: "hsl(217 91% 60%)" }}>{totalCalls}</p>
          </div>
          <div className="py-2.5 px-3">
            <p className="text-[11px] text-muted-foreground">Errors (2 min)</p>
            <p className="text-xl font-bold tabular-nums" style={{ color: totalErrors > 0 ? "hsl(0 84% 60%)" : undefined }}>{totalErrors}</p>
          </div>
          <div className="py-2.5 px-3">
            <p className="text-[11px] text-muted-foreground">Peak / bucket</p>
            <p className="text-xl font-bold tabular-nums">{peakCalls}</p>
          </div>
        </div>
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
            <Link href="/ops/batch" className="font-medium text-primary hover:underline">
              Batch
            </Link>{" "}
            — the dispatcher picks it up within seconds, and live cards appear at{" "}
            <Link href="/ops/live" className="font-medium text-primary hover:underline">
              /ops/live
            </Link>
            .
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Link href="/ops/batch" className="btn-gradient">
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
              Finix aesthetic · Sen font · cream + dark navy + admin purple
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
