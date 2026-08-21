"use client";

// Tiered audit view for the bank portal. The server (/api/bank/audit) auto-scopes
// to the caller's bank_id — and to their branch_id when the caller is a branch
// user — so a bank admin sees the whole bank and a branch officer sees only their
// branch, using the exact same component.

import * as React from "react";
import { API_URL } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import { describeActivity, describeOfficerAction, describeSecurityType } from "@/lib/audit-describe";

type Geo = { country?: string | null; region?: string | null; city?: string | null; country_code?: string | null } | null;
type Col = { header: string; render: (r: any) => React.ReactNode };
const PAGE = 100;

function fmtAgo(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`; return `${Math.floor(h / 24)}d`;
}
function When({ iso }: { iso: string }) {
  const d = new Date(iso);
  return <div className="whitespace-nowrap"><div className="text-xs tabular-nums">{d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div><div className="text-[10px] opacity-60">{fmtAgo(Date.now() - d.getTime())} ago</div></div>;
}
function Loc({ r }: { r: any }) {
  const g: Geo = r.location || r.geolocation;
  const place = g ? [g.city, g.region, g.country].filter(Boolean).join(", ") : null;
  return <div className="space-y-0.5"><div className="text-xs">{place || <span className="opacity-50 italic">unknown</span>}{g?.country_code && <span className="ml-1 rounded bg-black/10 px-1 py-0.5 font-mono text-[9px] dark:bg-white/10">{g.country_code}</span>}</div>
    {r.ip_address && <div className="font-mono text-[10px] opacity-60">{String(r.ip_address).replace(/\/\d+$/, "")}</div>}
    {(r.machine_name || r.machine_ip) && <div className="font-mono text-[10px] text-sky-600 dark:text-sky-400">🖥 {r.machine_name || ""}{r.machine_ip ? ` ${String(r.machine_ip).replace(/\/\d+$/, "")}` : ""}</div>}</div>;
}
function Flow({ from, to }: { from?: string; to?: string }) {
  return <div className="flex items-center gap-1 text-[11px]">{from && <span className="opacity-60">{from}</span>}<span className="opacity-60">→</span><span className="rounded-full bg-indigo-100 px-2 py-0.5 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">{to || "?"}</span></div>;
}
function Who({ n, s }: { n?: string; s?: string }) {
  return <div className="space-y-0.5"><div className="text-xs font-semibold">{n || "—"}</div>{s && <div className="text-[10px] uppercase tracking-wider opacity-60">{s}</div>}</div>;
}
const SEV: Record<string, string> = {
  critical: "bg-red-600 text-white", high: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300", info: "bg-slate-100 text-slate-600",
};

function AckBtn({ id, acked }: { id: number; acked: boolean }) {
  const [done, setDone] = React.useState(acked);
  const [busy, setBusy] = React.useState(false);
  if (done) return <span className="text-[10px] text-emerald-600 dark:text-emerald-400">✓ ack'd</span>;
  return <button disabled={busy} onClick={async () => {
    setBusy(true);
    try {
      const t = getAccessToken("bank");
      const r = await fetch(`${API_URL}/api/bank/audit/security/${id}/ack`, { method: "POST", headers: { Authorization: `Bearer ${t}` } });
      if (r.ok) setDone(true);
    } finally { setBusy(false); }
  }} className="rounded-md border px-2 py-0.5 text-[10px] hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5">{busy ? "…" : "Acknowledge"}</button>;
}

const STREAMS: { key: string; label: string; cols: Col[] }[] = [
  { key: "status-changes", label: "Status timeline", cols: [
    { header: "When", render: (r) => <When iso={r.created_at} /> },
    { header: "Actor", render: (r) => <Who n={r.actor_username} s={`${r.actor_type}${r.actor_role ? " · " + r.actor_role : ""}`} /> },
    { header: "Status", render: (r) => <Flow from={r.from_status} to={r.to_status} /> },
    { header: "Location", render: (r) => <Loc r={r} /> },
  ]},
  { key: "officer-actions", label: "Officer decisions", cols: [
    { header: "When", render: (r) => <When iso={r.created_at} /> },
    { header: "Officer", render: (r) => <Who n={r.officer_username} s={`${r.officer_role || ""}${r.decision_level ? " · " + r.decision_level : ""}`} /> },
    { header: "Decision", render: (r) => <div className="space-y-0.5"><div className="text-xs font-semibold">{describeOfficerAction(r.action)}</div><Flow from={r.from_status} to={r.to_status} /></div> },
    { header: "Terms/LRS", render: (r) => <div className="font-mono text-[10px] opacity-70">{r.decided_amount ? `₹${Number(r.decided_amount).toLocaleString()}` : ""}{r.lrs_score_at_decision != null ? ` · LRS ${r.lrs_score_at_decision}` : ""}</div> },
    { header: "Location", render: (r) => <Loc r={r} /> },
  ]},
  { key: "logins", label: "Logins", cols: [
    { header: "When", render: (r) => <When iso={r.created_at} /> },
    { header: "Event", render: (r) => <span className="rounded-full bg-black/10 px-2 py-0.5 text-[10px] dark:bg-white/10">{String(r.event || "").replace("login_", "")}</span> },
    { header: "User", render: (r) => <Who n={r.actor_username || r.username_tried} s={r.actor_role} /> },
    { header: "Location", render: (r) => <Loc r={r} /> },
  ]},
  { key: "security", label: "Security", cols: [
    { header: "When", render: (r) => <When iso={r.created_at} /> },
    { header: "Severity", render: (r) => <span className={`rounded-full px-2 py-0.5 text-[10px] ${SEV[r.severity] || "bg-black/10"}`}>{r.severity}</span> },
    { header: "Event", render: (r) => <div className="space-y-0.5"><div className="text-xs font-semibold">{r.title}</div><div className="text-[10px] uppercase tracking-wider opacity-60">{describeSecurityType(r.event_type)}</div></div> },
    { header: "Actor", render: (r) => <Who n={r.actor_username} s={r.actor_role || r.actor_type} /> },
    { header: "Location", render: (r) => <Loc r={r} /> },
    { header: "", render: (r) => <AckBtn id={r.id} acked={!!r.acknowledged} /> },
  ]},
  { key: "activity", label: "Activity", cols: [
    { header: "When", render: (r) => <When iso={r.created_at} /> },
    { header: "Actor", render: (r) => <Who n={r.actor_username} s={r.actor_type} /> },
    { header: "Action", render: (r) => <div className="text-xs font-semibold">{describeActivity(r.http_method, r.endpoint)}</div> },
    { header: "Result", render: (r) => <span className="text-[10px] opacity-70">{r.result} · {r.http_status}</span> },
    { header: "Location", render: (r) => <Loc r={r} /> },
  ]},
];

// Plain-English explanation of each stream (for non-technical bank staff).
const STREAM_DESC: Record<string, string> = {
  "status-changes": "Every stage a loan application moved through, and who moved it.",
  "officer-actions": "Loan decisions by officers and supervisors — approvals, rejections, and disbursements.",
  logins: "Who signed in, who failed to sign in, and who signed out — with the place and device.",
  security: "Security alerts — unusual sign-ins, permission changes, and suspicious activity that need attention.",
  activity: "Everything users did — each action, who did it, and whether it succeeded.",
};

export function BankAuditView({ scopeLabel }: { scopeLabel?: string }) {
  const [key, setKey] = React.useState("status-changes");
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const stream = STREAMS.find((s) => s.key === key)!;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const t = getAccessToken("bank");
        const res = await fetch(`${API_URL}/api/bank/audit?stream=${key}&limit=${PAGE}`, { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" });
        if (!res.ok) { if (!cancelled) setErr(`HTTP ${res.status}`); return; }
        const data = await res.json();
        if (!cancelled) { setRows(data.items ?? []); setTotal(data.total ?? 0); }
      } catch (e: any) { if (!cancelled) setErr(e?.message ?? "failed"); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [key]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Audit trail</h1>
        <p className="text-xs opacity-60">Tamper-proof record — logins, decisions, status changes, and security events {scopeLabel ? `· ${scopeLabel}` : ""} · with IP, machine IP & geolocation</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {STREAMS.map((s) => (
          <button key={s.key} onClick={() => setKey(s.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${key === s.key ? "bg-black text-white dark:bg-white dark:text-black" : "bg-black/5 opacity-70 hover:opacity-100 dark:bg-white/10"}`}>
            {s.label}
          </button>
        ))}
        {loading && <span className="self-center text-[11px] opacity-60">loading…</span>}
        {err && <span className="self-center text-[11px] text-rose-500">error: {err}</span>}
      </div>
      <p className="text-xs opacity-60">{STREAM_DESC[key]}</p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b bg-black/5 text-[10px] uppercase tracking-wider opacity-60 dark:bg-white/5">
            {stream.cols.map((c, i) => <th key={i} className="px-3 py-2 font-medium">{c.header}</th>)}
          </tr></thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={stream.cols.length} className="px-3 py-12 text-center text-xs opacity-60">No records for this stream yet.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={`${r.id}-${i}`} className="border-b last:border-0 hover:bg-black/5 dark:hover:bg-white/5">
                {stream.cols.map((c, j) => <td key={j} className="px-3 py-2 align-top">{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] opacity-50">{rows.length} of {total} shown</div>
    </div>
  );
}
