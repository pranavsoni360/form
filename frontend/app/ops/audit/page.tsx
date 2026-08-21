"use client";

import * as React from "react";
import {
  ShieldCheck, LogIn, LogOut, XCircle, Activity as ActivityIcon, Globe,
  Landmark, Gavel, GitBranch, Eye, ShieldAlert,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { cn } from "@/lib/utils";
import { opsFetch } from "@/lib/ops-fetch";
import {
  describeActivity, describePlatformAction, describeOfficerAction,
  describeSensitive, describeSecurityType,
} from "@/lib/audit-describe";

type Geo = { country?: string | null; country_code?: string | null;
  region?: string | null; city?: string | null } | null;

const PAGE = 50;

/* ── Shared cell renderers ─────────────────────────────────────────────── */
function WhenCell({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <div className="space-y-0.5 whitespace-nowrap">
      <div className="text-xs tabular-nums text-foreground/80">
        {d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </div>
      <div className="text-[10px] text-muted-foreground">{fmtAgo(Date.now() - d.getTime())} ago</div>
    </div>
  );
}

function LocCell({ ip, machineIp, machineName, geo }: { ip?: string | null; machineIp?: string | null; machineName?: string | null; geo?: Geo }) {
  const place = geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(", ") : null;
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-foreground/90">
        {place || <span className="text-muted-foreground italic">unknown</span>}
        {geo?.country_code && <span className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">{geo.country_code}</span>}
      </div>
      {ip && <div className="font-mono text-[10px] text-muted-foreground">{ip.replace(/\/\d+$/, "")}</div>}
      {(machineName || machineIp) && (
        <div className="font-mono text-[10px] text-sky-600 dark:text-sky-400">
          🖥 {machineName || ""}{machineIp ? ` ${machineIp.replace(/\/\d+$/, "")}` : ""}
        </div>
      )}
    </div>
  );
}

function Pill({ text, styles }: { text: string; styles: string }) {
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium", styles)}>{text}</span>;
}

const EVENT_STYLE: Record<string, string> = {
  login_success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  login_failure: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  logout: "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300",
};
const RESULT_STYLE: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  denied: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  failure: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
};
const STATUS_STYLE = "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300";

function StatusFlow({ from, to }: { from?: string | null; to?: string | null }) {
  return (
    <div className="flex items-center gap-1 text-[10px]">
      {from && <span className="text-muted-foreground">{from}</span>}
      <span className="text-muted-foreground">→</span>
      <Pill text={to || "?"} styles={STATUS_STYLE} />
    </div>
  );
}

function Diff({ before, after }: { before?: any; after?: any }) {
  const keys = Array.from(new Set([...(before ? Object.keys(before) : []), ...(after ? Object.keys(after) : [])]));
  if (!keys.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5 font-mono text-[10px]">
      {keys.map((k) => (
        <div key={k} className="flex gap-1">
          <span className="text-muted-foreground">{k}:</span>
          {before?.[k] !== undefined && <span className="text-rose-500 line-through">{String(before[k])}</span>}
          {after?.[k] !== undefined && <span className="text-emerald-600 dark:text-emerald-400">{String(after[k])}</span>}
        </div>
      ))}
    </div>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  info: "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300",
};

function AckButton({ eventId, acknowledged, ackBase }: { eventId: string | number; acknowledged: boolean; ackBase: string }) {
  const [done, setDone] = React.useState(acknowledged);
  const [busy, setBusy] = React.useState(false);
  if (done) return <span className="text-[10px] text-emerald-600 dark:text-emerald-400">✓ ack&apos;d</span>;
  const onClick = async () => {
    setBusy(true);
    try {
      const res = await opsFetch(`${ackBase}/${eventId}/ack`, { method: "POST" });
      if (res.ok) setDone(true);
    } finally { setBusy(false); }
  };
  return (
    <button onClick={onClick} disabled={busy}
      className="rounded-md border border-border bg-card px-2 py-0.5 text-[10px] font-medium hover:bg-muted disabled:opacity-50">
      {busy ? "…" : "Acknowledge"}
    </button>
  );
}

function ActorCell({ name, sub }: { name?: string | null; sub?: string | null }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-semibold text-foreground">{name || "—"}</div>
      {sub && <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{sub}</div>}
    </div>
  );
}

/* ── Tab config: each stream declares its endpoint, columns, filters ────── */
type TabDef = {
  key: string; label: string; icon: any; endpoint: string;
  filterParam?: string; filters?: [string, string][]; // [value,label]
  columns: DataTableColumn<any>[];
};

const loc = (r: any) => <LocCell ip={r.ip_address} machineIp={r.machine_ip} machineName={r.machine_name} geo={r.location || r.geolocation} />;

const TABS: TabDef[] = [
  {
    key: "logins", label: "Logins", icon: LogIn, endpoint: "/api/admin/audit/logins",
    filterParam: "event", filters: [["all", "All"], ["login_success", "Success"], ["login_failure", "Failed"], ["logout", "Logout"]],
    columns: [
      { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
      { key: "ev", header: "Event", render: (r) => <Pill text={(r.event || "").replace("login_", "")} styles={EVENT_STYLE[r.event] || "bg-muted text-muted-foreground"} /> },
      { key: "u", header: "User", render: (r) => <ActorCell name={r.actor_username || r.username_tried} sub={`${r.actor_type}${r.actor_role ? " · " + r.actor_role : ""}`} /> },
      { key: "loc", header: "Location", render: loc },
      { key: "dev", header: "Device", render: (r) => r.device_fingerprint ? <span className="font-mono text-[10px] text-muted-foreground">{r.device_fingerprint.slice(0, 10)}</span> : <span className="text-muted-foreground">—</span> },
    ],
  },
  {
    key: "activity", label: "Activity", icon: ActivityIcon, endpoint: "/api/admin/audit/activity",
    filterParam: "result", filters: [["all", "All"], ["success", "Success"], ["denied", "Denied"], ["failure", "Failure"]],
    columns: [
      { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
      { key: "actor", header: "Actor", render: (r) => <ActorCell name={r.actor_username} sub={r.actor_type} /> },
      { key: "act", header: "Action", render: (r) => <div className="space-y-0.5"><div className="text-xs font-semibold text-foreground">{describeActivity(r.http_method, r.endpoint)}</div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.module}</div></div> },
      { key: "res", header: "Result", render: (r) => <div className="flex items-center gap-1"><Pill text={r.result} styles={RESULT_STYLE[r.result] || "bg-muted"} /><span className="font-mono text-[10px] text-muted-foreground">{r.http_status}</span></div> },
      { key: "loc", header: "Location", render: loc },
    ],
  },
  {
    key: "platform", label: "Super-admin", icon: Landmark, endpoint: "/api/admin/audit/platform",
    columns: [
      { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
      { key: "actor", header: "Actor", render: (r) => <ActorCell name={r.actor_email} sub={r.actor_role} /> },
      { key: "act", header: "Action", render: (r) => <div className="space-y-0.5"><div className="text-xs font-semibold text-foreground">{describePlatformAction(r.action)}</div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.entity_type}</div></div> },
      { key: "diff", header: "Change", render: (r) => <Diff before={r.before_data} after={r.after_data} /> },
      { key: "loc", header: "Location", render: loc },
    ],
  },
  {
    key: "officer-actions", label: "Officer decisions", icon: Gavel, endpoint: "/api/admin/audit/officer-actions",
    columns: [
      { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
      { key: "off", header: "Officer", render: (r) => <ActorCell name={r.officer_username} sub={`${r.officer_role || ""}${r.decision_level ? " · " + r.decision_level : ""}`} /> },
      { key: "act", header: "Decision", render: (r) => <div className="space-y-0.5"><div className="text-xs font-semibold text-foreground">{describeOfficerAction(r.action)}</div><StatusFlow from={r.from_status} to={r.to_status} /></div> },
      { key: "terms", header: "Terms / LRS", render: (r) => <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">{r.decided_amount && <div>₹{Number(r.decided_amount).toLocaleString()}</div>}{r.lrs_score_at_decision != null && <div>LRS {r.lrs_score_at_decision}</div>}</div> },
      { key: "loc", header: "Location", render: loc },
    ],
  },
  {
    key: "status-changes", label: "Status timeline", icon: GitBranch, endpoint: "/api/admin/audit/status-changes",
    columns: [
      { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
      { key: "actor", header: "Actor", render: (r) => <ActorCell name={r.actor_username} sub={`${r.actor_type}${r.actor_role ? " · " + r.actor_role : ""}`} /> },
      { key: "flow", header: "Status", render: (r) => <StatusFlow from={r.from_status} to={r.to_status} /> },
      { key: "src", header: "Source", render: (r) => <span className="text-[10px] text-muted-foreground">{r.source}</span> },
      { key: "loc", header: "Location", render: loc },
    ],
  },
  {
    key: "sensitive", label: "Sensitive access", icon: Eye, endpoint: "/api/admin/audit/sensitive",
    columns: [
      { key: "when", header: "When", render: (r) => <WhenCell iso={r.timestamp} /> },
      { key: "u", header: "User", render: (r) => <ActorCell name={r.user_type} sub={r.user_id ? String(r.user_id).slice(0, 8) : null} /> },
      { key: "act", header: "Action", render: (r) => <div className="text-xs font-semibold text-foreground">{describeSensitive(r.action)}</div> },
      { key: "ent", header: "Entity", render: (r) => <div className="space-y-0.5 text-[10px] text-muted-foreground"><div>{r.entity_type}</div>{r.phone && <div className="font-mono">{r.phone}</div>}</div> },
      { key: "loc", header: "Location", render: loc },
    ],
  },
  {
    key: "security", label: "Security", icon: ShieldAlert, endpoint: "/api/admin/audit/security",
    filterParam: "severity", filters: [["all", "All"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]],
    columns: [
      { key: "when", header: "When", render: (r) => <WhenCell iso={r.created_at} /> },
      { key: "sev", header: "Severity", render: (r) => <Pill text={r.severity} styles={SEVERITY_STYLE[r.severity] || "bg-muted"} /> },
      { key: "ev", header: "Event", render: (r) => <div className="space-y-0.5"><div className="text-xs font-semibold text-foreground">{r.title}</div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{describeSecurityType(r.event_type)}</div></div> },
      { key: "actor", header: "Actor", render: (r) => <ActorCell name={r.actor_username} sub={r.actor_role || r.actor_type} /> },
      { key: "loc", header: "Location", render: loc },
      { key: "ack", header: "", render: (r) => <AckButton eventId={r.id} acknowledged={!!r.acknowledged} ackBase="/api/admin/audit/security" /> },
    ],
  },
];

// One-line, plain-English explanation of each tab (for non-technical readers).
const TAB_DESC: Record<string, string> = {
  logins: "Who signed in, who failed to sign in, and who signed out — with the place and device.",
  activity: "Everything users did in the system — each action, who did it, and whether it succeeded.",
  platform: "Actions by the VGIPL super-admin team — creating or changing banks, users, vendors, and scorecards.",
  "officer-actions": "Loan decisions by officers and supervisors — approvals, rejections, and disbursements.",
  "status-changes": "Every stage a loan application moved through, and who moved it.",
  sensitive: "Access to sensitive data — viewing Aadhaar, playing call recordings, and exporting data.",
  security: "Security alerts — unusual sign-ins, permission changes, and suspicious activity that need attention.",
};

export default function OpsAuditPage() {
  const [tabKey, setTabKey] = React.useState("logins");
  const [filter, setFilter] = React.useState("all");
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const tab = TABS.find((t) => t.key === tabKey)!;

  React.useEffect(() => { setOffset(0); }, [tabKey, filter]);

  const load = React.useCallback(async (append: boolean) => {
    setLoading(true); setErr(null);
    const off = append ? offset : 0;
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
    if (filter !== "all" && tab.filterParam) params.set(tab.filterParam, filter);
    try {
      const res = await opsFetch(`${tab.endpoint}?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) { setErr(`HTTP ${res.status}`); setLoading(false); return; }
      const data = await res.json();
      setTotal(data.total ?? 0);
      setRows((prev) => (append ? [...prev, ...(data.items ?? [])] : (data.items ?? [])));
    } catch (e: any) {
      setErr(e?.message ?? "request failed");
    } finally { setLoading(false); }
  }, [tab, filter, offset]);

  React.useEffect(() => { load(false); /* eslint-disable-next-line */ }, [tabKey, filter]);
  React.useEffect(() => { if (offset > 0) load(true); /* eslint-disable-next-line */ }, [offset]);

  const locCount = new Set(rows.map((x) => (x.location || x.geolocation)?.city).filter(Boolean)).size;
  const hasMore = rows.length < total;

  return (
    <AppShell title="Audit trail" subtitle="Tamper-proof (append-only) record across every tier — with client IP, machine IP, and geolocation">
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="STREAM" value={tab.label.toUpperCase()} icon={tab.icon} tone="info" />
          <StatCard label="SHOWING" value={rows.length} icon={ShieldCheck} tone="neutral" />
          <StatCard label="TOTAL" value={total} icon={ActivityIcon} tone="neutral" />
          <StatCard label="LOCATIONS" value={locCount} icon={Globe} tone="neutral" />
        </div>

        {/* Stream tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTabKey(t.key); setFilter("all"); }}
              className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                tabKey === t.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
              <t.icon className="h-3.5 w-3.5" />{t.label}
            </button>
          ))}
        </div>

        {/* Plain-English description of the active tab (for non-technical users) */}
        <p className="text-xs text-muted-foreground">{TAB_DESC[tabKey]}</p>

        {/* Filter pills (only for tabs that declare filters) */}
        {tab.filters && (
          <div className="flex flex-wrap items-center gap-2">
            {tab.filters.map(([v, label]) => (
              <button key={v} onClick={() => setFilter(v)}
                className={cn("rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
                  filter === v ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                {label}
              </button>
            ))}
            {loading && <span className="text-[11px] text-muted-foreground">loading…</span>}
            {err && <span className="text-[11px] text-rose-500">error: {err}</span>}
          </div>
        )}
        {!tab.filters && (loading || err) && (
          <div className="text-[11px]">{loading && <span className="text-muted-foreground">loading…</span>}{err && <span className="text-rose-500">error: {err}</span>}</div>
        )}

        <DataTable columns={tab.columns} rows={rows} rowKey={(r, i) => `${r.id}-${i}`} empty={<EmptyBox />} />

        {hasMore && (
          <div className="flex justify-center">
            <button onClick={() => setOffset((o) => o + PAGE)} disabled={loading}
              className="rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50">
              {loading ? "loading…" : `Load more (${rows.length} of ${total})`}
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function EmptyBox() {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted ring-1 ring-border"><ShieldCheck className="h-5 w-5 text-muted-foreground" /></div>
      <div className="mt-3 text-sm font-semibold">Nothing here yet</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">No records for this stream/filter. Entries appear here as users act on the system.</div>
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
