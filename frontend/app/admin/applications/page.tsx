"use client";

/**
 * /admin/applications — system-wide loan applications list.
 *
 * Multi-bank gap from design-upgrade parity: previously admins only had
 * a detail page (/admin/applications/[id]) but had to enter the UUID
 * manually or click through from /admin/dashboard's recent-list to find
 * a specific app. This page is the searchable, filterable index.
 *
 * Auth: requires admin token (matches /admin/* convention). Calls existing
 * GET /api/admin/applications which is already wired (no backend change).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { FileText, Filter, Loader2, ArrowLeft, Search } from "lucide-react";

import { API_URL } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";

interface AppRow {
  id: string;
  customer_name?: string;
  full_name?: string;
  phone?: string;
  loan_id?: string;
  requested_loan_amount?: number | null;
  loan_amount_requested?: number | null;
  status: string;
  bank_id?: string | null;
  bank_name?: string | null;
  bank_code?: string | null;
  created_at?: string;
  submitted_at?: string;
}

const STATUS_FILTERS = [
  "all", "draft", "submitted", "system_reviewed",
  "officer_approved", "officer_rejected", "documents_submitted",
  "approved", "supervisor_rejected",
] as const;

type Filter = (typeof STATUS_FILTERS)[number];

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  submitted: "bg-blue-100 text-blue-700",
  system_reviewed: "bg-indigo-100 text-indigo-700",
  officer_approved: "bg-cyan-100 text-cyan-700",
  officer_rejected: "bg-rose-100 text-rose-700",
  documents_submitted: "bg-violet-100 text-violet-700",
  approved: "bg-emerald-100 text-emerald-700",
  supervisor_rejected: "bg-red-100 text-red-700",
};

function fmtINR(n?: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export default function AdminApplicationsListPage() {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const [bankFilter, setBankFilter] = React.useState<string>("all");

  // Auth check — bounce to /admin/login if missing
  React.useEffect(() => {
    if (!getAccessToken("admin")) router.replace("/admin/login");
  }, [router]);

  const q = useQuery({
    queryKey: ["admin", "applications"],
    queryFn: async () => {
      const token = getAccessToken("admin");
      const r = await fetch(`${API_URL}/api/admin/applications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const apps: AppRow[] = q.data?.applications ?? [];
  const banks = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of apps) {
      if (a.bank_id && a.bank_name) m.set(a.bank_id, a.bank_name);
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [apps]);

  const filtered = React.useMemo(() => {
    let rows = apps;
    if (filter !== "all") rows = rows.filter((a) => a.status === filter);
    if (bankFilter !== "all") rows = rows.filter((a) => a.bank_id === bankFilter);
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
  }, [apps, filter, bankFilter, search]);

  // Per-filter counts
  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: apps.length };
    for (const a of apps) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [apps]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950">
      {/* Top bar — minimal, matches /admin/dashboard chrome */}
      <div className="bg-white dark:bg-gray-900 shadow-sm border-b border-slate-200 dark:border-gray-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/admin/dashboard")}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <FileText className="h-5 w-5 text-blue-600" />
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white">Applications</h1>
              <p className="text-xs text-slate-500 dark:text-gray-400">
                System-wide · {apps.length} total · {banks.length} bank{banks.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        {/* Search + bank filter row */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, loan ID, or app ID…"
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-10 pr-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          <select
            value={bankFilter}
            onChange={(e) => setBankFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="all">All banks</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        {/* Status filter pills */}
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

        {/* Table */}
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          {q.isLoading ? (
            <div className="grid place-items-center py-16 text-sm text-slate-500">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-500">
              {apps.length === 0 ? "No applications yet." : `No applications match "${search || filter}".`}
            </div>
          ) : (
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50 dark:bg-gray-800/50">
                <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3 font-medium">Applicant</th>
                  <th className="px-5 py-3 font-medium">Bank</th>
                  <th className="px-5 py-3 font-medium">Loan ID</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
                {filtered.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => router.push(`/admin/applications/${a.id}`)}
                    className="cursor-pointer transition hover:bg-slate-50 dark:hover:bg-gray-800/40"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/applications/${a.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-slate-900 hover:text-blue-700 dark:text-gray-100"
                      >
                        {a.customer_name || a.full_name || "—"}
                      </Link>
                      <div className="text-xs text-slate-500">{a.phone || ""}</div>
                    </td>
                    <td className="px-5 py-3 text-slate-700 dark:text-gray-300">
                      {a.bank_name || <span className="text-slate-400">unassigned</span>}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{a.loan_id || "—"}</td>
                    <td className="px-5 py-3 text-right font-medium">
                      {fmtINR(a.requested_loan_amount ?? a.loan_amount_requested)}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${STATUS_COLORS[a.status] || "bg-slate-100 text-slate-700"}`}>
                        {a.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">{fmtDate(a.created_at)}</td>
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
