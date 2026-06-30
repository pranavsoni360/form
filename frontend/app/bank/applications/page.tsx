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

const STATUS_FILTERS = [
  "all", "submitted", "system_reviewed",
  "officer_approved", "officer_rejected", "documents_submitted",
  "approved", "supervisor_rejected", "disbursed",
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    submitted:           'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    system_reviewed:     'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
    officer_approved:    'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
    officer_rejected:    'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300',
    documents_submitted: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
    approved:            'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    supervisor_rejected: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    disbursed:           'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${map[status] || 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400'}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
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
  const [user, setUser]     = React.useState<any>(null);

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
      const r = await fetch(`${API_URL}/api/bank/applications`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    enabled: Boolean(user),
  });

  const apps: AppRow[] = q.data?.applications ?? [];

  const filtered = React.useMemo(() => {
    let rows = filter !== "all" ? apps.filter(a => a.status === filter) : apps;
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
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 relative">

      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden -z-10">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[80rem] h-[36rem] rounded-full bg-blue-400/[0.04] dark:bg-blue-400/[0.06] blur-3xl" />
      </div>

      {/* Header */}
      <div className="sticky top-0 z-30 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-3">
          <button onClick={() => router.push("/bank/dashboard")}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-blue-600 shadow-sm shadow-blue-600/30">
            <FileText className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Applications</h1>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              {user?.bank_name ? `${user.bank_name} · ` : ""}{apps.length} total
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">

        {/* Search + filters */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-3 space-y-3">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input type="search" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search name, phone, loan ID…"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 py-2 pl-10 pr-3 text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition" />
          </div>
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            <Filter className="h-4 w-4 flex-shrink-0 text-slate-400" />
            {STATUS_FILTERS.map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  filter === f
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}>
                {f.replace(/_/g, " ")}{counts[f] != null ? ` · ${counts[f]}` : ""}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
          {q.isLoading ? (
            <div className="grid place-items-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-400">
              {apps.length === 0 ? "No applications assigned to your bank yet." : `No results for "${search || filter}".`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                <tr className="text-left text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500">
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
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filtered.map(a => (
                  <tr key={a.id} onClick={() => router.push(`/bank/applications/${a.id}`)}
                    className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
                    <td className="px-5 py-3">
                      <Link href={`/bank/applications/${a.id}`} onClick={e => e.stopPropagation()}
                        className="font-medium text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 transition">
                        {a.customer_name || a.full_name || "—"}
                      </Link>
                      <div className="text-xs text-slate-400 dark:text-slate-500">{a.phone || ""}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-400 dark:text-slate-500">{a.loan_id || "—"}</td>
                    <td className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
                      {a.consumer_loan_type === 'consumer_durable' ? 'Consumer Durable' : a.consumer_loan_type === 'personal' ? 'Personal' : '—'}
                    </td>
                    <td className="px-5 py-3 text-right font-medium text-slate-900 dark:text-slate-100">
                      {fmtINR(a.requested_loan_amount ?? a.loan_amount_requested)}
                    </td>
                    <td className="px-5 py-3"><StatusBadge status={a.status} /></td>
                    <td className="px-5 py-3">
                      {a.interested === true
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Yes</span>
                        : a.interested === false
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400">No</span>
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-3">
                      {a.form_status === 'completed'
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Submitted</span>
                        : a.form_status === 'in_progress'
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">In Progress</span>
                        : a.form_status === 'pending'
                        ? <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">Pending</span>
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {a.system_score != null
                        ? <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${a.system_score >= 70 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : a.system_score >= 50 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"}`}>{a.system_score}</span>
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-400 dark:text-slate-500">{fmtDate(a.submitted_at || a.created_at)}</td>
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
