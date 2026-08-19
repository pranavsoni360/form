"use client";

import * as React from "react";
import { ShieldCheck, LogIn, LogOut, XCircle, Activity as ActivityIcon, Globe } from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { cn } from "@/lib/utils";
import { opsFetch } from "@/lib/ops-fetch";

/* ── Shared types (mirror the /api/admin/audit/* payloads) ─────────────── */
type Geo = {
  country?: string | null; country_code?: string | null;
  region?: string | null; city?: string | null;
  lat?: number | null; lon?: number | null;
} | null;

type LoginRow = {
  id: string; created_at: string; event: string; actor_type: string;
  actor_username: string | null; username_tried: string | null;
  actor_role: string | null; bank_id: string | null; success: boolean;
  failure_reason: string | null; ip_address: string | null;
  location: Geo; device_fingerprint: string | null;
};

type ActivityRow = {
  id: string; created_at: string; actor_type: string;
  actor_username: string | null; actor_role: string | null; bank_id: string | null;
  action: string; module: string; endpoint: string; http_method: string;
  http_status: number | null; result: string; ip_address: string | null;
  location: Geo; duration_ms: number | null;
};

type Tab = "logins" | "activity";
const PAGE = 50;

export default function OpsAuditPage() {
  const [tab, setTab] = React.useState<Tab>("logins");
  const [filter, setFilter] = React.useState<string>("all");
  const [q, setQ] = React.useState("");
  const [qDebounced, setQDebounced] = React.useState("");
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // debounce search
  React.useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // reset paging when tab / filter / search changes
  React.useEffect(() => { setOffset(0); }, [tab, filter, qDebounced]);

  const load = React.useCallback(async (append: boolean) => {
    setLoading(true); setErr(null);
    const off = append ? offset : 0;
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
    if (qDebounced) params.set("q", qDebounced);
    if (filter !== "all") {
      if (tab === "logins") {
        if (filter === "success") params.set("event", "login_success");
        else if (filter === "failure") params.set("event", "login_failure");
        else if (filter === "logout") params.set("event", "logout");
      } else {
        params.set("result", filter); // success | denied | failure
      }
    }
    try {
      const res = await opsFetch(`/api/admin/audit/${tab}?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) { setErr(`HTTP ${res.status}`); setLoading(false); return; }
      const data = await res.json();
      setTotal(data.total ?? 0);
      setRows((prev) => (append ? [...prev, ...(data.items ?? [])] : (data.items ?? [])));
    } catch (e: any) {
      setErr(e?.message ?? "request failed");
    } finally {
      setLoading(false);
    }
  }, [tab, filter, qDebounced, offset]);

  // initial + on filter/tab/search change (offset back to 0)
  React.useEffect(() => { load(false); /* eslint-disable-next-line */ }, [tab, filter, qDebounced]);
  // load-more when offset advances
  React.useEffect(() => { if (offset > 0) load(true); /* eslint-disable-next-line */ }, [offset]);

  /* ── Header stats (from the loaded page — a live sample, not a full scan) ── */
  const stats = React.useMemo(() => {
    if (tab === "logins") {
      const r = rows as LoginRow[];
      return {
        a: { label: "SHOWING", value: r.length, icon: ShieldCheck, tone: "info" as const },
        b: { label: "SUCCESS", value: r.filter((x) => x.event === "login_success").length, icon: LogIn, tone: "success" as const },
        c: { label: "FAILED", value: r.filter((x) => x.event === "login_failure").length, icon: XCircle, tone: "danger" as const },
        d: { label: "LOCATIONS", value: new Set(r.map((x) => x.location?.city).filter(Boolean)).size, icon: Globe, tone: "neutral" as const },
      };
    }
    const r = rows as ActivityRow[];
    return {
      a: { label: "SHOWING", value: r.length, icon: ActivityIcon, tone: "info" as const },
      b: { label: "SUCCESS", value: r.filter((x) => x.result === "success").length, icon: ShieldCheck, tone: "success" as const },
      c: { label: "DENIED/FAIL", value: r.filter((x) => x.result !== "success").length, icon: XCircle, tone: "danger" as const },
      d: { label: "LOCATIONS", value: new Set(r.map((x) => x.location?.city).filter(Boolean)).size, icon: Globe, tone: "neutral" as const },
    };
  }, [rows, tab]);

  const filterOptions = tab === "logins"
    ? [["all", "All"], ["success", "Success"], ["failure", "Failed"], ["logout", "Logout"]]
    : [["all", "All"], ["success", "Success"], ["denied", "Denied"], ["failure", "Failure"]];

  const loginCols: ReadonlyArray<DataTableColumn<LoginRow>> = [
    { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
    { key: "event", header: "Event", render: (r) => <EventBadge event={r.event} /> },
    {
      key: "user", header: "User",
      render: (r) => (
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-foreground">{r.actor_username || r.username_tried || "—"}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.actor_type}{r.actor_role ? ` · ${r.actor_role}` : ""}</div>
          {r.failure_reason && <div className="text-[10px] text-rose-500">{r.failure_reason}</div>}
        </div>
      ),
    },
    { key: "loc", header: "Location", render: (r) => <LocCell ip={r.ip_address} geo={r.location} /> },
    {
      key: "device", header: "Device",
      render: (r) => r.device_fingerprint
        ? <span className="font-mono text-[10px] text-muted-foreground" title={r.device_fingerprint}>{r.device_fingerprint.slice(0, 10)}</span>
        : <span className="text-muted-foreground">—</span>,
    },
  ];

  const activityCols: ReadonlyArray<DataTableColumn<ActivityRow>> = [
    { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
    {
      key: "actor", header: "Actor",
      render: (r) => (
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-foreground">{r.actor_username || "—"}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.actor_type}</div>
        </div>
      ),
    },
    {
      key: "action", header: "Action",
      render: (r) => (
        <div className="space-y-0.5">
          <div className="font-mono text-xs font-semibold text-foreground">{r.http_method} {r.endpoint}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.module}</div>
        </div>
      ),
    },
    {
      key: "result", header: "Result",
      render: (r) => (
        <div className="flex items-center gap-2">
          <ResultBadge result={r.result} />
          {r.http_status != null && <span className="font-mono text-[10px] text-muted-foreground">{r.http_status}</span>}
          {r.duration_ms != null && <span className="font-mono text-[10px] text-muted-foreground/70">{r.duration_ms}ms</span>}
        </div>
      ),
    },
    { key: "loc", header: "Location", render: (r) => <LocCell ip={r.ip_address} geo={r.location} /> },
  ];

  const hasMore = rows.length < total;

  return (
    <AppShell
      title="Audit trail"
      subtitle="Tamper-proof (append-only) record of every login and mutating action — with client IP + geolocation"
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard {...stats.a} />
          <StatCard {...stats.b} />
          <StatCard {...stats.c} />
          <StatCard {...stats.d} hint={`${total} total`} />
        </div>

        {/* Tab switch */}
        <div className="flex items-center gap-2">
          <TabButton active={tab === "logins"} onClick={() => { setTab("logins"); setFilter("all"); }} icon={LogIn}>Logins</TabButton>
          <TabButton active={tab === "activity"} onClick={() => { setTab("activity"); setFilter("all"); }} icon={ActivityIcon}>Activity</TabButton>
          <div className="ml-auto">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tab === "logins" ? "search user…" : "search endpoint / user…"}
              className="w-56 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        {/* Filter pills */}
        <div className="flex flex-wrap items-center gap-2">
          {filterOptions.map(([v, label]) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className={cn(
                "rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
                filter === v ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80",
              )}
            >
              {label}
            </button>
          ))}
          {loading && <span className="text-[11px] text-muted-foreground">loading…</span>}
          {err && <span className="text-[11px] text-rose-500">error: {err}</span>}
        </div>

        {tab === "logins" ? (
          <DataTable columns={loginCols} rows={rows as LoginRow[]} rowKey={(r, i) => `${r.id}-${i}`} empty={<EmptyBox />} />
        ) : (
          <DataTable columns={activityCols} rows={rows as ActivityRow[]} rowKey={(r, i) => `${r.id}-${i}`} empty={<EmptyBox />} />
        )}

        {hasMore && (
          <div className="flex justify-center">
            <button
              onClick={() => setOffset((o) => o + PAGE)}
              disabled={loading}
              className="rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {loading ? "loading…" : `Load more (${rows.length} of ${total})`}
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/* ── Cells & badges ────────────────────────────────────────────────────── */
function WhenCell({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <div className="space-y-0.5">
      <div className="text-xs tabular-nums text-foreground/80">{d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
      <div className="text-[10px] text-muted-foreground">{fmtAgo(Date.now() - d.getTime())} ago</div>
    </div>
  );
}

function LocCell({ ip, geo }: { ip: string | null; geo: Geo }) {
  const place = geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(", ") : null;
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-foreground/90">
        {place || <span className="text-muted-foreground italic">unknown</span>}
        {geo?.country_code && <span className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">{geo.country_code}</span>}
      </div>
      {ip && <div className="font-mono text-[10px] text-muted-foreground">{ip.replace(/\/32$|\/128$/, "")}</div>}
    </div>
  );
}

const EVENT_STYLE: Record<string, string> = {
  login_success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  login_failure: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  logout: "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300",
};
function EventBadge({ event }: { event: string }) {
  const Icon = event === "login_success" ? LogIn : event === "logout" ? LogOut : XCircle;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium", EVENT_STYLE[event] || "bg-muted text-muted-foreground")}>
      <Icon className="h-3 w-3" />{event.replace("login_", "")}
    </span>
  );
}

const RESULT_STYLE: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  denied: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  failure: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
};
function ResultBadge({ result }: { result: string }) {
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider", RESULT_STYLE[result] || "bg-muted text-muted-foreground")}>{result}</span>;
}

function TabButton({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
      <Icon className="h-3.5 w-3.5" />{children}
    </button>
  );
}

function EmptyBox() {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted ring-1 ring-border"><ShieldCheck className="h-5 w-5 text-muted-foreground" /></div>
      <div className="mt-3 text-sm font-semibold">Nothing here yet</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">No records match the current filter. Audit entries appear here as users log in and act on the system.</div>
    </div>
  );
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
