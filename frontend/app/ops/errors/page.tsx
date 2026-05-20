"use client";

import * as React from "react";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  Flame,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { FilterPills, type FilterOption } from "@/components/ops/FilterPills";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { ActivityChart } from "@/components/ops/ActivityChart";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useEventStream } from "@/lib/realtime/useEventStream";
import { useRealtimeConnection } from "@/lib/realtime/RealtimeProvider";
import {
  errorsReducer,
  initialErrorsState,
  type ErrorEntry,
  type ErrorsState,
} from "@/lib/realtime/reducers";
import {
  activityReducer,
  bucketActivity,
  initialActivityState,
  type ActivityState,
} from "@/lib/realtime/activity-buffer";

type Filter = "all" | "5m" | "1h" | "today";

export default function OpsErrorsPage() {
  const errors = useEventStream<ErrorsState>("errors", errorsReducer, initialErrorsState);
  const activity = useEventStream<ActivityState>(
    "errors",
    activityReducer,
    initialActivityState
  );
  const { state: connState } = useRealtimeConnection();

  // 1Hz tick so the time filters re-evaluate
  const [tickNow, setTickNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* Counts by time window */
  const cutoffs = React.useMemo(
    () => ({
      "5m": tickNow - 5 * 60_000,
      "1h": tickNow - 60 * 60_000,
      today: new Date().setHours(0, 0, 0, 0),
    }),
    [tickNow]
  );

  const counts = React.useMemo(() => {
    const buckets = { "5m": 0, "1h": 0, today: 0 };
    for (const e of errors.recent) {
      if (e.ts >= cutoffs["5m"]) buckets["5m"] += 1;
      if (e.ts >= cutoffs["1h"]) buckets["1h"] += 1;
      if (e.ts >= cutoffs.today) buckets.today += 1;
    }
    return buckets;
  }, [errors, cutoffs]);

  /* Filter + filtered list */
  const [filter, setFilter] = React.useState<Filter>("1h");
  const filtered = React.useMemo(() => {
    if (filter === "all") return errors.recent;
    return errors.recent.filter((e) => e.ts >= cutoffs[filter]);
  }, [errors, filter, cutoffs]);

  /* Activity chart — last hour, 1-min buckets */
  const series = React.useMemo(
    () => bucketActivity(activity.events, 60 * 60_000, 60_000),
    [activity, tickNow]
  );

  const filterOptions: ReadonlyArray<FilterOption<Filter>> = [
    { value: "5m", label: "Last 5 minutes" },
    { value: "1h", label: "Last hour" },
    { value: "today", label: "Today" },
    { value: "all", label: "All recent" },
  ];
  const filterCounts: Partial<Record<Filter, number>> = {
    "5m": counts["5m"],
    "1h": counts["1h"],
    today: counts.today,
    all: errors.recent.length,
  };

  const columns: ReadonlyArray<DataTableColumn<ErrorEntry>> = [
    {
      key: "time",
      header: "When",
      render: (e) => (
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {fmtAgo(tickNow - e.ts)} ago
        </span>
      ),
    },
    {
      key: "route",
      header: "Route",
      render: (e) => (
        <div className="space-y-0.5">
          <div className="font-mono text-xs font-semibold text-foreground">
            {e.method} {e.route}
          </div>
          <CorrIdPill cid={e.correlation_id} />
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      render: (e) => <Badge variant="destructive">{e.exc_type}</Badge>,
    },
    {
      key: "msg",
      header: "Message",
      render: (e) => (
        <div className="max-w-md truncate text-xs text-foreground/80">{e.message || "—"}</div>
      ),
    },
    {
      key: "sentry",
      header: "",
      render: () => (
        <a
          href={process.env.NEXT_PUBLIC_SENTRY_LINK || "https://sentry.io/"}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          Sentry
          <ExternalLink className="h-3 w-3" />
        </a>
      ),
    },
  ];

  return (
    <AppShell
      title="Errors"
      subtitle="Live exception feed · captured by the FastAPI global handler · also flowing to Sentry"
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="LAST 5M"
            value={counts["5m"]}
            icon={Flame}
            tone={counts["5m"] > 0 ? "danger" : "success"}
          />
          <StatCard
            label="LAST HOUR"
            value={counts["1h"]}
            icon={AlertTriangle}
            tone={counts["1h"] > 10 ? "danger" : counts["1h"] > 0 ? "warning" : "success"}
          />
          <StatCard
            label="TODAY"
            value={counts.today}
            icon={AlertOctagon}
            tone={counts.today > 50 ? "warning" : "neutral"}
          />
          <StatCard
            label="STREAM"
            value={connState === "open" ? "LIVE" : connState.toUpperCase()}
            icon={CheckCircle2}
            tone={connState === "open" ? "success" : "danger"}
            hint="Sentry + Telegram also fire"
          />
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <div className="text-sm font-semibold">Error rate · last hour</div>
              <div className="text-xs text-muted-foreground">
                1-minute buckets · spikes indicate something needs attention
              </div>
            </div>
            <Badge variant={counts["5m"] > 0 ? "destructive" : "secondary"} className="font-mono">
              {counts["1h"]} in window
            </Badge>
          </div>
          <ActivityChart data={series} height={180} />
        </div>

        <FilterPills options={filterOptions} value={filter} onChange={setFilter} counts={filterCounts} />

        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(e, i) => `${e.correlation_id}-${i}`}
          empty={<EmptyBox />}
        />
      </div>
    </AppShell>
  );
}

/* ───────────────────────── Helpers ───────────────────────────────────── */

function fmtAgo(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function CorrIdPill({ cid }: { cid: string }) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(cid).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    }
  };
  return (
    <button
      onClick={onCopy}
      title="Copy correlation id"
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        copied && "bg-success/10 text-success"
      )}
    >
      <ClipboardCopy className="h-2.5 w-2.5" />
      {copied ? "copied" : cid.slice(0, 8)}
    </button>
  );
}

function EmptyBox() {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-success/10 ring-1 ring-success/20">
        <CheckCircle2 className="h-5 w-5 text-success" />
      </div>
      <div className="mt-3 text-sm font-semibold">No errors right now</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        The backend&apos;s global exception handler is quiet. Any unhandled
        exception will appear here within milliseconds and also flow to Sentry
        + Telegram.
      </div>
    </div>
  );
}
