"use client";

// Bank applications list — Finix design migration (Job 2).
//
// NO FEATURE LOSS. Preserved 1:1 from the legacy page:
//  - Auth gate (token+user, redirect to /bank/login) and `enabled: Boolean(user)`
//    so the query never fires unauthenticated.
//  - react-query with the SAME queryKey and the 30s refetchInterval — this list
//    is a live queue, so the polling is behaviour, not decoration.
//  - The 9-entry STATUS_FILTERS list with per-status counts (a different, longer
//    list than the dashboard's role-based one — kept distinct on purpose).
//  - Search across name / phone / loan ID / raw id.
//  - All 9 columns, the applicant deep-link that stopPropagation()s inside the
//    already-clickable row, and the AI score thresholds (>=70 / >=50).
//  - The two distinct empty messages: "none assigned yet" vs "no results for X".
//
// Statuses here are spelled `status.replace(/_/g," ")` as before rather than via
// STATUS_LABELS, so the filter wording the user knows does not shift.
//
// ADDED (legacy gap, not a regression): a real error state. Previously a failed
// fetch fell through to the empty-list message, so an outage looked like "no
// applications". q.isError now surfaces with a Retry.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { API_URL } from "@/lib/api";
import { getAccessToken, getCurrentUser } from "@/lib/auth";
import { BankUserShell } from "../_shell/BankUserShell";
import {
  Toolbar,
  Breadcrumb,
  PageTitle,
  FilterPills,
  Card,
  CardHeader,
  Table,
  TwoLine,
  AppStatusPill,
  InterestPill,
  FormStatusPill,
  ScorePill,
  LoadingState,
  EmptyState,
  ErrorState,
  type Column,
} from "@/components/finix";

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

  const cols: Column<AppRow>[] = [
    {
      key: "applicant", header: "Applicant",
      render: (a) => (
        <TwoLine
          primary={
            <Link
              href={`/bank/applications/${a.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-fx-text transition-colors hover:text-[var(--fx-accent)]"
            >
              {a.customer_name || a.full_name || "—"}
            </Link>
          }
          secondary={a.phone ? <span className="fx-mono">{a.phone}</span> : undefined}
        />
      ),
    },
    { key: "loan_id", header: "Loan ID", nowrap: true, render: (a) => <span className="fx-mono text-fx-text2">{a.loan_id || "—"}</span> },
    {
      key: "type", header: "Type", nowrap: true,
      render: (a) => (
        <span className="text-fx-text2">
          {a.consumer_loan_type === "consumer_durable" ? "Consumer durable" : a.consumer_loan_type === "personal" ? "Personal" : "—"}
        </span>
      ),
    },
    {
      key: "amount", header: "Amount", align: "right",
      render: (a) => fmtINR(a.requested_loan_amount ?? a.loan_amount_requested),
    },
    { key: "status", header: "Status", nowrap: true, render: (a) => <AppStatusPill status={a.status} /> },
    { key: "interested", header: "Interested", nowrap: true, render: (a) => <InterestPill interested={a.interested} /> },
    { key: "form", header: "Form", nowrap: true, render: (a) => <FormStatusPill status={a.form_status} /> },
    { key: "score", header: "AI score", align: "right", render: (a) => <ScorePill score={a.system_score} /> },
    {
      key: "submitted", header: "Submitted", align: "right",
      render: (a) => <span className="text-fx-text2">{fmtDate(a.submitted_at || a.created_at)}</span>,
    },
  ];

  return (
    <BankUserShell>
      <Toolbar left={<Breadcrumb>applications</Breadcrumb>} />
      <PageTitle
        title="Applications"
        subtitle={`${user?.bank_name ? `${user.bank_name} · ` : ""}${apps.length} total`}
      />

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name, phone, loan ID…"
        className="w-full rounded-[10px] bg-fx-surface2 px-3 py-2 text-[13px] text-fx-text outline-none placeholder:text-fx-text3 focus:shadow-[inset_0_0_0_1px_var(--fx-accent)] sm:max-w-sm"
      />

      <Card>
        <CardHeader
          title="All applications"
          qualifier={`${filtered.length} shown`}
          right={
            <FilterPills
              options={STATUS_FILTERS.map((f) => ({
                key: f,
                label: f.replace(/_/g, " "),
                count: counts[f],
              }))}
              value={filter}
              onChange={setFilter}
            />
          }
        />
        {q.isLoading ? (
          <LoadingState label="Loading applications…" rows={8} />
        ) : q.isError ? (
          <ErrorState
            title="Failed to load applications"
            detail={(q.error as Error)?.message}
            onRetry={() => q.refetch()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={apps.length === 0 ? "No applications yet" : "No results"}
            description={
              apps.length === 0
                ? "No applications assigned to your bank yet."
                : `No results for "${search || filter}".`
            }
          />
        ) : (
          <Table
            columns={cols}
            rows={filtered}
            rowKey={(a) => a.id}
            onRowClick={(a) => router.push(`/bank/applications/${a.id}`)}
          />
        )}
      </Card>
    </BankUserShell>
  );
}
