"use client";

/**
 * CallDetailDialog — single source of truth for "show me everything about
 * one call" across /ops/calls, /ops/recordings, /ops/callbacks, etc.
 *
 * Mirrors the modal that the old /agent dashboard opened on row-click
 * (lines 1652–1710 of agent-dashboard.html) — same data, new visual
 * language. Three regions:
 *   1. Header chips: status / lead quality / interested / form-sent
 *   2. Collected form data: loan_amount, monthly_income, employer, etc.
 *   3. Inline audio player + transcript view
 *
 * Data: GET /api/agent/call/{id} returns the full row (including transcript
 * + recording_url). Backend's _serialize_call already flattens both
 * MongoDB-style (`_id`, `name`) and Postgres-style (`id`, `customer_name`)
 * aliases, so we can use either.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  Headphones,
  MessageSquare,
  Phone,
  User,
  XCircle,
} from "lucide-react";

import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ───────────────────────── Backend response shape ────────────────────── */

interface TranscriptTurn {
  role: "agent" | "customer" | string;
  text: string;
  /** Unix epoch seconds (float). Preferred — backend sends this on new calls. */
  ts?: string | number;
  /** Pre-formatted IST clock string (e.g. "15:32:45"). Sent alongside `ts`
   *  on new calls; on legacy calls this may be the old human-readable
   *  "May 22, 2026 03:19 PM" format — `fmtTurnTime` handles both. */
  timestamp?: string;
}

interface CallDetail {
  // Identity
  id?: string;
  _id?: string;
  customer_name?: string;
  name?: string;
  phone?: string;
  language?: string;

  // Status
  status?: string;
  call_status?: string;
  category?: string;

  // Outcome
  interested?: boolean;
  customer_interested?: boolean;
  form_sent?: boolean;
  whatsapp_form_sent?: boolean;
  form_submitted?: boolean;
  follow_up_needed?: boolean;
  success?: boolean;

  // Lead quality (flattened from call_analysis)
  lead_quality?: string;

  // Form / links
  form_url?: string;
  form_link?: string;
  notification_message?: string;

  // Loan data
  loan_type?: string;
  loan_type_interested?: string;
  loan_amount?: string | number;
  loan_amount_requested?: string | number;
  loan_purpose?: string;
  monthly_income?: string | number;
  employment_type?: string;
  employer_name?: string;
  is_salaried?: string;
  individual_purpose?: string;
  aadhar_number?: string;
  pan_number?: string;

  // Audio + transcript
  recording_url?: string | null;
  transcript?: TranscriptTurn[] | string;

  // Timing
  call_duration?: number;
  call_duration_seconds?: number;
  started_at?: string;
  ended_at?: string;
  created_at?: string;
  retry_count?: number;
}

/* ───────────────────────────── Component ─────────────────────────────── */

export function CallDetailDialog({
  callId,
  open,
  onClose,
}: {
  callId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const query = useQuery<CallDetail>({
    queryKey: ["call-detail", callId],
    queryFn: async () => {
      if (!callId) throw new Error("no callId");
      // /call/{id} (alias) is unauthenticated; same endpoint the old /agent
      // hits. /calls/{id} works too but goes through the auth dependency.
      const res = await fetch(`${API_URL}/api/agent/call/${callId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: Boolean(callId && open),
    staleTime: 30_000,
  });

  const data = query.data;
  const name = data?.customer_name || data?.name || "—";
  const phone = data?.phone || "—";
  const status = data?.status || data?.call_status || "Unknown";
  const leadQuality = data?.lead_quality;
  const interested = data?.customer_interested ?? data?.interested;
  const formSent = data?.whatsapp_form_sent ?? data?.form_sent;
  const formUrl = data?.form_url || data?.form_link || "";
  const recordingUrl = data?.recording_url || null;

  // Transcript may arrive as JSON string from the alias endpoint; parse it.
  const transcript: TranscriptTurn[] = React.useMemo(() => {
    const t = data?.transcript;
    if (!t) return [];
    if (typeof t === "string") {
      try { return JSON.parse(t); } catch { return []; }
    }
    return t;
  }, [data?.transcript]);

  const duration = data?.call_duration_seconds ?? data?.call_duration ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <div className="flex items-center gap-2">
          <span className="badge-icon bg-primary/10 text-primary ring-primary/20">
            <User className="h-4 w-4" />
          </span>
          <span>{name}</span>
        </div>
      }
      description={
        <span className="font-mono">{maskPhone(phone)} · call {callId?.slice(0, 8) ?? ""}</span>
      }
    >
      {query.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Couldn&apos;t load this call: <span className="font-mono">{(query.error as Error).message}</span>
        </div>
      ) : !data ? null : (
        <div className="space-y-5">
          {/* Status chips */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(status)}>{status}</Badge>
            {leadQuality && <LeadBadge q={leadQuality} />}
            <BoolPill label="Interested" yes={interested} />
            <BoolPill label="Form sent" yes={formSent} />
            {data.follow_up_needed && (
              <Badge variant="warning">Follow up</Badge>
            )}
          </div>

          {/* Quick facts grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="Duration" value={fmtDuration(Number(duration) || 0)} />
            <Fact label="Loan type" value={data.loan_type || data.loan_type_interested || "—"} />
            <Fact
              label="Amount"
              value={
                data.loan_amount || data.loan_amount_requested
                  ? `₹ ${(data.loan_amount ?? data.loan_amount_requested)?.toLocaleString?.() ?? data.loan_amount}`
                  : "—"
              }
            />
            <Fact label="Language" value={data.language || "—"} />
          </div>

          {/* Form data card */}
          {(data.monthly_income || data.employer_name || data.loan_purpose ||
            data.is_salaried || data.individual_purpose) && (
            <Section title="Collected information" icon={FileText}>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                {data.is_salaried && (
                  <FactSmall
                    label="Salaried employee"
                    value={/^y/i.test(String(data.is_salaried)) ? 'Yes' : 'No'}
                  />
                )}
                {data.individual_purpose && (
                  <FactSmall
                    label="Individual purpose"
                    value={/^y/i.test(String(data.individual_purpose)) ? 'Yes' : 'No'}
                  />
                )}
                {data.monthly_income && (
                  <FactSmall label="Monthly income" value={`₹ ${data.monthly_income}`} />
                )}
                {data.employment_type && (
                  <FactSmall label="Employment" value={data.employment_type} />
                )}
                {data.employer_name && (
                  <FactSmall label="Employer" value={data.employer_name} />
                )}
                {data.loan_purpose && (
                  <FactSmall label="Purpose" value={data.loan_purpose} />
                )}
              </div>
            </Section>
          )}

          {/* Notification message — surfaced by the agent when it sent the
              WhatsApp form (or any other side-effect-y action). Legacy
              dashboard showed this on the modal; preserving parity. */}
          {data.notification_message ? (
            <Section title="Agent notification" icon={MessageSquare}>
              <div className="rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-sm text-foreground">
                {data.notification_message}
              </div>
            </Section>
          ) : null}

          {/* Recording */}
          {recordingUrl ? (
            <Section title="Recording" icon={Headphones}>
              <audio
                controls
                preload="metadata"
                src={recordingUrl}
                className="h-10 w-full max-w-2xl"
              />
              <div className="mt-1 break-all text-[10px] font-mono text-muted-foreground">
                {recordingUrl}
              </div>
            </Section>
          ) : null}

          {/* Transcript */}
          <Section
            title={`Transcript ${transcript.length ? `· ${transcript.length} turns` : ""}`}
            icon={MessageSquare}
          >
            {transcript.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                No transcript available for this call.
              </div>
            ) : (
              <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3">
                {transcript.map((turn, i) => (
                  <div
                    key={i}
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm",
                      turn.role === "agent"
                        ? "bg-primary/10 text-foreground"
                        : "bg-card text-foreground border border-border"
                    )}
                  >
                    <div className="mb-0.5 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {turn.role === "agent" ? "Agent" : "Customer"}
                      </span>
                      {(() => {
                        const stamp = fmtTurnTime(turn.ts, turn.timestamp);
                        return stamp ? (
                          <span
                            className="font-mono text-[10px] tabular-nums text-muted-foreground/70"
                            title="Time of utterance (IST)"
                          >
                            {stamp}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    <div className="whitespace-pre-wrap leading-relaxed">{turn.text}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Actions */}
          <Separator />
          <div className="flex flex-wrap items-center gap-2">
            {formUrl ? (
              <a
                href={formUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-solid"
              >
                <ExternalLink className="h-4 w-4" />
                Open WhatsApp form
              </a>
            ) : (
              <Badge variant="outline">No form link</Badge>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground font-mono">
              {data.created_at ?? ""}
            </span>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/* ───────────────────────────── Helpers ───────────────────────────────── */

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        <Icon className="h-3 w-3" />
        {title}
      </div>
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function FactSmall({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm text-foreground">{value}</div>
    </div>
  );
}

function BoolPill({ label, yes }: { label: string; yes?: boolean }) {
  if (yes === undefined) return null;
  return (
    <Badge variant={yes ? "success" : "secondary"} className="gap-1">
      {yes ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

function LeadBadge({ q }: { q: string }) {
  if (q === "hot") return <Badge variant="destructive">Hot lead</Badge>;
  if (q === "warm") return <Badge variant="warning">Warm</Badge>;
  if (q === "cold") return <Badge variant="secondary">Cold</Badge>;
  return <Badge variant="outline">{q}</Badge>;
}

export function statusVariant(
  s: string,
): "success" | "warning" | "destructive" | "secondary" | "info" | "callback" {
  if (!s) return "secondary";
  if (s === "Called - Callback Requested") return "callback";
  if (s.startsWith("Called") && s.includes("Interested")) return "success";
  if (s.startsWith("Called")) return "info";
  if (s === "Failed" || s === "Invalid Phone") return "destructive";
  if (s === "Pending" || s === "Scheduled") return "secondary";
  return "warning";
}

export function maskPhone(p: string): string {
  if (!p) return "—";
  const digits = p.replace(/\D/g, "");
  if (digits.length < 5) return p;
  return `+91-XXXXX${digits.slice(-2)}`;
}

/**
 * Format a per-turn timestamp as `HH:MM:SS` in IST.
 *
 * Tolerates three shapes the backend has historically produced:
 *   1. `ts` as Unix epoch seconds (float)   — current agent output
 *   2. `timestamp` already `HH:MM:SS`       — current agent output (pass-through)
 *   3. `timestamp` as a parseable date str  — legacy "May 22, 2026 03:19 PM" rows
 *
 * Returns "" when nothing usable is found, so the UI can omit the label.
 */
export function fmtTurnTime(
  ts: string | number | undefined,
  fallback?: string,
): string {
  const fromDate = (d: Date) =>
    Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

  // 1) Unix epoch (preferred on new calls).
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // Tolerate both seconds (1.7e9 today) and milliseconds (1.7e12 today).
    const ms = ts > 1e12 ? ts : ts * 1000;
    return fromDate(new Date(ms));
  }
  // 2) `ts` came as a string — could be ISO or already-formatted HH:MM:SS.
  if (typeof ts === "string" && ts) {
    if (/^\d{2}:\d{2}:\d{2}$/.test(ts)) return ts;
    return fromDate(new Date(ts));
  }
  // 3) Fall back to `timestamp` field (legacy or current agent's HH:MM:SS).
  if (fallback) {
    if (/^\d{2}:\d{2}:\d{2}$/.test(fallback)) return fallback;
    const parsed = fromDate(new Date(fallback));
    return parsed || fallback; // last resort: show the raw string
  }
  return "";
}

export function fmtDuration(sec: number): string {
  if (!sec || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
