"use client";

/**
 * /bank/applications — bank's own loan applications list.
 *
 * Multi-bank gap from design-upgrade parity: bank users could open a
 * specific app via /bank/applications/[id] (link from dashboard recent
 * list) but had no searchable, filterable index of their own bank's
 * pipeline. This is that index.
 *
 * Auth: requires bank token (matches /bank/* convention). Calls existing
 * GET /api/bank/applications which scopes to bank_id from the JWT.
 */

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

// Filters are scoped to what a bank user typically wants to see. Officers
// see pre-approval states; supervisors see post-approval too. We show the
// union — UI doesn't need to fork.
const STATUS_FILTERS = [
  "all", "submitted", "system_reviewed",
  "officer_approved", "officer_rejected", "documents_submitted",
  "approved", "supervisor_rejected", "disbursed",
] as const;

type Filter = (typeof STATUS_FILTERS)[number];

const STATUS_COLORS: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-700",
  system_reviewed: "bg-indigo-100 text-indigo-700",
  officer_approved: "bg-cyan-100 text-cyan-700",
  officer_rejected: "bg-rose-100 text-rose-700",
  documents_submitted: "bg-violet-100 text-violet-700",
  approved: "bg-emerald-100 text-emerald-700",
  supervisor_rejected: "bg-red-100 text-red-700",
  disbursed: "bg-teal-100 text-teal-700",
};

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
  const [filter, setFilter] = React.useState<Filter>("all");
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
    if (filter !== "all") rows = rows.filter((a) => a.status === filter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter((a) =>
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
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950">
      {/* Top bar — minimal, matches /bank/dashboard chrome */}
      <div className="bg-white dark:bg-gray-900 shadow-sm border-b border-slate-200 dark:border-gray-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/bank/dashboard")}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <FileText className="h-5 w-5 text-blue-600" />
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white">Applications</h1>
              <p className="text-xs text-slate-500 dark:text-gray-400">
                {user?.bank_name ? `${user.bank_name} · ` : ""}{apps.length} total
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, loan ID…"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-10 pr-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <Filter className="h-4 w-4 shrink-0 text-slate-400" />
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === f
                  ? "bg-blue-600 text-white shadow-sm"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700"
              }`}
            >
              {f.replace(/_/g, " ")}{counts[f] != null ? ` · ${counts[f]}` : ""}
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          {q.isLoading ? (
            <div className="grid place-items-center py-16"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-500">
              {apps.length === 0 ? "No applications assigned to your bank yet." : `No applications match "${search || filter}".`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-gray-800/50">
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3 font-medium">Applicant</th>
                  <th className="px-5 py-3 font-medium">Loan ID</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Interested</th>
                  <th className="px-5 py-3 font-medium">Form</th>
                  <th className="px-5 py-3 font-medium text-right">AI Score</th>
                  <th className="px-5 py-3 font-medium">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
                {filtered.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => router.push(`/bank/applications/${a.id}`)}
                    className="cursor-pointer transition hover:bg-slate-50 dark:hover:bg-gray-800/40"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/bank/applications/${a.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-slate-900 hover:text-blue-700 dark:text-gray-100"
                      >
                        {a.customer_name || a.full_name || "—"}
                      </Link>
                      <div className="text-xs text-slate-500">{a.phone || ""}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{a.loan_id || "—"}</td>
                    <td className="px-5 py-3 text-xs text-slate-600 dark:text-gray-300">
                      {a.consumer_loan_type === 'consumer_durable' ? 'Consumer Durable' : a.consumer_loan_type === 'personal' ? 'Personal' : '—'}
                    </td>
                    <td className="px-5 py-3 text-right font-medium">
                      {fmtINR(a.requested_loan_amount ?? a.loan_amount_requested)}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${STATUS_COLORS[a.status] || "bg-slate-100 text-slate-700"}`}>
                        {a.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {a.interested === true ? (
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-green-100 text-green-700">Yes</span>
                      ) : a.interested === false ? (
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-rose-100 text-rose-700">No</span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-3">
                      {a.form_status === 'completed' ? (
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-700">Submitted</span>
                      ) : a.form_status === 'in_progress' ? (
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-yellow-100 text-yellow-700">In Progress</span>
                      ) : a.form_status === 'pending' ? (
                        <span className="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium bg-gray-100 text-gray-600">Pending</span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {a.system_score != null ? (
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          a.system_score >= 70 ? "bg-emerald-100 text-emerald-700"
                            : a.system_score >= 50 ? "bg-amber-100 text-amber-700"
                            : "bg-rose-100 text-rose-700"
                        }`}>{a.system_score}</span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">{fmtDate(a.submitted_at || a.created_at)}</td>
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
