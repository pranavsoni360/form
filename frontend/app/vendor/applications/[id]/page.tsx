"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Banknote,
  Building2,
  CheckCircle2,
  Loader2,
  Mail,
  Phone,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { VendorShell } from "@/components/vendor/VendorShell";
import { VendorStatusBadge } from "@/components/vendor/StatusBadge";
import {
  getVendorApplicationDetail,
  vendorAccept,
  vendorDisburse,
  vendorReject,
} from "@/lib/api/vendor";
import { getAccessToken } from "@/lib/auth";

function fmtINR(n?: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

export default function VendorApplicationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const token = React.useMemo(() => getAccessToken("vendor") || "", []);
  const appId = params?.id;

  const q = useQuery({
    queryKey: ["vendor", "app", appId],
    queryFn: () => getVendorApplicationDetail(token, appId!),
    enabled: !!appId,
  });

  const a = q.data;
  const avaId = a?.id; // the assignment row id (NOT application_id)
  const status: string = a?.status || "";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["vendor", "app", appId] });
    qc.invalidateQueries({ queryKey: ["vendor", "apps"] });
    qc.invalidateQueries({ queryKey: ["vendor", "settlements"] });
  };

  const accept = useMutation({
    mutationFn: () => vendorAccept(token, avaId),
    onSuccess: () => { toast.success("Assignment accepted"); invalidate(); },
    onError: (e: any) => toast.error(e?.message || "Accept failed"),
  });

  // Modals state
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [disbOpen, setDisbOpen] = React.useState(false);

  if (q.isLoading) {
    return (
      <VendorShell title="Application">
        <div className="py-16 text-center text-sm text-slate-500">Loading…</div>
      </VendorShell>
    );
  }
  if (q.isError || !a) {
    return (
      <VendorShell title="Application not found">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-700">
          {q.error?.toString() || "Couldn't load this application — it may not be assigned to your vendor."}
        </div>
        <Link href="/vendor/applications" className="mt-4 inline-flex items-center gap-1 text-sm text-emerald-600 hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to applications
        </Link>
      </VendorShell>
    );
  }

  const canAccept   = status === "pending";
  const canReject   = status === "pending" || status === "accepted";
  const canDisburse = status === "accepted";

  return (
    <VendorShell title={a.customer_name || "Application"} subtitle={`Loan ID ${a.loan_id || "—"} · ${a.bank_name || ""}`}>
      <Link href="/vendor/applications" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-emerald-700">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to applications
      </Link>

      {/* Status + actions */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center gap-3">
          <VendorStatusBadge status={status} />
          {a.disbursed_at && (
            <span className="text-xs text-slate-500">
              Disbursed {new Date(a.disbursed_at).toLocaleString()} · ref {a.disbursement_ref || "—"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={!canAccept || accept.isPending}
            onClick={() => accept.mutate()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {accept.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Accept
          </button>
          <button
            disabled={!canDisburse}
            onClick={() => setDisbOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Banknote className="h-3.5 w-3.5" />
            Disburse
          </button>
          <button
            disabled={!canReject}
            onClick={() => setRejectOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </button>
        </div>
      </div>

      {/* Two-column layout: applicant + loan */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">Applicant</h2>
          <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2">
            <Field label="Full name" value={a.customer_name} />
            <Field label="Phone" value={a.phone} icon={Phone} />
            <Field label="Email" value={a.email} icon={Mail} />
            <Field label="PAN" value={a.pan_number} />
            <Field label="Date of birth" value={a.date_of_birth} />
            <Field label="Gender" value={a.gender} />
            <Field label="City" value={a.city} />
            <Field label="State" value={a.state} />
            <Field label="Employment" value={a.employment_type} />
            <Field label="Employer" value={a.employer_name} />
            <Field label="Monthly income" value={fmtINR(a.monthly_income)} />
            <Field label="Designation" value={a.designation} />
          </dl>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">Loan</h2>
          <dl className="space-y-3">
            <Field label="Bank" value={a.bank_name} icon={Building2} />
            <Field label="Requested amount" value={fmtINR(a.requested_loan_amount)} />
            <Field label="Loan purpose" value={a.loan_purpose} />
            <Field label="Approved at" value={a.approved_at ? new Date(a.approved_at).toLocaleString() : "—"} />
            {a.disbursed_amount && (
              <Field label="Disbursed amount" value={fmtINR(a.disbursed_amount)} />
            )}
            {a.rejection_reason && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                <div className="font-semibold uppercase tracking-wider">Rejection reason</div>
                <div className="mt-1">{a.rejection_reason}</div>
              </div>
            )}
            {a.notes && (
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-semibold uppercase tracking-wider">Bank's notes</div>
                <div className="mt-1">{a.notes}</div>
              </div>
            )}
          </dl>
        </section>
      </div>

      {rejectOpen && (
        <RejectModal
          avaId={avaId}
          token={token}
          onClose={() => setRejectOpen(false)}
          onDone={() => { setRejectOpen(false); invalidate(); }}
        />
      )}
      {disbOpen && (
        <DisburseModal
          avaId={avaId}
          requestedAmount={a.requested_loan_amount}
          token={token}
          onClose={() => setDisbOpen(false)}
          onDone={() => { setDisbOpen(false); invalidate(); }}
        />
      )}
    </VendorShell>
  );
}

function Field({ label, value, icon: Icon }: { label: string; value: any; icon?: React.ComponentType<{ className?: string }> }) {
  const v = value ?? "—";
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-800 dark:text-gray-200">
        {Icon && <Icon className="h-3.5 w-3.5 text-slate-400" />}
        {String(v)}
      </dd>
    </div>
  );
}

function RejectModal({
  avaId, token, onClose, onDone,
}: { avaId: string; token: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = React.useState("");
  const m = useMutation({
    mutationFn: () => vendorReject(token, avaId, reason),
    onSuccess: () => { toast.success("Assignment rejected"); onDone(); },
    onError: (e: any) => toast.error(e?.message || "Reject failed"),
  });
  return (
    <Backdrop onClose={onClose}>
      <h3 className="text-lg font-bold">Reject assignment</h3>
      <p className="mt-1 text-sm text-slate-500">
        Tell the bank why you can't disburse this loan. The application returns to the bank for reassignment.
      </p>
      <textarea
        autoFocus
        rows={4}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. CIBIL score 620 — below our cutoff of 700"
        className="mt-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-rose-500 focus:ring-2 dark:border-gray-700 dark:bg-gray-800"
      />
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
        <button
          disabled={reason.trim().length < 3 || m.isPending}
          onClick={() => m.mutate()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:opacity-50"
        >
          {m.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Confirm reject
        </button>
      </div>
    </Backdrop>
  );
}

function DisburseModal({
  avaId, requestedAmount, token, onClose, onDone,
}: { avaId: string; requestedAmount?: number; token: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = React.useState<string>(requestedAmount ? String(requestedAmount) : "");
  const [ref, setRef] = React.useState("");
  const m = useMutation({
    mutationFn: () => vendorDisburse(token, avaId, Number(amount), ref),
    onSuccess: () => { toast.success("Disbursed — settlement created"); onDone(); },
    onError: (e: any) => toast.error(e?.message || "Disbursement failed"),
  });
  const valid = Number(amount) > 0 && ref.trim().length >= 2;
  return (
    <Backdrop onClose={onClose}>
      <h3 className="text-lg font-bold">Confirm disbursement</h3>
      <p className="mt-1 text-sm text-slate-500">
        Settlement row is auto-created with commission split from your partnership rate.
      </p>
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-slate-500">Disbursed amount (₹)</span>
          <input
            type="number" min={1} step="0.01"
            value={amount} onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500 focus:ring-2 dark:border-gray-700 dark:bg-gray-800"
          />
          {requestedAmount && (
            <span className="mt-1 block text-xs text-slate-500">Bank requested: ₹{requestedAmount.toLocaleString("en-IN")}</span>
          )}
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wider text-slate-500">Disbursement ref / transaction ID</span>
          <input
            type="text" value={ref} onChange={(e) => setRef(e.target.value)}
            placeholder="e.g. TXN-2026-001234"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500 focus:ring-2 dark:border-gray-700 dark:bg-gray-800"
          />
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
        <button
          disabled={!valid || m.isPending}
          onClick={() => m.mutate()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {m.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Confirm disburse
        </button>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-gray-800 dark:bg-gray-900" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
