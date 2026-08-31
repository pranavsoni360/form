"use client";

/**
 * /ops/calls — full calls table with filters, pagination, search, per-row
 * detail dialog.
 *
 * 1:1 feature parity with the old /agent dashboard's "Calls" tab:
 *   ✓ Pagination (20/page, prev/next + jump-to-page input)
 *   ✓ Filters: status, category, lead quality, form sent, date
 *   ✓ Client-side search box on customer name + phone
 *   ✓ Per-row actions: Open WhatsApp form, View Detail (with transcript +
 *     recording inline in dialog)
 *
 * Endpoint: GET /api/agent/calls?page=&page_size=20&status=&category=&
 *           lead_quality=&form_sent=&date=
 * Auth: none (operator mode — same as old /agent dashboard).
 */

import * as React from "react";
import { opsFetch } from "@/lib/ops-fetch";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  PhoneCall,
  Search,
  X as XIcon,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { FilterPills, type FilterOption } from "@/components/ops/FilterPills";
import {
  CallDetailDialog,
  fmtDuration,
  maskPhone,
  statusVariant,
} from "@/components/ops/CallDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/api";

/* ───────────────────────── Backend response shape ────────────────────── */

interface CallRow {
  id: string;
  _id?: string;
  customer_name?: string;
  name?: string;
  phone: string;
  status: string;
  call_status?: string;
  category?: string;
  loan_type?: string;
  loan_type_interested?: string;
  loan_amount?: number | string;
  call_duration?: number;
  call_duration_seconds?: number;
  interested?: boolean;
  customer_interested?: boolean;
  form_sent?: boolean;
  whatsapp_form_sent?: boolean;
  form_url?: string;
  form_link?: string;
  recording_url?: string | null;
  language?: string;
  call_analysis?: { lead_quality?: string } | null;
  lead_quality?: string;
  started_at?: string;
  created_at?: string;
  scheduled_callback_at?: string | null;
}

interface CallsResponse {
  calls: CallRow[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

/* ───────────────────────── Filter option lists ───────────────────────── */
// Mirror the backend STATUS_OPTIONS / CATEGORY_OPTIONS verbatim so the
// dropdowns line up with what the dispatcher writes. Changing these on the
// frontend without the backend list breaks filtering — keep in sync.

const STATUS_OPTIONS = [
  "Pending",
  "Calling",
  "Called",
  "Called - Interested",
  "Called - Not Interested",
  "Called - Callback Requested",
  "Not Answered",
  "Call Not Connected",
  "Failed",
  "Scheduled",
  "Invalid Phone",
  "Wrong Contact",
] as const;

const CATEGORY_OPTIONS = [
  "Very Interested - Form Sent",
  "Interested - Callback Requested",
  "Interested - Needs Time to Decide",
  "Not Interested - Already Has Loan",
  "Not Interested - No Need Currently",
  "Ineligible - Income Too Low",
  "Ineligible - Business Too New",
  "Wrong Number / Not Reachable",
] as const;

type LeadQuality = "all" | "hot" | "warm" | "cold";
type FormSent = "all" | "yes" | "no";

/* ───────────────────────────── Page ──────────────────────────────────── */

export default function OpsCallsPage() {
  // Filters
  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all");
  const [leadFilter, setLeadFilter] = React.useState<LeadQuality>("all");
  const [formFilter, setFormFilter] = React.useState<FormSent>("all");
  const [dateFilter, setDateFilter] = React.useState<string>(""); // YYYY-MM-DD
  const [search, setSearch] = React.useState("");
  // Debounced search so we don't refetch on every keystroke. Server-side now
  // (OPS-06) so a match on any page is found and the count reflects it.
  const [dSearch, setDSearch] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Detail dialog
  const [openCallId, setOpenCallId] = React.useState<string | null>(null);

  // Reset to page 1 whenever any filter (other than page) changes
  React.useEffect(() => {
    setPage(1);
  }, [statusFilter, categoryFilter, leadFilter, formFilter, dateFilter, dSearch]);

  // Export current filtered calls as XLSX — used by both the inline button
  // and the sidebar "Export view" CTA (which dispatches "finix:export-view").
  const [exporting, setExporting] = React.useState(false);
  const handleExport = React.useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      // Mirror ALL the list's server-side filters so the export matches the
      // screen (OPS-08 + OPS-06): status, category, lead quality, form-sent,
      // name/phone search and date.
      if (leadFilter !== "all") params.set("lead_quality", leadFilter);
      if (formFilter !== "all") params.set("form_sent", formFilter);
      if (dSearch) params.set("search", dSearch);
      if (dateFilter) {
        params.set("date_from", dateFilter);
        params.set("date_to", dateFilter);
      }
      const qs = params.toString();
      const res = await opsFetch(`/api/agent/export/all-calls${qs ? `?${qs}` : ""}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `calls_${dateFilter || new Date().toISOString().split("T")[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [statusFilter, categoryFilter, leadFilter, formFilter, dSearch, dateFilter, exporting]);

  React.useEffect(() => {
    const handler = () => handleExport();
    window.addEventListener("finix:export-view", handler);
    return () => window.removeEventListener("finix:export-view", handler);
  }, [handleExport]);

  const query = useQuery<CallsResponse>({
    queryKey: [
      "calls",
      page,
      statusFilter,
      categoryFilter,
      leadFilter,
      formFilter,
      dateFilter,
      dSearch,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", "20");
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (leadFilter !== "all") params.set("lead_quality", leadFilter);
      if (formFilter !== "all") params.set("form_sent", formFilter);
      if (dSearch) params.set("search", dSearch);
      if (dateFilter) params.set("date", dateFilter);
      const res = await opsFetch(`${API_URL}/api/agent/calls?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  // Search is now server-side (OPS-06), so the table renders exactly what the
  // server returned for the current page + filters + search.
  const filteredRows = query.data?.calls ?? [];

  // Global KPI counts — lightweight count-only queries (page_size=1, just read `total`)
  const fetchCount = async (params: Record<string, string>) => {
    const p = new URLSearchParams({ page_size: "1", ...params });
    const res = await opsFetch(`${API_URL}/api/agent/calls?${p}`, { credentials: "include" });
    if (!res.ok) return 0;
    return ((await res.json()) as CallsResponse).total ?? 0;
  };
  const interestedCount = useQuery<number>({ queryKey: ["kpi-interested"], queryFn: () => fetchCount({ status: "Called - Interested" }), refetchInterval: 30_000 });
  const formSentCount   = useQuery<number>({ queryKey: ["kpi-form-sent"],  queryFn: () => fetchCount({ form_sent: "yes" }),                refetchInterval: 30_000 });
  const failedCount     = useQuery<number>({ queryKey: ["kpi-failed"],     queryFn: () => fetchCount({ status: "Failed" }),                refetchInterval: 30_000 });

  const handleCardClick = (type: "interested" | "form_sent" | "failed") => {
    setStatusFilter("all"); setCategoryFilter("all"); setLeadFilter("all"); setFormFilter("all"); setDateFilter(""); setSearch("");
    if (type === "interested") setStatusFilter("Called - Interested");
    if (type === "form_sent")  setFormFilter("yes");
    if (type === "failed")     setStatusFilter("Failed");
  };

  /* ─── Columns ─────────────────────────────────────────────────────── */

  const columns: ReadonlyArray<DataTableColumn<CallRow>> = [
    {
      key: "customer",
      header: "Customer",
      render: (r) => (
        <div className="space-y-0.5">
          <div className="text-sm font-semibold text-foreground">
            {r.customer_name || r.name || "Customer"}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {maskPhone(r.phone)}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => {
        const st = r.status || r.call_status || "";
        const isCallback = st === "Called - Callback Requested";
        return (
          <div className="space-y-0.5">
            <Badge variant={statusVariant(st)}>
              {isCallback ? "Callback Scheduled" : st || "—"}
            </Badge>
            {isCallback && r.scheduled_callback_at && (
              <div className="font-mono text-[10px] text-amber-400/80">
                {fmtCallbackTime(r.scheduled_callback_at)}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "lead",
      header: "Lead",
      render: (r) => (
        <LeadBadge q={r.call_analysis?.lead_quality ?? r.lead_quality} />
      ),
    },
    {
      key: "type",
      header: "Loan",
      render: (r) => (
        <span className="text-xs text-foreground/80 capitalize">
          {r.loan_type || r.loan_type_interested || "—"}
        </span>
      ),
    },
    {
      key: "interested",
      header: "Interested",
      align: "center",
      render: (r) => (
        <BoolDot yes={r.customer_interested ?? r.interested} />
      ),
    },
    {
      key: "form",
      header: "Form",
      align: "center",
      render: (r) => <BoolDot yes={r.whatsapp_form_sent ?? r.form_sent} />,
    },
    {
      key: "duration",
      header: "Duration",
      align: "right",
      render: (r) => (
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {fmtDuration(r.call_duration_seconds ?? r.call_duration ?? 0)}
        </span>
      ),
    },
    {
      key: "when",
      header: "When",
      align: "right",
      render: (r) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {fmtWhen(r.started_at || r.created_at || "")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => {
        const formUrl = r.form_url || r.form_link || "";
        return (
          <div className="flex items-center justify-end gap-1.5">
            {formUrl && (
              <a
                href={formUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open WhatsApp form"
                onClick={(e) => e.stopPropagation()}
                className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenCallId(r.id || r._id || "");
              }}
              title="View details"
              className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      },
    },
  ];

  /* ─── Filter option lists ─────────────────────────────────────────── */

  const leadOptions: ReadonlyArray<FilterOption<LeadQuality>> = [
    { value: "all", label: "All leads" },
    { value: "hot", label: "Hot" },
    { value: "warm", label: "Warm" },
    { value: "cold", label: "Cold" },
  ];
  const formOptions: ReadonlyArray<FilterOption<FormSent>> = [
    { value: "all", label: "Any form state" },
    { value: "yes", label: "Sent" },
    { value: "no", label: "Not sent" },
  ];

  const total = query.data?.total ?? 0;
  const totalPages = query.data?.total_pages ?? 1;
  const hasActiveFilter =
    statusFilter !== "all" ||
    categoryFilter !== "all" ||
    leadFilter !== "all" ||
    formFilter !== "all" ||
    Boolean(dateFilter) ||
    Boolean(search.trim());

  return (
    <AppShell
      title="Calls"
      subtitle={`${total.toLocaleString()} total call${total === 1 ? "" : "s"} · page ${page} of ${totalPages}`}
    >
      <div className="space-y-6">
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="TOTAL CALLS"
            value={total.toLocaleString()}
            icon={PhoneCall}
            tone="info"
            hint="all records"
          />
          <StatCard
            label="INTERESTED"
            value={interestedCount.data ?? "—"}
            icon={PhoneCall}
            tone="success"
            hint="Click to view records"
            onClick={() => handleCardClick("interested")}
            active={statusFilter === "Called - Interested"}
          />
          <StatCard
            label="FORM SENT"
            value={formSentCount.data ?? "—"}
            icon={PhoneCall}
            tone="info"
            hint="Click to view records"
            onClick={() => handleCardClick("form_sent")}
            active={formFilter === "yes"}
          />
          <StatCard
            label="FAILED"
            value={failedCount.data ?? "—"}
            icon={PhoneCall}
            tone={(failedCount.data ?? 0) > 0 ? "danger" : "neutral"}
            hint="Click to view records"
            onClick={() => handleCardClick("failed")}
            active={statusFilter === "Failed"}
          />
        </div>

        {/* Filter bar */}
        <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
          {/* Row 1: lead + form */}
          <div className="flex flex-wrap items-center gap-3">
            <FilterPills options={leadOptions} value={leadFilter} onChange={setLeadFilter} />
            <FilterPills options={formOptions} value={formFilter} onChange={setFormFilter} />
          </div>

          {/* Row 2: status + category + date + search + export */}
          <div className="flex flex-wrap items-center gap-3">
            <Select
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: "All statuses" },
                ...STATUS_OPTIONS.map((s) => ({ value: s, label: s })),
              ]}
            />
            <Select
              label="Category"
              value={categoryFilter}
              onChange={setCategoryFilter}
              options={[
                { value: "all", label: "All categories" },
                ...CATEGORY_OPTIONS.map((c) => ({ value: c, label: c })),
              ]}
            />
            <DateInput value={dateFilter} onChange={setDateFilter} />
            <SearchBox value={search} onChange={setSearch} />
            {hasActiveFilter && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStatusFilter("all");
                  setCategoryFilter("all");
                  setLeadFilter("all");
                  setFormFilter("all");
                  setDateFilter("");
                  setSearch("");
                }}
              >
                <XIcon className="h-3.5 w-3.5" />
                Clear
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={exporting}
              className="ml-auto gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              {exporting ? "Exporting…" : "Export view"}
            </Button>
          </div>
        </div>

        {/* Table */}
        {query.isLoading ? (
          <TableSkeleton />
        ) : query.error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
            Couldn&apos;t load calls: <span className="font-mono">{(query.error as Error).message}</span>
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={filteredRows}
            rowKey={(r) => r.id || r._id || ""}
            onRowClick={(r) => setOpenCallId(r.id || r._id || "")}
            empty={<EmptyBox hasFilter={hasActiveFilter} />}
          />
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onChange={setPage}
            disabled={query.isFetching}
          />
        )}
      </div>

      {/* Detail dialog */}
      <CallDetailDialog
        callId={openCallId}
        open={Boolean(openCallId)}
        onClose={() => setOpenCallId(null)}
      />
    </AppShell>
  );
}

/* ───────────────────────────── Subcomponents ─────────────────────────── */

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DateInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Date
      </span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </label>
  );
}

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        placeholder="Search name or phone"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-56 rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
  disabled,
}: {
  page: number;
  totalPages: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-2.5 shadow-sm">
      <div className="text-xs text-muted-foreground">
        Page <span className="font-semibold text-foreground">{page}</span> of{" "}
        <span className="font-semibold text-foreground">{totalPages}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={disabled || page <= 1}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={disabled || page >= totalPages}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function LeadBadge({ q }: { q?: string }) {
  if (q === "hot") return <Badge variant="destructive">Hot</Badge>;
  if (q === "warm") return <Badge variant="warning">Warm</Badge>;
  if (q === "cold") return <Badge variant="secondary">Cold</Badge>;
  return <span className="text-xs text-muted-foreground">—</span>;
}

function BoolDot({ yes }: { yes?: boolean }) {
  const tone =
    yes === true
      ? "bg-success"
      : yes === false
      ? "bg-muted-foreground/40"
      : "bg-muted-foreground/20";
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full", tone)}
      aria-label={yes ? "yes" : "no"}
    />
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card p-4 shadow-sm">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

function EmptyBox({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
        <PhoneCall className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="mt-3 text-sm font-semibold">
        {hasFilter ? "No calls match these filters" : "No calls yet"}
      </div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        {hasFilter
          ? "Try widening the date range, clearing the search box, or switching status / category back to 'All'."
          : "Upload a CSV from the Batch page to start dialing."}
      </div>
    </div>
  );
}

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-IN", {
      // Pin to IST so the displayed day matches the backend's IST date filter
      // (and stays correct regardless of the viewer's browser timezone).
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/** Format a scheduled_callback_at ISO string as "Mon 26 May, 10:00 AM" in IST. */
function fmtCallbackTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}
