"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";

import { VendorShell } from "@/components/vendor/VendorShell";
import {
  getVendorSettlements,
  type SettlementStatus,
} from "@/lib/api/vendor";
import { getAccessToken } from "@/lib/auth";

const FILTERS: { value: SettlementStatus | "all"; label: string }[] = [
  { value: "all",      label: "All" },
  { value: "pending",  label: "Pending" },
  { value: "paid",     label: "Paid" },
  { value: "failed",   label: "Failed" },
  { value: "disputed", label: "Disputed" },
];

function fmtINR(n?: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

function SettlementBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-amber-100 text-amber-700",
    paid: "bg-emerald-100 text-emerald-700",
    failed: "bg-rose-100 text-rose-700",
    disputed: "bg-violet-100 text-violet-700",
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${map[status] || "bg-slate-100 text-slate-700"}`}>
      {status}
    </span>
  );
}

export default function VendorSettlementsPage() {
  const token = React.useMemo(() => getAccessToken("vendor") || "", []);
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]["value"]>("all");

  const q = useQuery({
    queryKey: ["vendor", "settlements", filter],
    queryFn: () =>
      getVendorSettlements(token, filter === "all" ? undefined : (filter as SettlementStatus)),
    refetchInterval: 30_000,
  });

  const rows: any[] = q.data?.settlements ?? [];
  const sum = q.data?.summary ?? { n: 0, total_amount: 0, total_commission: 0 };
  const netPayout = Math.max(0, (sum.total_amount ?? 0) - (sum.total_commission ?? 0));

  return (
    <VendorShell title="Settlements" subtitle="Disbursement settlement records and commission split">
      {/* Summary tiles */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <SumTile label="Count" value={sum.n} accent="violet" />
        <SumTile label="Total disbursed" value={fmtINR(sum.total_amount)} accent="emerald" />
        <SumTile label="Total commission" value={fmtINR(sum.total_commission)} accent="blue" />
        <SumTile label="Net bank payout" value={fmtINR(netPayout)} accent="slate" />
      </div>

      {/* Filter pills */}
      <div className="mb-4 flex items-center gap-2 overflow-x-auto">
        <Filter className="h-4 w-4 shrink-0 text-slate-400" />
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition ${
              filter === f.value
                ? "bg-emerald-600 text-white shadow-sm"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {q.isLoading ? (
          <div className="py-12 text-center text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-500">
            <div className="font-medium">No settlements {filter !== "all" ? `with status "${filter}"` : "yet"}.</div>
            <div className="mt-1 text-xs">Settlements appear here automatically when you disburse an assigned loan.</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-gray-800/50">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-medium">Applicant</th>
                <th className="px-5 py-3 font-medium">Bank</th>
                <th className="px-5 py-3 font-medium text-right">Amount</th>
                <th className="px-5 py-3 font-medium text-right">Commission %</th>
                <th className="px-5 py-3 font-medium text-right">Commission ₹</th>
                <th className="px-5 py-3 font-medium text-right">Bank payout</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
              {rows.map((s) => (
                <tr key={s.id} className="transition hover:bg-slate-50 dark:hover:bg-gray-800/40">
                  <td className="px-5 py-3 font-medium text-slate-900 dark:text-gray-100">
                    {s.customer_name || "—"}
                  </td>
                  <td className="px-5 py-3 text-slate-700 dark:text-gray-300">{s.bank_name || "—"}</td>
                  <td className="px-5 py-3 text-right font-medium">{fmtINR(s.amount)}</td>
                  <td className="px-5 py-3 text-right text-slate-600">{s.commission_pct != null ? `${s.commission_pct}%` : "—"}</td>
                  <td className="px-5 py-3 text-right text-blue-700">{fmtINR(s.commission_amount)}</td>
                  <td className="px-5 py-3 text-right text-emerald-700">{fmtINR(s.bank_payout)}</td>
                  <td className="px-5 py-3"><SettlementBadge status={s.status} /></td>
                  <td className="px-5 py-3 text-xs text-slate-500">
                    {s.created_at ? new Date(s.created_at).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </VendorShell>
  );
}

function SumTile({ label, value, accent }: { label: string; value: number | string; accent: "violet" | "emerald" | "blue" | "slate" }) {
  const tones = {
    violet:  "bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300",
    emerald: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
    blue:    "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
    slate:   "bg-slate-100 text-slate-700 dark:bg-gray-800 dark:text-gray-200",
  } as const;
  return (
    <div className={`rounded-xl px-4 py-3 ${tones[accent]}`}>
      <div className="text-xs font-medium uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight">{value}</div>
    </div>
  );
}
