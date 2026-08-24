"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";

import { VendorShell } from "@/components/vendor/VendorShell";
import { VendorStatusBadge } from "@/components/vendor/StatusBadge";
import {
  getVendorApplications,
  type VendorAssignmentStatus,
} from "@/lib/api/vendor";
import { getAccessToken } from "@/lib/auth";

const FILTERS: { value: VendorAssignmentStatus | "all"; label: string }[] = [
  { value: "all",             label: "All" },
  { value: "pending",         label: "Pending" },
  { value: "accepted",        label: "Accepted" },
  { value: "disbursed",       label: "Disbursed" },
  { value: "vendor_rejected", label: "Rejected" },
  { value: "withdrawn",       label: "Withdrawn" },
];

function fmtINR(n?: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

export default function VendorApplicationsPage() {
  const token = React.useMemo(() => getAccessToken("vendor") || "", []);
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]["value"]>("all");

  const q = useQuery({
    queryKey: ["vendor", "apps", filter],
    queryFn: () =>
      getVendorApplications(token, filter === "all" ? undefined : (filter as VendorAssignmentStatus)),
    refetchInterval: 15_000,
  });

  const apps: any[] = q.data?.applications ?? [];

  return (
    <VendorShell title="Applications" subtitle="Loan applications assigned to your vendor account">
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

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {q.isLoading ? (
          <div className="py-12 text-center text-sm text-slate-500">Loading…</div>
        ) : apps.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-500">
            <div className="font-medium">No applications {filter !== "all" ? `with status "${filter}"` : "yet"}.</div>
            <div className="mt-1 text-xs">When a bank assigns a loan to your vendor, it&apos;ll appear here.</div>
          </div>
        ) : (
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 dark:bg-gray-800/50">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-medium">Applicant</th>
                <th className="px-5 py-3 font-medium">Bank</th>
                <th className="px-5 py-3 font-medium">Loan ID</th>
                <th className="px-5 py-3 font-medium text-right">Requested</th>
                <th className="px-5 py-3 font-medium text-right">Disbursed</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Assigned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
              {apps.map((a) => (
                <tr key={a.id} className="transition hover:bg-slate-50 dark:hover:bg-gray-800/40">
                  <td className="px-5 py-3">
                    <Link
                      href={`/vendor/applications/${a.application_id}`}
                      className="font-medium text-slate-900 hover:text-emerald-700 dark:text-gray-100"
                    >
                      {a.customer_name || "—"}
                    </Link>
                    <div className="text-xs text-slate-500">{a.phone || ""}</div>
                  </td>
                  <td className="px-5 py-3 text-slate-700 dark:text-gray-300">{a.bank_name || "—"}</td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-500">{a.loan_id || "—"}</td>
                  <td className="px-5 py-3 text-right font-medium">{fmtINR(a.requested_loan_amount)}</td>
                  <td className="px-5 py-3 text-right text-emerald-700">{fmtINR(a.disbursed_amount)}</td>
                  <td className="px-5 py-3"><VendorStatusBadge status={a.status} /></td>
                  <td className="px-5 py-3 text-xs text-slate-500">
                    {a.assigned_at ? new Date(a.assigned_at).toLocaleString() : "—"}
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
