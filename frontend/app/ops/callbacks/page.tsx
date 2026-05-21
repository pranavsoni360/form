"use client";

/**
 * /ops/callbacks — scheduled callbacks list.
 *
 * Mirrors the "Scheduled Callbacks" table that lived on the old /agent
 * dashboard's home tab (lines 1271–1292 of agent-dashboard.html). Backend:
 * GET /api/agent/scheduled-callbacks?limit=50 → { scheduled: [...], count }
 *
 * Auth: none required (operator mode).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Eye, RefreshCw, RotateCcw } from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { CallDetailDialog, maskPhone } from "@/components/ops/CallDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL } from "@/lib/api";

interface CallbackRow {
  id?: string;
  _id?: string;
  customer_name?: string;
  name?: string;
  phone: string;
  scheduled_callback_at?: string | null;
  callback_reason?: string | null;
  retry_count?: number;
  language?: string;
}

interface CallbacksResponse {
  scheduled: CallbackRow[];
  count: number;
}

export default function OpsCallbacksPage() {
  const [openCallId, setOpenCallId] = React.useState<string | null>(null);
  const query = useQuery<CallbacksResponse>({
    queryKey: ["scheduled-callbacks"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/agent/scheduled-callbacks?limit=50`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const rows = query.data?.scheduled ?? [];
  const total = query.data?.count ?? 0;

  // Bucket counts: next hour vs later today vs later
  const buckets = React.useMemo(() => {
    const now = Date.now();
    const oneHour = 60 * 60_000;
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const endMs = endOfDay.getTime();
    let nextHour = 0, today = 0, later = 0;
    for (const r of rows) {
      if (!r.scheduled_callback_at) continue;
      const t = new Date(r.scheduled_callback_at).getTime();
      if (Number.isNaN(t)) continue;
      if (t - now <= oneHour) nextHour += 1;
      else if (t <= endMs) today += 1;
      else later += 1;
    }
    return { nextHour, today, later };
  }, [rows]);

  const columns: ReadonlyArray<DataTableColumn<CallbackRow>> = [
    {
      key: "customer",
      header: "Customer",
      render: (r) => (
        <div className="space-y-0.5">
          <div className="text-sm font-semibold text-foreground">
            {r.customer_name || r.name || "Customer"}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {maskPhone(r.phone)}
          </div>
        </div>
      ),
    },
    {
      key: "when",
      header: "Scheduled for",
      render: (r) => <ScheduledPill iso={r.scheduled_callback_at} />,
    },
    {
      key: "reason",
      header: "Reason",
      render: (r) => (
        <span className="text-xs text-foreground/80 capitalize">
          {(r.callback_reason || "—").replace(/_/g, " ")}
        </span>
      ),
    },
    {
      key: "retry",
      header: "Retry",
      align: "center",
      render: (r) => (
        <Badge variant="secondary" className="gap-1">
          <RotateCcw className="h-3 w-3" />
          {r.retry_count ?? 0}
        </Badge>
      ),
    },
    {
      key: "language",
      header: "Lang",
      render: (r) => (
        <span className="text-[11px] uppercase text-muted-foreground">
          {r.language || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpenCallId(r.id || r._id || "");
          }}
          className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="View call details"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
      ),
    },
  ];

  return (
    <AppShell
      title="Scheduled callbacks"
      subtitle={`${total} call${total === 1 ? "" : "s"} queued for retry · ordered by scheduled time`}
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="TOTAL QUEUED" value={total} icon={CalendarClock} tone="info" />
          <StatCard label="NEXT HOUR" value={buckets.nextHour} icon={CalendarClock} tone={buckets.nextHour > 0 ? "warning" : "neutral"} />
          <StatCard label="LATER TODAY" value={buckets.today} icon={CalendarClock} tone="neutral" />
          <StatCard label="FUTURE" value={buckets.later} icon={CalendarClock} tone="neutral" />
        </div>

        <div className="flex items-center justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {query.isLoading ? (
          <div className="space-y-2 rounded-2xl border border-border bg-card p-4 shadow-sm">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : query.error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
            Couldn&apos;t load callbacks: <span className="font-mono">{(query.error as Error).message}</span>
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id || r._id || r.phone}
            onRowClick={(r) => setOpenCallId(r.id || r._id || "")}
            empty={<EmptyBox />}
          />
        )}
      </div>

      <CallDetailDialog
        callId={openCallId}
        open={Boolean(openCallId)}
        onClose={() => setOpenCallId(null)}
      />
    </AppShell>
  );
}

function ScheduledPill({ iso }: { iso?: string | null }) {
  if (!iso) return <span className="text-xs text-muted-foreground">—</span>;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return <span className="font-mono text-xs">{iso}</span>;
  const deltaMs = t - Date.now();
  const isPast = deltaMs < 0;
  const tone = isPast
    ? "destructive"
    : deltaMs < 60 * 60_000
    ? "warning"
    : "secondary";
  const human = fmtRelative(deltaMs);
  const exact = new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <div className="space-y-0.5">
      <Badge variant={tone}>{human}</Badge>
      <div className="font-mono text-[10px] text-muted-foreground">{exact}</div>
    </div>
  );
}

function fmtRelative(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const past = deltaMs < 0;
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return past ? `${sec}s ago` : `in ${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return past ? `${h}h ago` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return past ? `${d}d ago` : `in ${d}d`;
}

function EmptyBox() {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
        <CalendarClock className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="mt-3 text-sm font-semibold">No callbacks scheduled</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        When a customer asks to be called back at a specific time, the row will
        appear here. The dispatcher re-dials at the scheduled time during
        working hours.
      </div>
    </div>
  );
}
