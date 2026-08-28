"use client";

/**
 * /ops/batch — operator-side batch upload + dispatcher controls.
 *
 * Sister page to /bank/batch (bank-user side). Functionally mirrors the
 * "Upload Excel" tab of the old /agent dashboard (lines 1471–1602 of
 * agent-dashboard.html). Six action buttons + uploads history + per-batch
 * detail modal + live status banner.
 *
 * Endpoints (all unauthenticated — operator mode):
 *   POST /api/agent/upload-excel?language=&gender=&agent_type= (multipart)
 *   GET  /api/agent/uploads                        → { uploads: [...] }
 *   GET  /api/agent/upload/{batch_id}              → { calls: [...], total }
 *   GET  /api/agent/batch-status                   → counters + is_complete
 *   POST /api/agent/batch-call                     → starts most-recent pending batch
 *   POST /api/agent/batch-retry                    → retries failed calls
 *   POST /api/agent/emergency-stop                 → pauses, kills active, sets flag
 *   POST /api/agent/resume-calling                 → un-pauses
 *   POST /api/agent/stale-cleanup                  → fixes calls stuck in 'Calling'
 *
 * Lives at /ops/batch so operators get all the controls in one place; the
 * bank-user version at /bank/batch keeps a slimmer UX appropriate to that
 * role.
 */

import * as React from "react";
import { opsFetch } from "@/lib/ops-fetch";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Hammer,
  Loader2,
  PhoneOff,
  PhoneMissed,
  Play,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Square,
  CircleStop,
  Upload,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { maskPhone, statusVariant, fmtDuration } from "@/components/ops/CallDetailDialog";
import { BatchPreviewModal, type BatchReport } from "@/components/shared/BatchPreviewModal";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ───────────────────────── Backend response shapes ───────────────────── */

interface BatchStatus {
  status: string;
  is_complete: boolean;
  message: string;
  pending: number;
  active_calls: number;
  failed: number;
  not_answered: number;
  completed: number;
  total: number;
}

interface Upload {
  id: string;
  _id?: string;
  created_at?: string;
  uploaded_at?: string;
  total_records?: number;
  record_count?: number;
  status?: string;
  filename?: string;
  file_name?: string;
  language?: string;
  agent_voice?: string;
  agent_type?: string;
}

interface BatchCall {
  id: string;
  customer_name?: string;
  phone: string;
  status: string;
  call_duration?: number;
  interested?: boolean;
  form_sent?: boolean;
  created_at?: string;
}

/* ───────────────────────────── Page ──────────────────────────────────── */

export default function OpsBatchPage() {
  const qc = useQueryClient();

  // Upload config
  const [language, setLanguage] = React.useState<"hindi" | "marathi" | "english">("hindi");
  const [gender, setGender] = React.useState<"male" | "female">("male");
  const [agentType, setAgentType] = React.useState<"loan_enquiry" | "account_opening">("loan_enquiry");

  // "From number" — empty string = auto-pick from pool, else a phone_numbers UUID
  const [phoneNumberId, setPhoneNumberId] = React.useState<string>("");

  // Bank assignment — empty = no bank scoping (calls won't appear in bank portal)
  const [bankId, setBankId] = React.useState<string>("");

  // Selected batch for detail dialog
  const [openBatchId, setOpenBatchId] = React.useState<string | null>(null);

  /* ─── Banks list (for bank assignment dropdown) ───────────────────────── */
  const banks = useQuery<{ banks: Array<{ id: string; name: string; status?: string }> }>({
    queryKey: ["banks-list"],
    queryFn: () => opsFetch(`${API_URL}/api/admin/banks`, {
      headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('los_admin_token') || '' : ''}` }
    }).then(r => r.json()),
    staleTime: 60_000,
  });

  /* ─── Phone pool (for "From number" dropdown) ─────────────────────────── */

  const pools = useQuery<{
    pools: Array<{
      id: string;
      name: string;
      numbers: Array<{
        id: string;
        phone_number: string | null;
        active_calls: number;
        status: string;
        cooldown_until: string | null;
      }>;
    }>;
  }>({
    queryKey: ["phone-pools"],
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/ops/phone-pools`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  // Flatten every active phone across every pool into a single dropdown list.
  const phoneOptions = React.useMemo(() => {
    const out: Array<{ id: string; phone: string; status: string; provider: string }> = [];
    for (const p of pools.data?.pools ?? []) {
      for (const n of p.numbers) {
        if (!n.phone_number || n.status !== "active") continue;
        out.push({
          id: n.id,
          phone: n.phone_number,
          status: n.status,
          provider: n.phone_number.startsWith("+1") ? "Twilio US" :
                    n.phone_number.startsWith("+91") ? "Viva India" : "?",
        });
      }
    }
    return out.sort((a, b) => a.phone.localeCompare(b.phone));
  }, [pools.data]);

  /* ─── Queries ──────────────────────────────────────────────────────── */

  // batch-status — polled while a batch is active, paused otherwise
  const status = useQuery<BatchStatus>({
    queryKey: ["batch-status"],
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/agent/batch-status`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: (q) => {
      // Poll fast while calls are in flight, slow once everything is at rest.
      const d = q.state.data;
      if (!d) return 5_000;
      return d.active_calls > 0 || d.pending > 0 ? 5_000 : 30_000;
    },
  });

  const uploads = useQuery<{ uploads: Upload[] }>({
    queryKey: ["uploads"],
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/agent/uploads`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  /* ─── Mutations ────────────────────────────────────────────────────── */

  // Preprocessing preview + confirm state. The file is uploaded once with
  // commit=false to preview (dedupe / invalid / missing name-number), and only
  // re-sent with commit=true when the operator confirms.
  const [preview, setPreview] = React.useState<BatchReport | null>(null);
  const [pendingFile, setPendingFile] = React.useState<File | null>(null);

  const doUpload = async (file: File, commit: boolean) => {
    const fd = new FormData();
    fd.append("file", file);
    // Build query string. Include phone_number_id ONLY when the operator
    // explicitly picked a number — otherwise leave it off and let the
    // dispatcher auto-pick least-loaded.
    const params = new URLSearchParams({ language, gender, agent_type: agentType, commit: String(commit) });
    if (phoneNumberId) params.set("phone_number_id", phoneNumberId);
    if (bankId) params.set("bank_id", bankId);
    const res = await opsFetch(`${API_URL}/api/agent/upload-excel?${params}`, {
      method: "POST",
      body: fd,
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  };

  // Step 1 — preview (no calls queued).
  const upload = useMutation({
    mutationFn: (file: File) => doUpload(file, false),
    onSuccess: (data: BatchReport, file) => {
      setPendingFile(file);
      setPreview(data);
    },
    onError: (e: Error) => toast.error(`Upload failed: ${e.message}`),
  });

  // Step 2 — confirm (queue clean rows + start calling).
  const confirmUpload = useMutation({
    mutationFn: () => {
      if (!pendingFile) throw new Error("No file to confirm");
      return doUpload(pendingFile, true);
    },
    onSuccess: (data) => {
      toast.success(data?.message || `Queued ${data?.inserted_count ?? "?"} record${data?.inserted_count === 1 ? "" : "s"}`);
      setPreview(null);
      setPendingFile(null);
      qc.invalidateQueries({ queryKey: ["uploads"] });
      qc.invalidateQueries({ queryKey: ["batch-status"] });
    },
    onError: (e: Error) => toast.error(`Upload failed: ${e.message}`),
  });

  // Only invalidate the queries this page actually shows, so we don't
  // accidentally clobber unrelated caches (recent_calls on /ops, funnel
  // on /ops/funnel, etc) every time the operator presses a button.
  const refreshBatchViews = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["batch-status"] });
    qc.invalidateQueries({ queryKey: ["uploads"] });
  }, [qc]);

  // "Start batch" — passes the selected phone_number_id as a query param so
  // mid-flight changes to the dropdown take effect on the next start without
  // needing a fresh upload.
  const start = useMutation({
    mutationFn: postJson("/api/agent/batch-call", () =>
      phoneNumberId ? { phone_number_id: phoneNumberId } : undefined
    ),
    onSuccess: (d) => { toast.success(d?.message || "Batch started"); refreshBatchViews(); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Retry is ALWAYS scoped to one explicit batch (OPS-20) — never a server-side
  // "most recent" fallback. The caller passes the batch id.
  const retry = useMutation({
    mutationFn: (batchId: string) =>
      postJson("/api/agent/batch-retry", () => ({ batch_id: batchId }))(),
    onSuccess: (d) => { toast.success(d?.message || "Retry queued"); refreshBatchViews(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const resume = useMutation({
    mutationFn: postJson("/api/agent/resume-calling"),
    onSuccess: (d) => { toast.success(d?.message || "Resumed"); refreshBatchViews(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const stop = useMutation({
    mutationFn: postJson("/api/agent/emergency-stop"),
    onSuccess: (d) => {
      const killed = d?.active_calls_killed ?? 0;
      const base = d?.message || "Emergency stop activated";
      toast.warning(
        killed > 0
          ? `${base} · ${killed} live call${killed === 1 ? "" : "s"} ended`
          : base,
      );
      refreshBatchViews();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cleanup = useMutation({
    mutationFn: postJson("/api/agent/stale-cleanup"),
    onSuccess: (d) => {
      toast.success(`Cleaned ${d?.cleaned ?? "?"} stuck call${d?.cleaned === 1 ? "" : "s"}`);
      refreshBatchViews();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Stop ONE specific batch (per-row). Frees the queue so a freshly uploaded
  // batch starts immediately (auto-chained), unlike the global emergency stop.
  const stopBatch = useMutation({
    mutationFn: async (batchId: string) => {
      const url = new URL(`${API_URL}/api/agent/stop-batch`);
      url.searchParams.set("batch_id", batchId);
      const res = await opsFetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
      return payload;
    },
    onSuccess: (d) => {
      if (d?.status === "noop") {
        toast.info(d?.message || "Nothing to stop");
      } else {
        const k = d?.in_flight_killed ?? 0;
        const c = d?.cancelled ?? 0;
        toast.success(`Batch stopped — ${k} live call${k === 1 ? "" : "s"} ended, ${c} pending cancelled`);
      }
      refreshBatchViews();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Upload input handler ─────────────────────────────────────────── */

  const fileRef = React.useRef<HTMLInputElement>(null);
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // Bank assignment is required — guard here too (the button is also disabled).
    if (f && !bankId) {
      toast.warning("Select a bank to assign this batch to before uploading.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (f) upload.mutate(f);
    // reset so picking the same file again triggers onChange
    if (fileRef.current) fileRef.current.value = "";
  };

  /* ─── Stop confirm ─────────────────────────────────────────────────── */

  const [confirmStop, setConfirmStop] = React.useState(false);

  /* ─── Render ───────────────────────────────────────────────────────── */

  const s = status.data;
  const live = s ? s.active_calls > 0 || s.pending > 0 : false;

  return (
    <AppShell
      title="Batch operations"
      subtitle="Upload CSV/Excel, start dialing, retry failed, emergency stop · operator only"
    >
      <BatchPreviewModal
        report={preview}
        confirming={confirmUpload.isPending}
        onConfirm={() => confirmUpload.mutate()}
        onCancel={() => { setPreview(null); setPendingFile(null); }}
      />
      <div className="space-y-6">
        {/* Live status banner */}
        <LiveStatusBanner s={s} loading={status.isLoading} live={live} />

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard
            label="ACTIVE NOW"
            value={s?.active_calls ?? 0}
            icon={Activity}
            tone={(s?.active_calls ?? 0) > 0 ? "info" : "neutral"}
          />
          <StatCard
            label="PENDING"
            value={s?.pending ?? 0}
            icon={Activity}
            tone={(s?.pending ?? 0) > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="COMPLETED"
            value={s?.completed ?? 0}
            icon={CheckCircle2}
            tone="success"
          />
          <StatCard
            label="FAILED"
            value={s?.failed ?? 0}
            icon={PhoneOff}
            tone={(s?.failed ?? 0) > 0 ? "danger" : "neutral"}
          />
          <StatCard
            label="NOT ANSWERED"
            value={s?.not_answered ?? 0}
            icon={PhoneMissed}
            tone={(s?.not_answered ?? 0) > 0 ? "warning" : "neutral"}
          />
        </div>

        {/* Voice config + upload + actions */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Voice config &amp; upload</CardTitle>
            <CardDescription>
              These are baked into every row at upload time. Existing batches keep their original config.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Select
                label="Language"
                value={language}
                onChange={(v) => setLanguage(v as typeof language)}
                options={[
                  { value: "hindi", label: "🇮🇳 Hindi" },
                  { value: "marathi", label: "🏛️ Marathi" },
                  { value: "english", label: "🌍 English" },
                ]}
              />
              <Select
                label="Voice"
                value={gender}
                onChange={(v) => setGender(v as typeof gender)}
                options={[
                  { value: "male", label: "Male (Rajesh)" },
                  { value: "female", label: "Female (Diya)" },
                ]}
              />
              <Select
                label="Agent type"
                value={agentType}
                onChange={(v) => setAgentType(v as typeof agentType)}
                options={[
                  { value: "loan_enquiry", label: "Loan enquiry — Pusad" },
                  { value: "account_opening", label: "Account opening — Union Bank" },
                ]}
              />
            </div>

            {/* From-number selector — operator's caller-ID pick. Empty value
                means "auto pick least-loaded from pool" (the legacy behaviour);
                a UUID locks every dispatched call to that one row. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label="From number (caller ID)"
                value={phoneNumberId}
                onChange={setPhoneNumberId}
                options={[
                  { value: "", label: pools.isLoading
                      ? "Loading numbers…"
                      : phoneOptions.length === 0
                        ? "(no numbers — auto)"
                        : "Auto (pool picks least-loaded)" },
                  ...phoneOptions.map((p) => ({
                    value: p.id,
                    label: `${p.phone}  ·  ${p.provider}`,
                  })),
                ]}
              />
              {phoneNumberId && (
                <div className="flex items-center text-xs text-muted-foreground">
                  <span className="rounded-md bg-info/10 px-2 py-1 text-info ring-1 ring-info/20">
                    All calls in the next batch will dial FROM this number.
                  </span>
                </div>
              )}
            </div>

            {/* Bank assignment — without this, calls won't appear in any bank portal */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label="Assign to bank (required)"
                value={bankId}
                onChange={setBankId}
                options={[
                  { value: "", label: banks.isLoading ? "Loading banks…" : "Select a bank…" },
                  // Active banks only. The list includes suspended banks and the
                  // LEGACY / UNASSIGNED placeholder; a batch assigned to one of
                  // those is rejected by the backend, so do not offer it.
                  ...(banks.data?.banks ?? [])
                    .filter((b) => (b.status ?? "active") === "active")
                    .map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
              {!bankId && (
                <div className="flex items-center text-xs text-muted-foreground">
                  <span className="rounded-md bg-warning/10 px-2 py-1 text-warning ring-1 ring-warning/20">
                    Pick a bank first — every batch must be assigned to a bank, or its calls won&apos;t appear in any portal.
                  </span>
                </div>
              )}
            </div>

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={onFile}
                className="hidden"
              />
              <Button
                onClick={() => fileRef.current?.click()}
                disabled={upload.isPending || !bankId}
                title={!bankId ? "Select a bank first" : undefined}
                className="btn-solid"
              >
                {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload Excel / CSV
              </Button>
              <Button
                onClick={() => start.mutate()}
                disabled={start.isPending || live}
                className="btn-gradient"
              >
                {start.isPending || live ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {start.isPending
                  ? "Starting…"
                  : live
                  ? `Running — ${s?.pending ?? 0} pending`
                  : "Start batch"}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  openBatchId
                    ? retry.mutate(openBatchId)
                    : toast.error("Open the batch you want to retry (click its row), then retry it.")
                }
                disabled={retry.isPending}
              >
                {retry.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                Retry failed
              </Button>
              <Button
                variant="outline"
                onClick={() => resume.mutate()}
                disabled={resume.isPending}
              >
                {resume.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                Resume calling
              </Button>
              <Button
                variant="outline"
                onClick={() => cleanup.mutate()}
                disabled={cleanup.isPending}
              >
                {cleanup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hammer className="h-4 w-4" />}
                Cleanup stuck
              </Button>
              <Button
                onClick={() => setConfirmStop(true)}
                disabled={stop.isPending}
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {stop.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                Emergency stop
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { status.refetch(); uploads.refetch(); }}
                className="ml-auto"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", status.isFetching && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Uploads history */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Upload history</CardTitle>
            <CardDescription>
              Last 50 batches · click a row to see its calls
            </CardDescription>
          </CardHeader>
          <CardContent>
            {uploads.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : uploads.error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Couldn&apos;t load uploads: <span className="font-mono">{(uploads.error as Error).message}</span>
              </div>
            ) : (
              <UploadsTable
                uploads={uploads.data?.uploads ?? []}
                onRowClick={(u) => setOpenBatchId(u.id || u._id || null)}
                onStop={(u) => stopBatch.mutate(u.id || u._id || "")}
                stopping={stopBatch.isPending}
                onRetry={(u) => retry.mutate(u.id || u._id || "")}
                retrying={retry.isPending}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-batch detail dialog */}
      <BatchDetailDialog
        batchId={openBatchId}
        open={Boolean(openBatchId)}
        onClose={() => setOpenBatchId(null)}
      />

      {/* Emergency stop confirm */}
      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        size="sm"
        title={
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Emergency stop?
          </div>
        }
        description="PLATFORM-WIDE: this pauses every bank's running batches and kills every active call mid-dial, on every tenant. Customers mid-conversation will be cut off. To stop a single bank, use that bank's own batch screen."
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmStop(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmStop(false);
                stop.mutate();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Square className="h-4 w-4" />
              Stop now
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground/80">
          Use this only if something is going wrong — wrong recipients, bad audio, regulatory issue.
          The pause is reversible via the &quot;Resume calling&quot; button.
        </p>
      </Dialog>
    </AppShell>
  );
}

/* ───────────────────────── Live status banner ────────────────────────── */

function LiveStatusBanner({
  s, loading, live,
}: { s?: BatchStatus; loading: boolean; live: boolean }) {
  if (loading) return <Skeleton className="h-16 w-full rounded-2xl" />;
  if (!s) return null;
  const tone = live ? "info" : s.failed > 0 ? "warning" : "neutral";
  return (
    <div className={cn(
      "flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm",
      tone === "info" && "border-info/40 bg-info/5"
    )}>
      <div className="flex items-center gap-3">
        <span className={cn(
          "grid h-10 w-10 place-items-center rounded-xl ring-1",
          live ? "bg-info/10 text-info ring-info/30" : "bg-muted text-muted-foreground ring-border"
        )}>
          {live ? <Activity className="h-5 w-5 animate-pulse" /> : <CheckCircle2 className="h-5 w-5" />}
        </span>
        <div className="space-y-0.5">
          <div className="text-sm font-semibold text-foreground">
            {live ? "Dispatcher running" : s.is_complete ? "All calls completed" : "Idle"}
          </div>
          <div className="text-xs text-muted-foreground">{s.message}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {live && <Badge variant="info">Live</Badge>}
        {s.failed > 0 && <Badge variant="destructive">{s.failed} failed</Badge>}
      </div>
    </div>
  );
}

/* ───────────────────────── Uploads table ─────────────────────────────── */

function UploadsTable({
  uploads,
  onRowClick,
  onStop,
  stopping,
  onRetry,
  retrying,
}: {
  uploads: Upload[];
  onRowClick: (u: Upload) => void;
  onStop: (u: Upload) => void;
  stopping: boolean;
  onRetry: (u: Upload) => void;
  retrying: boolean;
}) {
  // A batch can be stopped only while it still has work queued/dialing.
  const STOPPABLE = new Set(["running", "paused", "pending"]);
  // A finished batch is where failed calls can be re-queued.
  const RETRIABLE = new Set(["completed", "stopped"]);
  const columns: ReadonlyArray<DataTableColumn<Upload>> = [
    {
      key: "file",
      header: "File",
      render: (u) => (
        <div className="space-y-0.5">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileSpreadsheet className="h-3.5 w-3.5 text-primary" />
            {u.filename || u.file_name || "batch"}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground">{(u.id || u._id || "").slice(0, 8)}</div>
        </div>
      ),
    },
    {
      key: "records",
      header: "Records",
      align: "right",
      render: (u) => (
        <span className="font-mono text-sm font-semibold tabular-nums">
          {(u.total_records ?? u.record_count ?? 0).toLocaleString()}
        </span>
      ),
    },
    {
      key: "config",
      header: "Config",
      render: (u) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {u.language && <Badge variant="secondary" className="capitalize">{u.language}</Badge>}
          {u.agent_voice && <Badge variant="secondary">{u.agent_voice}</Badge>}
          {u.agent_type && <Badge variant="outline" className="capitalize">{u.agent_type.replace(/_/g, " ")}</Badge>}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (u) => <Badge variant={uploadStatusTone(u.status)}>{u.status || "uploaded"}</Badge>,
    },
    {
      key: "when",
      header: "Uploaded",
      align: "right",
      render: (u) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {fmtWhen(u.uploaded_at || u.created_at || "")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (u) => {
        const st = (u.status || "").toLowerCase();
        if (STOPPABLE.has(st)) {
          return (
            <Button
              size="sm"
              variant="outline"
              disabled={stopping}
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={(e) => {
                // Don't let the click bubble to the row (which opens the batch).
                e.stopPropagation();
                if (window.confirm("Stop this batch? In-flight calls end and pending calls are cancelled.")) {
                  onStop(u);
                }
              }}
            >
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleStop className="h-3.5 w-3.5" />}
              Stop
            </Button>
          );
        }
        if (RETRIABLE.has(st)) {
          return (
            <Button
              size="sm"
              variant="outline"
              disabled={retrying}
              onClick={(e) => {
                // Retry THIS batch's failed calls — never a "most recent" guess.
                e.stopPropagation();
                onRetry(u);
              }}
            >
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Retry failed
            </Button>
          );
        }
        return null;
      },
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={uploads}
      rowKey={(u) => u.id || u._id || ""}
      onRowClick={onRowClick}
      empty={
        <div className="grid place-items-center px-6 py-16 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
            <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-3 text-sm font-semibold">No batches uploaded yet</div>
          <div className="mt-1 max-w-sm text-xs text-muted-foreground">
            Use the Upload button above to ship in your first Excel.
          </div>
        </div>
      }
    />
  );
}

/* ───────────────────────── Batch detail dialog ───────────────────────── */

function BatchDetailDialog({
  batchId,
  open,
  onClose,
}: {
  batchId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const q = useQuery<{ calls: BatchCall[]; batch_id: string; total: number }>({
    queryKey: ["batch-detail", batchId],
    enabled: Boolean(batchId && open),
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/agent/upload/${batchId}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });
  const rows = q.data?.calls ?? [];
  const [downloading, setDownloading] = React.useState(false);

  const handleDownload = async () => {
    if (!batchId) return;
    setDownloading(true);
    try {
      const res = await opsFetch(`${API_URL}/api/agent/upload/${batchId}/download`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : `batch_${batchId.slice(0, 8)}_results.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Download failed", e);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={`Batch ${batchId?.slice(0, 8) ?? ""}`}
      description={q.data ? `${q.data.total} call${q.data.total === 1 ? "" : "s"}` : "Loading…"}
    >
      {/* Download button row */}
      {batchId && !q.isLoading && !q.error && (
        <div className="flex justify-end mb-3">
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={downloading}
            className="flex items-center gap-1.5 text-xs h-8">
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {downloading ? "Downloading…" : "Download CSV"}
          </Button>
        </div>
      )}
      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : q.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {(q.error as Error).message}
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <th className="px-3 py-2 text-left">Customer</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Duration</th>
                <th className="px-3 py-2 text-center">Interested</th>
                <th className="px-3 py-2 text-center">Form</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c, i) => (
                <tr key={c.id || `${c.phone}-${i}`}>
                  <td className="px-3 py-2">
                    <div className="text-sm font-medium">{c.customer_name || "Customer"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{maskPhone(c.phone)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {fmtDuration(c.call_duration ?? 0)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {['Calling', 'Pending', 'Connecting'].includes(c.status || '')
                      ? <span className="text-xs text-muted-foreground">—</span>
                      : <span className={cn("inline-block h-2 w-2 rounded-full", c.interested ? "bg-success" : "bg-muted-foreground/30")} />
                    }
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={cn("inline-block h-2 w-2 rounded-full", c.form_sent ? "bg-success" : "bg-muted-foreground/30")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

/* ───────────────────────── Small helpers ─────────────────────────────── */

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
    <label className="block">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * Build a mutationFn that POSTs (no body) to `path`. Optional `getParams` is
 * called at submit time so callers can inject the latest UI state (e.g. the
 * currently-selected phone_number_id) without recreating the mutation when
 * the dropdown changes.
 */
function postJson(
  path: string,
  getParams?: () => Record<string, string> | undefined,
) {
  return async () => {
    const params = getParams?.();
    const url = new URL(`${API_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== "") url.searchParams.set(k, v);
      }
    }
    const res = await opsFetch(url.toString(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    // Backend may return a non-JSON body on hard errors (e.g. HTML 502 from
    // a misconfigured proxy). Detect via content-type so we don't silently
    // swallow the real message under a useless "HTTP 502".
    const ct = res.headers.get("content-type") ?? "";
    let payload: any = {};
    if (ct.includes("application/json")) {
      payload = await res.json().catch(() => ({}));
    } else {
      const txt = await res.text().catch(() => "");
      payload = { detail: txt.slice(0, 200) };
    }
    if (!res.ok) {
      throw new Error(payload.detail || `${res.status} ${res.statusText || "Error"}`);
    }
    return payload;
  };
}

function uploadStatusTone(s?: string): "success" | "warning" | "destructive" | "secondary" | "info" {
  if (!s) return "secondary";
  if (s === "completed") return "success";
  if (s === "running") return "info";
  if (s === "paused") return "warning";
  if (s === "failed") return "destructive";
  return "secondary";
}

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-IN", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch {
    return iso;
  }
}
