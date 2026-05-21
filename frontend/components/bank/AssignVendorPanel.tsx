"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Loader2, Building2, X } from "lucide-react";
import { toast } from "sonner";

import {
  bankListPartneredVendors,
  bankAssignVendor,
  bankWithdrawAssignment,
  bankGetAssignmentHistory,
} from "@/lib/api/vendor";

/**
 * Bank-side panel — shows on an approved app's detail page so a supervisor can
 * either:
 *   (a) view active vendor assignment + withdraw it
 *   (b) assign a new partnered vendor
 *
 * The existing "Approve & Disburse" button remains the in-house path. This
 * panel is the NBFC-partner alternative — the loan officer picks whichever
 * channel the bank wants for this application.
 */
export function AssignVendorPanel({
  token, applicationId, applicationStatus,
}: { token: string; applicationId: string; applicationStatus: string }) {
  const qc = useQueryClient();

  const vendorsQ = useQuery({
    queryKey: ["bank", "vendors"],
    queryFn: () => bankListPartneredVendors(token),
    enabled: applicationStatus === "approved",
  });
  const historyQ = useQuery({
    queryKey: ["bank", "assignments", applicationId],
    queryFn: () => bankGetAssignmentHistory(token, applicationId),
    enabled: applicationStatus === "approved",
    refetchInterval: 15_000,
  });

  const vendors: any[] = vendorsQ.data?.vendors ?? [];
  const assignments: any[] = historyQ.data?.assignments ?? [];
  const active = assignments.find((a) => a.status === "pending" || a.status === "accepted");

  const [pick, setPick] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const assign = useMutation({
    mutationFn: () => bankAssignVendor(token, applicationId, pick, notes || undefined),
    onSuccess: () => {
      toast.success("Application assigned to vendor");
      setPick("");
      setNotes("");
      qc.invalidateQueries({ queryKey: ["bank", "assignments", applicationId] });
    },
    onError: (e: any) => toast.error(e?.message || "Assign failed"),
  });

  const withdraw = useMutation({
    mutationFn: () => bankWithdrawAssignment(token, applicationId),
    onSuccess: () => {
      toast.success("Assignment withdrawn");
      qc.invalidateQueries({ queryKey: ["bank", "assignments", applicationId] });
    },
    onError: (e: any) => toast.error(e?.message || "Withdraw failed"),
  });

  if (applicationStatus !== "approved") return null;

  return (
    <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 p-5 transition-colors">
      <div className="mb-4 flex items-center gap-2">
        <Banknote className="h-5 w-5 text-emerald-600" />
        <h3 className="font-semibold text-gray-900 dark:text-white">Disburse via vendor (NBFC partner)</h3>
      </div>

      {/* Active assignment view */}
      {active ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/30">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-emerald-700">
                Assigned to {active.vendor_name || active.vendor_code}
              </div>
              <div className="mt-1 text-sm text-emerald-900 dark:text-emerald-200">
                Status: <span className="font-medium">{active.status}</span>
                {" · "}
                Since {new Date(active.assigned_at).toLocaleString()}
              </div>
              {active.notes && (
                <div className="mt-1 text-xs italic text-emerald-700">"{active.notes}"</div>
              )}
            </div>
            <button
              onClick={() => withdraw.mutate()}
              disabled={withdraw.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              title="Withdraw — return application to pool for reassignment"
            >
              {withdraw.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              Withdraw
            </button>
          </div>
        </div>
      ) : (
        <>
          {vendors.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
              No partnered vendors yet. Ask the super-admin to add one in <span className="font-mono text-xs">/admin/vendors</span>.
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-500">
                  Select vendor
                </label>
                <select
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500 focus:ring-2 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100"
                >
                  <option value="">— pick a vendor —</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.code}){v.commission_pct != null ? ` · ${v.commission_pct}% commission` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-500">
                  Notes (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Any context for the vendor — case-by-case instructions, special handling…"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500 focus:ring-2 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100"
                />
              </div>
              <button
                disabled={!pick || assign.isPending}
                onClick={() => assign.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {assign.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Banknote className="h-3.5 w-3.5" />}
                Assign to vendor
              </button>
            </div>
          )}
        </>
      )}

      {/* Audit trail */}
      {assignments.length > 1 && (
        <details className="mt-4 text-xs text-slate-500">
          <summary className="cursor-pointer font-medium uppercase tracking-wider">
            Assignment history ({assignments.length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {assignments.map((h) => (
              <li key={h.id} className="flex items-center gap-2">
                <Building2 className="h-3 w-3" />
                <span className="font-medium">{h.vendor_name}</span>
                <span>· {h.status}</span>
                {h.rejection_reason && <span className="italic">("{h.rejection_reason}")</span>}
                <span className="ml-auto">{new Date(h.assigned_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
