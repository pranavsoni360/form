"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Banknote,
  Briefcase,
  CheckCircle2,
  Clock,
} from "lucide-react";

import { VendorShell } from "@/components/vendor/VendorShell";
import { VendorStatusBadge } from "@/components/vendor/StatusBadge";
import {
  getVendorApplications,
  getVendorSettlements,
} from "@/lib/api/vendor";
import { getAccessToken } from "@/lib/auth";

function fmtINR(n?: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

export default function VendorDashboardPage() {
  // Token is guaranteed by layout.tsx, but be defensive.
  const token = React.useMemo(() => getAccessToken("vendor") || "", []);

  const appsQ = useQuery({
    queryKey: ["vendor", "apps", "all"],
    queryFn: () => getVendorApplications(token),
    refetchInterval: 15_000,
  });
  const settleQ = useQuery({
    queryKey: ["vendor", "settlements", "all"],
    queryFn: () => getVendorSettlements(token),
    refetchInterval: 30_000,
  });

  const apps: any[] = appsQ.data?.applications ?? [];
  const settlements: any[] = settleQ.data?.settlements ?? [];
  const summary = settleQ.data?.summary ?? { n: 0, total_amount: 0, total_commission: 0 };

  const pending = apps.filter((a) => a.status === "pending").length;
  const accepted = apps.filter((a) => a.status === "accepted").length;
  const disbursed = apps.filter((a) => a.status === "disbursed").length;
  const pendingSettlements = settlements.filter((s) => s.status === "pending").length;

  const recent = apps.slice(0, 6);

  return (
    <VendorShell title="Dashboard" subtitle="Pending assignments, disbursement queue, settlement summary">
      {/* KPI tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="New (pending)"      value={pending}             icon={Clock}        tone="amber"   />
        <KpiTile label="In progress"        value={accepted}            icon={Briefcase}    tone="blue"    />
        <KpiTile label="Disbursed (all-time)" value={disbursed}         icon={CheckCircle2} tone="emerald" />
        <KpiTile label="Settlements pending" value={pendingSettlements} icon={Banknote}     tone="violet"  />
      </div>

      {/* Settlement summary strip */}
      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Settlement summary</h2>
          <Link href="/vendor/settlements" className="text-sm text-emerald-600 hover:underline">
            View all <ArrowUpRight className="inline h-3 w-3" />
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SumStat label="Total disbursed"  value={fmtINR(summary.total_amount)}     hint={`${summary.n} settlements`} />
          <SumStat label="Total commission" value={fmtINR(summary.total_commission)} hint="Across all assignments" />
          <SumStat label="Net bank payout"  value={fmtINR(Math.max(0, (summary.total_amount ?? 0) - (summary.total_commission ?? 0)))} hint="Disbursed − commission" />
        </div>
      </div>

      {/* Recent activity */}
      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Recent assignments</h2>
          <Link href="/vendor/applications" className="text-sm text-emerald-600 hover:underline">
            View all <ArrowUpRight className="inline h-3 w-3" />
          </Link>
        </div>

        {appsQ.isLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">Loading…</div>
        ) : recent.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">No assignments yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wider text-slate-500 dark:border-gray-800">
                  <th className="py-2 font-medium">Applicant</th>
                  <th className="py-2 font-medium">Bank</th>
                  <th className="py-2 font-medium text-right">Amount</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium">Assigned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
                {recent.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2.5">
                      <Link href={`/vendor/applications/${a.application_id}`} className="font-medium text-slate-900 hover:text-emerald-700 dark:text-gray-100">
                        {a.customer_name || "—"}
                      </Link>
                      <div className="text-xs text-slate-500">{a.phone || ""}</div>
                    </td>
                    <td className="py-2.5 text-slate-700 dark:text-gray-300">{a.bank_name || "—"}</td>
                    <td className="py-2.5 text-right font-medium">{fmtINR(a.requested_loan_amount)}</td>
                    <td className="py-2.5"><VendorStatusBadge status={a.status} /></td>
                    <td className="py-2.5 text-xs text-slate-500">{a.assigned_at ? new Date(a.assigned_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </VendorShell>
  );
}

function KpiTile({
  label, value, icon: Icon, tone,
}: {
  label: string; value: number | string; icon: React.ComponentType<{ className?: string }>; tone: "amber" | "blue" | "emerald" | "violet";
}) {
  const tones = {
    amber:   "bg-amber-50  text-amber-600  dark:bg-amber-950/30  dark:text-amber-300",
    blue:    "bg-blue-50   text-blue-600   dark:bg-blue-950/30   dark:text-blue-300",
    emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-300",
    violet:  "bg-violet-50  text-violet-600  dark:bg-violet-950/30  dark:text-violet-300",
  } as const;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-gray-400">{label}</span>
        <span className={`grid h-9 w-9 place-items-center rounded-xl ${tones[tone]}`}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-3 text-3xl font-bold tracking-tight">{value}</div>
    </div>
  );
}

function SumStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3 dark:bg-gray-800/60">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

