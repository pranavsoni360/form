"use client";

/**
 * /ops/callbacks — scheduled callbacks list.
 *
 * Mirrors the "Scheduled Callbacks" table that lived on the old /agent
 * dashboard's home tab (lines 1271–1292 of agent-dashboard.html). Backend:
 * GET /api/agent/scheduled-callbacks?limit=50 → { scheduled: [...], count }
 *
 * Auth: none required (operator mode).
 */

import * as React from "react";
import { opsFetch } from "@/lib/ops-fetch";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Eye, RefreshCw, RotateCcw, Plus, Loader2 } from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { CallDetailDialog, maskPhone } from "@/components/ops/CallDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL } from "@/lib/api";

interface CallbackRow {
  id?: string;
  _id?: string;
  customer_name?: string;
  name?: string;
  phone: string;
  scheduled_callback_at?: string | null;
  callback_reason?: string | null;
  retry_count?: number;
  language?: string;
}

interface CallbacksResponse {
  scheduled: CallbackRow[];
  count: number;
}

export default function OpsCallbacksPage() {
  const [openCallId, setOpenCallId] = React.useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const query = useQuery<CallbacksResponse>({
    queryKey: ["scheduled-callbacks"],
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/agent/scheduled-callbacks?limit=50`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const rows = query.data?.scheduled ?? [];
  const total = query.data?.count ?? 0;

  // Bucket counts: next hour vs later today vs later
  const buckets = React.useMemo(() => {
    const now = Date.now();
    const oneHour = 60 * 60_000;
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const endMs = endOfDay.getTime();
    let nextHour = 0, today = 0, later = 0;
    for (const r of rows) {
      if (!r.scheduled_callback_at) continue;
      const t = new Date(r.scheduled_callback_at).getTime();
      if (Number.isNaN(t)) continue;
      if (t - now <= oneHour) nextHour += 1;
      else if (t <= endMs) today += 1;
      else later += 1;
    }
    return { nextHour, today, later };
  }, [rows]);

  const columns: ReadonlyArray<DataTableColumn<CallbackRow>> = [
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
      key: "when",
      header: "Scheduled for",
      render: (r) => <ScheduledPill iso={r.scheduled_callback_at} />,
    },
    {
      key: "reason",
      header: "Reason",
      render: (r) => (
        <span className="text-xs text-foreground/80 capitalize">
          {(r.callback_reason || "—").replace(/_/g, " ")}
        </span>
      ),
    },
    {
      key: "retry",
      header: "Retry",
      align: "center",
      render: (r) => (
        <Badge variant="secondary" className="gap-1">
          <RotateCcw className="h-3 w-3" />
          {r.retry_count ?? 0}
        </Badge>
      ),
    },
    {
      key: "language",
      header: "Lang",
      render: (r) => (
        <span className="text-[11px] uppercase text-muted-foreground">
          {r.language || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpenCallId(r.id || r._id || "");
          }}
          className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="View call details"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
      ),
    },
  ];

  return (
    <AppShell
      title="Scheduled callbacks"
      subtitle={`${total} call${total === 1 ? "" : "s"} queued for retry · ordered by scheduled time`}
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="TOTAL QUEUED" value={total} icon={CalendarClock} tone="info" />
          <StatCard label="NEXT HOUR" value={buckets.nextHour} icon={CalendarClock} tone={buckets.nextHour > 0 ? "warning" : "neutral"} />
          <StatCard label="LATER TODAY" value={buckets.today} icon={CalendarClock} tone="neutral" />
          <StatCard label="FUTURE" value={buckets.later} icon={CalendarClock} tone="neutral" />
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button size="sm" onClick={() => setScheduleOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Schedule callback
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {query.isLoading ? (
          <div className="space-y-2 rounded-2xl border border-border bg-card p-4 shadow-sm">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : query.error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
            Couldn&apos;t load callbacks: <span className="font-mono">{(query.error as Error).message}</span>
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id || r._id || r.phone}
            onRowClick={(r) => setOpenCallId(r.id || r._id || "")}
            empty={<EmptyBox />}
          />
        )}
      </div>

      <CallDetailDialog
        callId={openCallId}
        open={Boolean(openCallId)}
        onClose={() => setOpenCallId(null)}
      />

      <ScheduleCallbackDialog
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onScheduled={() => { setScheduleOpen(false); query.refetch(); }}
      />
    </AppShell>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30";

function ScheduleCallbackDialog({
  open, onClose, onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [when, setWhen] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [language, setLanguage] = React.useState("hindi");
  const [bankId, setBankId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  // Every callback must belong to a bank, or the call is invisible in that
  // bank's portal AND unbillable (billing short-circuits on a missing bank_id).
  // This is an operator page, so the bank has to be chosen — the same rule
  // /ops/batch already applies to an uploaded batch.
  const banks = useQuery<{ banks: Array<{ id: string; name: string; status?: string }> }>({
    queryKey: ["banks-list"],
    queryFn: () => opsFetch(`${API_URL}/api/admin/banks`, { credentials: "include" }).then((r) => r.json()),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  // Reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setName(""); setPhone(""); setWhen(""); setReason("");
      setLanguage("hindi"); setBankId(""); setError(""); setSaving(false);
    }
  }, [open]);

  const submit = async () => {
    setError("");
    if (!name.trim()) { setError("Customer name is required"); return; }
    if (phone.replace(/\D/g, "").length < 10) { setError("Enter a valid phone number"); return; }
    if (!when) { setError("Pick a callback date & time"); return; }
    if (!bankId) { setError("Select the bank this callback belongs to"); return; }
    setSaving(true);
    try {
      const res = await opsFetch(`${API_URL}/api/agent/schedule-callback-manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          customer_name: name.trim(),
          phone: phone.trim(),
          callback_iso: when,          // datetime-local → naive ISO, treated as IST
          reason: reason.trim() || "manual",
          language,
          bank_id: bankId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = data?.detail;
        setError(typeof d === "string" ? d : "Failed to schedule callback");
        return;
      }
      onScheduled();
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Schedule a callback"
      description="Queue an outbound call to a customer at a chosen time. The dispatcher dials it during working hours."
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />}
            {saving ? "Scheduling…" : "Schedule"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Bank *</label>
          <select className={inputCls} value={bankId} onChange={(e) => setBankId(e.target.value)}>
            <option value="">{banks.isLoading ? "Loading banks…" : "Select a bank…"}</option>
            {/* Active banks only - see the same filter in /ops/batch. */}
            {(banks.data?.banks ?? [])
              .filter((b) => (b.status ?? "active") === "active")
              .map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
          </select>
          {!bankId && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Required — an unassigned callback never appears in a bank&apos;s portal and is not billed.
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Customer name *</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rahul Sharma" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Phone *</label>
          <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ""))} placeholder="10-digit mobile" inputMode="tel" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Callback date &amp; time *</label>
          <input type="datetime-local" className={inputCls} value={when} onChange={(e) => setWhen(e.target.value)} />
          <p className="mt-1 text-[11px] text-muted-foreground">Outside working hours, it snaps to the next window start.</p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Language</label>
          <select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="hindi">Hindi</option>
            <option value="marathi">Marathi</option>
            <option value="english">English</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Reason</label>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. requested follow-up" />
        </div>
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
        )}
      </div>
    </Dialog>
  );
}

function ScheduledPill({ iso }: { iso?: string | null }) {
  if (!iso) return <span className="text-xs text-muted-foreground">—</span>;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return <span className="font-mono text-xs">{iso}</span>;
  const deltaMs = t - Date.now();
  const isPast = deltaMs < 0;
  const tone = isPast
    ? "destructive"
    : deltaMs < 60 * 60_000
    ? "warning"
    : "secondary";
  const human = fmtRelative(deltaMs);
  const exact = new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <div className="space-y-0.5">
      <Badge variant={tone}>{human}</Badge>
      <div className="font-mono text-[10px] text-muted-foreground">{exact}</div>
    </div>
  );
}

function fmtRelative(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const past = deltaMs < 0;
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return past ? `${sec}s ago` : `in ${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return past ? `${h}h ago` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return past ? `${d}d ago` : `in ${d}d`;
}

function EmptyBox() {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
        <CalendarClock className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="mt-3 text-sm font-semibold">No callbacks scheduled</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        When a customer asks to be called back at a specific time, the row will
        appear here. The dispatcher re-dials at the scheduled time during
        working hours.
      </div>
    </div>
  );
}
