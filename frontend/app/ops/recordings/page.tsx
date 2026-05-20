"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Headphones, Mic, MicOff } from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { FilterPills, type FilterOption } from "@/components/ops/FilterPills";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/api";

/* ───────────────────────── Backend shape ─────────────────────────────── */

interface CallRow {
  id: string;
  customer_name: string;
  phone: string;
  status: string;
  call_duration: number | null;
  recording_url: string | null;
  language?: string;
  call_analysis?: { lead_quality?: string } | null;
  started_at?: string;
  created_at?: string;
}

interface CallsListResponse {
  calls?: CallRow[];
  total?: number;
}

type LeadFilter = "all" | "hot" | "warm" | "cold";

export default function OpsRecordingsPage() {
  const [filter, setFilter] = React.useState<LeadFilter>("all");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Use the existing /api/agent/calls endpoint. We over-fetch (no
  // recording_url filter exists yet) and slice client-side — fine at the
  // ~50-row default page size.
  const calls = useQuery<CallsListResponse>({
    queryKey: ["calls-with-recordings", filter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("lead_quality", filter);
      params.set("page", "1");
      const url = `${API_URL}/api/agent/calls?${params.toString()}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const allRows = calls.data?.calls ?? [];
  const withRecordings = React.useMemo(
    () => allRows.filter((c) => !!c.recording_url),
    [allRows]
  );

  const counts = React.useMemo(() => {
    const c = { hot: 0, warm: 0, cold: 0, none: 0 };
    for (const r of allRows) {
      const lq = r.call_analysis?.lead_quality;
      if (lq === "hot") c.hot += 1;
      else if (lq === "warm") c.warm += 1;
      else if (lq === "cold") c.cold += 1;
      else c.none += 1;
    }
    return c;
  }, [allRows]);

  const filterOptions: ReadonlyArray<FilterOption<LeadFilter>> = [
    { value: "all", label: "All" },
    { value: "hot", label: "Hot" },
    { value: "warm", label: "Warm" },
    { value: "cold", label: "Cold" },
  ];
  const filterCounts: Partial<Record<LeadFilter, number>> = {
    all: allRows.length,
    hot: counts.hot,
    warm: counts.warm,
    cold: counts.cold,
  };

  return (
    <AppShell
      title="Recordings"
      subtitle={`${withRecordings.length} call${withRecordings.length === 1 ? "" : "s"} with a recording · expand a row to listen`}
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="WITH RECORDING"
            value={withRecordings.length}
            icon={Headphones}
            tone="info"
          />
          <StatCard label="HOT LEADS" value={counts.hot} icon={Mic} tone="danger" />
          <StatCard label="WARM" value={counts.warm} icon={Mic} tone="warning" />
          <StatCard
            label="WITHOUT AUDIO"
            value={allRows.length - withRecordings.length}
            icon={MicOff}
            tone="neutral"
          />
        </div>

        <FilterPills
          options={filterOptions}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setExpandedId(null);
          }}
          counts={filterCounts}
        />

        {/* Table */}
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          {calls.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : calls.error ? (
            <div className="px-5 py-4 text-sm text-destructive">
              Couldn&apos;t load recordings: {(calls.error as Error).message}
            </div>
          ) : withRecordings.length === 0 ? (
            <div className="grid place-items-center px-6 py-16 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
                <MicOff className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="mt-3 text-sm font-semibold">No recordings yet</div>
              <div className="mt-1 max-w-sm text-xs text-muted-foreground">
                Recordings appear here once LiveKit egress writes them to{" "}
                <span className="font-mono">/recordings/*.ogg</span> and the
                webhook updates the call row.
              </div>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <Th>Customer</Th>
                  <Th>Status</Th>
                  <Th>Lead</Th>
                  <Th align="right">Duration</Th>
                  <Th align="right">When</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {withRecordings.map((r) => {
                  const expanded = expandedId === r.id;
                  const lq = r.call_analysis?.lead_quality ?? "—";
                  const dur = r.call_duration ?? 0;
                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        className="cursor-pointer transition-colors hover:bg-muted/40"
                        onClick={() => setExpandedId(expanded ? null : r.id)}
                      >
                        <td className="px-5 py-4">
                          <div className="space-y-0.5">
                            <div className="text-sm font-semibold text-foreground">
                              {r.customer_name || "Customer"}
                            </div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {maskPhone(r.phone)}
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                        </td>
                        <td className="px-5 py-4">
                          <LeadBadge quality={lq} />
                        </td>
                        <td className="px-5 py-4 text-right font-mono text-xs tabular-nums">
                          {fmtDuration(dur)}
                        </td>
                        <td className="px-5 py-4 text-right text-xs text-muted-foreground">
                          {r.started_at || r.created_at || "—"}
                        </td>
                        <td className="pr-4 text-muted-foreground/70">
                          {expanded ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                        </td>
                      </tr>
                      {expanded && r.recording_url && (
                        <tr className="bg-muted/20">
                          <td colSpan={6} className="px-5 py-5">
                            <div className="space-y-2">
                              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                Audio
                              </div>
                              <audio
                                controls
                                preload="metadata"
                                src={r.recording_url}
                                className="h-10 w-full max-w-2xl"
                              />
                              <div className="text-[10px] text-muted-foreground">
                                <span className="font-mono">{r.recording_url}</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  );
}

/* ───────────────────────── Helpers ───────────────────────────────────── */

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "px-5 py-3 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      {children}
    </th>
  );
}

function statusVariant(s: string): "success" | "warning" | "destructive" | "secondary" | "info" {
  if (s?.startsWith("Called") && s.includes("Interested")) return "success";
  if (s?.startsWith("Called")) return "info";
  if (s === "Failed" || s === "Invalid Phone") return "destructive";
  if (s === "Pending" || s === "Scheduled") return "secondary";
  return "warning";
}

function LeadBadge({ quality }: { quality: string }) {
  if (quality === "hot") return <Badge variant="destructive">Hot</Badge>;
  if (quality === "warm") return <Badge variant="warning">Warm</Badge>;
  if (quality === "cold") return <Badge variant="secondary">Cold</Badge>;
  return <span className="text-xs text-muted-foreground">—</span>;
}

function maskPhone(p: string): string {
  if (!p) return "";
  const digits = p.replace(/\D/g, "");
  if (digits.length < 5) return p;
  return `+91-XXXXX${digits.slice(-2)}`;
}

function fmtDuration(sec: number): string {
  if (!sec || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
