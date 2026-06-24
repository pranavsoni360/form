"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { FileText, Filter, Loader2, ArrowLeft, Search } from "lucide-react";

import { API_URL } from "@/lib/api";
import { getAccessToken, getCurrentUser } from "@/lib/auth";

interface AppRow {
  id: string;
  customer_name?: string;
  full_name?: string;
  phone?: string;
  loan_id?: string;
  requested_loan_amount?: number | null;
  loan_amount_requested?: number | null;
  consumer_loan_type?: string | null;
  status: string;
  created_at?: string;
  submitted_at?: string;
  system_score?: number | null;
  system_suggestion?: string | null;
  interested?: boolean | null;
  form_status?: string | null;
}

// palette
const P = {
  bg: '#f8fafc', card: '#ffffff', accent: '#d9eafd',
  border: '#bcccdc', muted: '#9aa6b2', text: '#1e293b', sub: '#475569', hov: '#f0f6ff',
};

const STATUS_FILTERS = [
  "all", "submitted", "system_reviewed",
  "officer_approved", "officer_rejected", "documents_submitted",
  "approved", "supervisor_rejected", "disbursed",
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

function statusStyle(s: string): React.CSSProperties {
  const map: Record<string, [string, string]> = {
    submitted:           ['#eff6ff', '#1d4ed8'],
    system_reviewed:     ['#eef2ff', '#4338ca'],
    officer_approved:    ['#ecfeff', '#0e7490'],
    officer_rejected:    ['#fff1f2', '#be123c'],
    documents_submitted: ['#f5f3ff', '#6d28d9'],
    approved:            ['#ecfdf5', '#065f46'],
    supervisor_rejected: ['#fef2f2', '#991b1b'],
    disbursed:           ['#f0fdfa', '#0f766e'],
  };
  const [bg, color] = map[s] || ['#f8fafc', P.sub];
  return { background: bg, color, border: `1px solid ${color}20` };
}

function fmtINR(n?: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default function BankApplicationsListPage() {
  const router = useRouter();
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [search, setSearch] = React.useState("");
  const [user, setUser] = React.useState<any>(null);

  React.useEffect(() => {
    const t = getAccessToken("bank");
    const u = getCurrentUser("bank");
    if (!t || !u) { router.replace("/bank/login"); return; }
    setUser(u);
  }, [router]);

  const q = useQuery({
    queryKey: ["bank", "applications"],
    queryFn: async () => {
      const token = getAccessToken("bank");
      const r = await fetch(`${API_URL}/api/bank/applications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    enabled: Boolean(user),
  });

  const apps: AppRow[] = q.data?.applications ?? [];

  const filtered = React.useMemo(() => {
    let rows = apps;
    if (filter !== "all") rows = rows.filter(a => a.status === filter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter(a =>
        (a.customer_name || a.full_name || "").toLowerCase().includes(s) ||
        (a.phone || "").includes(s) ||
        (a.loan_id || "").toLowerCase().includes(s) ||
        a.id.includes(s),
      );
    }
    return rows;
  }, [apps, filter, search]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: apps.length };
    for (const a of apps) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [apps]);

  return (
    <div className="min-h-screen" style={{ background: P.bg }}>

      {/* Header */}
      <div style={{ background: P.card, borderBottom: `1px solid ${P.border}`, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-3">
          <button onClick={() => router.push("/bank/dashboard")}
            className="p-2 rounded-lg transition"
            style={{ color: P.muted }}
            onMouseEnter={e => (e.currentTarget.style.background = P.hov)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: P.accent, border: `1px solid ${P.border}` }}>
            <FileText className="h-4 w-4" style={{ color: '#1e3a5f' }} />
          </div>
          <div>
            <h1 className="text-xl font-bold" style={{ color: P.text }}>Applications</h1>
            <p className="text-xs" style={{ color: P.muted }}>
              {user?.bank_name ? `${user.bank_name} · ` : ""}{apps.length} total
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">

        {/* Search */}
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: P.muted }} />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, phone, loan ID…"
            className="w-full rounded-lg py-2 pl-10 pr-3 text-sm outline-none transition"
            style={{ border: `1px solid ${P.border}`, background: P.card, color: P.text }}
            onFocus={e => (e.target.style.borderColor = '#9aa6b2')}
            onBlur={e => (e.target.style.borderColor = P.border)}
          />
        </div>

        {/* Filter pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <Filter className="h-4 w-4 flex-shrink-0" style={{ color: P.muted }} />
          {STATUS_FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className="flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition"
              style={filter === f
                ? { background: P.accent, color: '#1e3a5f', border: `1px solid ${P.border}` }
                : { background: P.card, color: P.sub, border: `1px solid ${P.border}` }}
              onMouseEnter={e => { if (filter !== f) (e.currentTarget.style.background = P.hov); }}
              onMouseLeave={e => { if (filter !== f) (e.currentTarget.style.background = P.card); }}>
              {f.replace(/_/g, " ")}{counts[f] != null ? ` · ${counts[f]}` : ""}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="overflow-hidden rounded-xl" style={{ border: `1px solid ${P.border}`, background: P.card }}>
          {q.isLoading ? (
            <div className="grid place-items-center py-16">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: P.muted }} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm" style={{ color: P.muted }}>
              {apps.length === 0 ? "No applications assigned to your bank yet." : `No applications match "${search || filter}".`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead style={{ background: P.bg, borderBottom: `1px solid ${P.border}` }}>
                <tr className="text-left text-xs uppercase tracking-wider" style={{ color: P.muted }}>
                  <th className="px-5 py-3 font-semibold">Applicant</th>
                  <th className="px-5 py-3 font-semibold">Loan ID</th>
                  <th className="px-5 py-3 font-semibold">Type</th>
                  <th className="px-5 py-3 font-semibold text-right">Amount</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Interested</th>
                  <th className="px-5 py-3 font-semibold">Form</th>
                  <th className="px-5 py-3 font-semibold text-right">AI Score</th>
                  <th className="px-5 py-3 font-semibold">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a, i) => (
                  <tr key={a.id}
                    onClick={() => router.push(`/bank/applications/${a.id}`)}
                    className="cursor-pointer transition"
                    style={{ borderBottom: i < filtered.length - 1 ? `1px solid ${P.bg}` : 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.background = P.hov)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td className="px-5 py-3">
                      <Link href={`/bank/applications/${a.id}`} onClick={e => e.stopPropagation()}
                        className="font-medium transition"
                        style={{ color: P.text }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#1e3a5f')}
                        onMouseLeave={e => (e.currentTarget.style.color = P.text)}>
                        {a.customer_name || a.full_name || "—"}
                      </Link>
                      <div className="text-xs" style={{ color: P.muted }}>{a.phone || ""}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs" style={{ color: P.muted }}>{a.loan_id || "—"}</td>
                    <td className="px-5 py-3 text-xs" style={{ color: P.sub }}>
                      {a.consumer_loan_type === 'consumer_durable' ? 'Consumer Durable' : a.consumer_loan_type === 'personal' ? 'Personal' : '—'}
                    </td>
                    <td className="px-5 py-3 text-right font-medium" style={{ color: P.text }}>
                      {fmtINR(a.requested_loan_amount ?? a.loan_amount_requested)}
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                        style={statusStyle(a.status)}>
                        {a.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {a.interested === true
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-700">Yes</span>
                        : a.interested === false
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-rose-100 text-rose-700">No</span>
                        : <span style={{ color: P.muted }}>—</span>}
                    </td>
                    <td className="px-5 py-3">
                      {a.form_status === 'completed'
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-700">Submitted</span>
                        : a.form_status === 'in_progress'
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-700">In Progress</span>
                        : a.form_status === 'pending'
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: P.accent, color: '#1e3a5f' }}>Pending</span>
                        : <span style={{ color: P.muted }}>—</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {a.system_score != null ? (
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          a.system_score >= 70 ? "bg-emerald-100 text-emerald-700"
                            : a.system_score >= 50 ? "bg-amber-100 text-amber-700"
                            : "bg-rose-100 text-rose-700"
                        }`}>{a.system_score}</span>
                      ) : <span style={{ color: P.muted }}>—</span>}
                    </td>
                    <td className="px-5 py-3 text-xs" style={{ color: P.muted }}>
                      {fmtDate(a.submitted_at || a.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
