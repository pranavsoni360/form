"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Layers,
  Skull,
  Timer,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { FilterPills, type FilterOption } from "@/components/ops/FilterPills";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useEventStream } from "@/lib/realtime/useEventStream";
import { useRealtimeConnection } from "@/lib/realtime/RealtimeProvider";
import {
  initialWorkersState,
  workersReducer,
  type WorkerEntry,
  type WorkersState,
} from "@/lib/realtime/reducers";

/* Health buckets (matches plan):
   green  <30s  since last heartbeat
   amber  <90s
   red    older → considered down */
const HEALTH_BUCKETS = {
  healthy: 30_000,
  idle: 90_000,
} as const;

type Health = "healthy" | "idle" | "down";

function healthOf(w: WorkerEntry, nowMs: number): Health {
  const elapsed = nowMs - w.last_heartbeat_at;
  if (elapsed < HEALTH_BUCKETS.healthy) return "healthy";
  if (elapsed < HEALTH_BUCKETS.idle) return "idle";
  return "down";
}

type Filter = "all" | Health;

/* ───────────────────────────── Page ──────────────────────────────────── */

export default function OpsWorkersPage() {
  const state = useEventStream<WorkersState>(
    "workers",
    workersReducer,
    initialWorkersState
  );
  const { state: connState } = useRealtimeConnection();

  // Tick once per second so "last heartbeat" elapsed values + health
  // buckets reflect the wall clock between events.
  const [tickNow, setTickNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const workers = React.useMemo(() => Object.values(state.byId), [state.byId]);

  const counts = React.useMemo(() => {
    let healthy = 0, idle = 0, down = 0;
    for (const w of workers) {
      const h = healthOf(w, tickNow);
      if (h === "healthy") healthy += 1;
      else if (h === "idle") idle += 1;
      else down += 1;
    }
    return { total: workers.length, healthy, idle, down };
  }, [workers, tickNow]);

  const [filter, setFilter] = React.useState<Filter>("all");
  const filteredWorkers = React.useMemo(() => {
    if (filter === "all") return workers;
    return workers.filter((w) => healthOf(w, tickNow) === filter);
  }, [workers, filter, tickNow]);

  const filterOptions: ReadonlyArray<FilterOption<Filter>> = [
    { value: "all", label: "All" },
    { value: "healthy", label: "Healthy" },
    { value: "idle", label: "Idle" },
    { value: "down", label: "Down" },
  ];
  const filterCounts: Partial<Record<Filter, number>> = {
    all: counts.total,
    healthy: counts.healthy,
    idle: counts.idle,
    down: counts.down,
  };

  const queue = state.queueDepth;

  const columns: ReadonlyArray<DataTableColumn<WorkerEntry>> = [
    {
      key: "id",
      header: "Worker",
      render: (w) => (
        <div className="space-y-0.5">
          <div className="font-mono text-xs font-semibold text-foreground">
            {prettyWorkerId(w.worker_id)}
          </div>
          <div className="text-[10px] text-muted-foreground capitalize">{w.kind.replace(/_/g, " ")}</div>
        </div>
      ),
    },
    {
      key: "health",
      header: "Health",
      render: (w) => <HealthDot worker={w} nowMs={tickNow} />,
    },
    {
      key: "status",
      header: "Status",
      render: (w) => (
        <Badge variant={statusVariant(w.status)} className="capitalize">
          {w.status.replace(/_/g, " ")}
        </Badge>
      ),
    },
    {
      key: "jobs",
      header: "Jobs done",
      align: "right",
      render: (w) => (
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {w.jobs_processed.toLocaleString()}
        </span>
      ),
    },
    {
      key: "uptime",
      header: "Uptime",
      align: "right",
      render: (w) => (
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {fmtUptime(w.uptime_seconds)}
        </span>
      ),
    },
    {
      key: "last",
      header: "Last heartbeat",
      align: "right",
      render: (w) => (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {fmtElapsed(tickNow - w.last_heartbeat_at)} ago
        </span>
      ),
    },
  ];

  return (
    <AppShell
      title="Workers"
      subtitle={`${counts.total} worker${counts.total === 1 ? "" : "s"} · queue depth ${
        queue?.pending ?? 0
      } pending · live SSE`}
    >
      <div className="space-y-6">
        {/* Stat row */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="WORKERS ALIVE"
            value={`${counts.healthy + counts.idle} / ${counts.total}`}
            icon={Cpu}
            tone={counts.down > 0 ? "warning" : "success"}
          />
          <StatCard
            label="QUEUE PENDING"
            value={queue?.pending ?? 0}
            icon={Activity}
            tone={(queue?.pending ?? 0) > 50 ? "warning" : "info"}
            hint={queue ? `${queue.failed} retrying · ${queue.running} running` : undefined}
          />
          <StatCard
            label="DEAD JOBS"
            value={queue?.dead ?? 0}
            icon={Skull}
            tone={(queue?.dead ?? 0) > 0 ? "danger" : "neutral"}
            hint="hit max_attempts · needs intervention"
          />
          <StatCard
            label="DOWN WORKERS"
            value={counts.down}
            icon={AlertTriangle}
            tone={counts.down > 0 ? "danger" : "success"}
            hint="no heartbeat for 90s+"
          />
        </div>

        {/* Filter pills */}
        <FilterPills
          options={filterOptions}
          value={filter}
          onChange={setFilter}
          counts={filterCounts}
        />

        {/* Table */}
        <DataTable
          columns={columns}
          rows={filteredWorkers}
          rowKey={(w) => w.worker_id}
          empty={<EmptyBox connState={connState} />}
        />
      </div>
    </AppShell>
  );
}

/* ───────────────────────────── Helpers ───────────────────────────────── */

/** Hostname:pid:nonce:w0 → "VGCBS-LAP36 · w0" */
function prettyWorkerId(id: string): string {
  const parts = id.split(":");
  if (parts.length < 4) return id;
  const host = parts[0];
  const wnum = parts[parts.length - 1];
  return `${host} · ${wnum}`;
}

function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function statusVariant(s: string): "success" | "warning" | "destructive" | "secondary" | "info" {
  if (s === "active" || s === "starting") return "info";
  if (s === "idle") return "secondary";
  if (s === "stopped") return "warning";
  if (s.includes("error") || s === "dead") return "destructive";
  return "success";
}

function HealthDot({ worker, nowMs }: { worker: WorkerEntry; nowMs: number }) {
  const h = healthOf(worker, nowMs);
  const META = {
    healthy: { color: "bg-success", label: "Healthy", ring: "ring-success/30 bg-success/10 text-success" },
    idle:    { color: "bg-warning", label: "Idle",    ring: "ring-warning/30 bg-warning/10 text-[hsl(var(--warning))]" },
    down:    { color: "bg-destructive animate-pulse-dot", label: "Down", ring: "ring-destructive/30 bg-destructive/10 text-destructive" },
  } as const;
  const m = META[h];
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1",
      m.ring
    )}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.color)} aria-hidden />
      {m.label}
    </span>
  );
}

function EmptyBox({ connState }: { connState: string }) {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
        <Layers className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="mt-3 text-sm font-semibold">
        {connState === "open" ? "Waiting for worker heartbeats…" : "Not connected to live stream"}
      </div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        {connState === "open"
          ? "Workers emit a heartbeat every ~2 seconds. The first row should appear within a moment of subscribing."
          : "Log in as admin to receive live worker telemetry on this page."}
      </div>
      <div className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Timer className="h-3 w-3" />
        <span className="font-mono">heartbeat interval = 2s</span>
      </div>
    </div>
  );
}
