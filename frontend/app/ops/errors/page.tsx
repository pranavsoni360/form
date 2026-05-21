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
  type ErrorSource,
  type ErrorsState,
} from "@/lib/realtime/reducers";
import {
  activityReducer,
  bucketActivity,
  initialActivityState,
  type ActivityState,
} from "@/lib/realtime/activity-buffer";

type Filter = "all" | "5m" | "1h" | "today";
type SourceFilter = "all" | ErrorSource;

/** Tailwind classes per source — match design-upgrade aesthetic. */
const SOURCE_STYLES: Record<ErrorSource, string> = {
  backend: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  agent: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  livekit: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  sip: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  docker: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  postgres: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  frontend: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
};

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
  // Tracks whether the user has manually picked a filter. While false, the
  // page auto-widens the window so a fresh visit never lands on an empty
  // table when the buffer has older events (the most common case on first
  // login: ring buffer has yesterday's errors, current "1h" window is empty,
  // user thinks the page is broken).
  const [filterPinned, setFilterPinned] = React.useState(false);
  const onFilterChange = React.useCallback((f: Filter) => {
    setFilterPinned(true);
    setFilter(f);
  }, []);
  React.useEffect(() => {
    if (filterPinned || errors.recent.length === 0) return;
    // Pick the narrowest window that contains at least one event. Order:
    // 5m → 1h → today → all. This is recomputed live, so as fresh errors
    // arrive the page snaps back to the tightest meaningful window.
    const has5m = errors.recent.some((e) => e.ts >= cutoffs["5m"]);
    if (has5m) { if (filter !== "5m") setFilter("5m"); return; }
    const has1h = errors.recent.some((e) => e.ts >= cutoffs["1h"]);
    if (has1h) { if (filter !== "1h") setFilter("1h"); return; }
    const hasToday = errors.recent.some((e) => e.ts >= cutoffs.today);
    if (hasToday) { if (filter !== "today") setFilter("today"); return; }
    if (filter !== "all") setFilter("all");
  }, [filterPinned, errors, cutoffs, filter]);

  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>("all");
  const filtered = React.useMemo(() => {
    let rows = errors.recent;
    if (filter !== "all") rows = rows.filter((e) => e.ts >= cutoffs[filter]);
    if (sourceFilter !== "all") rows = rows.filter((e) => e.source === sourceFilter);
    return rows;
  }, [errors, filter, sourceFilter, cutoffs]);

  /* Per-source counts in current time-window (drives source filter pills) */
  const sourceCounts = React.useMemo(() => {
    const inWindow = filter === "all" ? errors.recent : errors.recent.filter((e) => e.ts >= cutoffs[filter]);
    const c: Partial<Record<SourceFilter, number>> = { all: inWindow.length };
    for (const e of inWindow) c[e.source] = (c[e.source] ?? 0) + 1;
    return c;
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
      key: "source",
      header: "Source",
      render: (e) => <SourceBadge source={e.source} />,
    },
    {
      key: "route",
      header: "Origin",
      render: (e) => (
        <div className="space-y-0.5">
          <div className="font-mono text-xs font-semibold text-foreground">
            {e.route === "?" && e.method === "?"
              ? <span className="text-muted-foreground italic">non-HTTP</span>
              : <>{e.method} {e.route}</>}
          </div>
          <CorrIdPill cid={e.correlation_id} />
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      render: (e) => (
        <Badge variant={e.level === "warning" ? "warning" : "destructive"}>
          {e.exc_type}
        </Badge>
      ),
    },
    {
      key: "msg",
      header: "Message",
      render: (e) => (
        <div className="max-w-md text-xs text-foreground/80">
          <div className="truncate">{e.message || "—"}</div>
          {e.trace && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                stack trace ({e.trace.length} chars)
              </summary>
              <pre className="mt-1 max-h-48 overflow-y-auto rounded bg-muted/40 p-2 font-mono text-[10px] whitespace-pre-wrap">
                {e.trace}
              </pre>
            </details>
          )}
        </div>
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

        <FilterPills options={filterOptions} value={filter} onChange={onFilterChange} counts={filterCounts} />

        {/* Source filter — only show sources that actually have events in the current window. */}
        <SourceFilterRow
          counts={sourceCounts}
          active={sourceFilter}
          onChange={setSourceFilter}
        />

        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(e, i) => `${e.correlation_id}-${i}`}
          empty={<EmptyBox hasSourceFilter={sourceFilter !== "all"} />}
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

function EmptyBox({ hasSourceFilter }: { hasSourceFilter?: boolean }) {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-success/10 ring-1 ring-success/20">
        <CheckCircle2 className="h-5 w-5 text-success" />
      </div>
      <div className="mt-3 text-sm font-semibold">
        {hasSourceFilter ? "No errors for this source" : "No errors right now"}
      </div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        {hasSourceFilter
          ? "Switch source filter back to 'All' to see everything, or wait for an event."
          : "Backend + every wired external service (agent, livekit, sip, docker, postgres) is quiet. New errors will appear here within milliseconds."}
      </div>
    </div>
  );
}

/* ───────────────────────── Source badge + filter ─────────────────────── */

function SourceBadge({ source }: { source: ErrorSource }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        SOURCE_STYLES[source],
      )}
    >
      {source}
    </span>
  );
}

const SOURCE_LABELS: Record<ErrorSource, string> = {
  backend: "Backend",
  agent: "Voice agent",
  livekit: "LiveKit",
  sip: "SIP",
  docker: "Docker",
  postgres: "Postgres",
  frontend: "Frontend",
};

function SourceFilterRow({
  counts,
  active,
  onChange,
}: {
  counts: Partial<Record<SourceFilter, number>>;
  active: SourceFilter;
  onChange: (s: SourceFilter) => void;
}) {
  // Always show "All" + only sources that have at least one event in window.
  const order: ErrorSource[] = ["backend", "agent", "livekit", "sip", "docker", "postgres", "frontend"];
  const visible = order.filter((s) => (counts[s] ?? 0) > 0);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Source:
      </span>
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn(
          "rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
          active === "all"
            ? "bg-foreground text-background"
            : "bg-muted text-muted-foreground hover:bg-muted/80",
        )}
      >
        All <span className="ml-1 font-mono">{counts.all ?? 0}</span>
      </button>
      {visible.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={cn(
            "rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
            active === s
              ? SOURCE_STYLES[s] + " ring-1 ring-foreground/30"
              : "bg-muted text-muted-foreground hover:bg-muted/80",
          )}
        >
          {SOURCE_LABELS[s]} <span className="ml-1 font-mono">{counts[s] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
