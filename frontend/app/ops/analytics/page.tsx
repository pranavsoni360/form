"use client";

/**
 * /ops/analytics — performance + lead-quality + loan-type breakdown.
 *
 * Mirrors the old /agent "Analytics" tab (lines 1402–1467 of
 * agent-dashboard.html). Backend: GET /api/agent/analytics → flat object.
 *
 *   { total_calls_made, forms_sent, interested_customers,
 *     success_rate, failure_rate,            // these are COUNTS, not pct
 *     lead_quality: { hot, warm, cold },
 *     loan_types: { education, business, personal } }
 *
 * The pct cards compute percentage client-side from the counts.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Briefcase,
  CheckCircle2,
  Flame,
  GraduationCap,
  Heart,
  PhoneCall,
  Send,
  TrendingDown,
  TrendingUp,
  User,
  XCircle,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard, type StatTone } from "@/components/ops/StatCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/api";

interface AnalyticsResponse {
  total_calls_made: number;
  forms_sent: number;
  interested_customers: number;
  success_rate: number;   // count of successful outcomes
  failure_rate: number;   // count of failed outcomes
  lead_quality: { hot: number; warm: number; cold: number };
  loan_types: { education: number; business: number; personal: number };
}

export default function OpsAnalyticsPage() {
  const query = useQuery<AnalyticsResponse>({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/agent/analytics`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const a = query.data;
  const total = a?.total_calls_made ?? 0;
  const successCount = a?.success_rate ?? 0;
  const failureCount = a?.failure_rate ?? 0;
  const successPct = pct(successCount, total);
  const failurePct = pct(failureCount, total);
  const interestedPct = pct(a?.interested_customers ?? 0, total);
  const formsPct = pct(a?.forms_sent ?? 0, total);

  const lq = a?.lead_quality;
  const lt = a?.loan_types;

  if (query.isLoading) {
    return (
      <AppShell title="Analytics" subtitle="Loading…">
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      </AppShell>
    );
  }

  if (query.error || !a) {
    return (
      <AppShell title="Analytics" subtitle="Couldn't load">
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          {(query.error as Error)?.message || "No data returned."}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Analytics"
      subtitle={`${total.toLocaleString()} total call${total === 1 ? "" : "s"} across all batches · 60s auto-refresh`}
    >
      <div className="space-y-7">
        {/* Top KPI strip — counts */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="TOTAL CALLS"
            value={total}
            icon={PhoneCall}
            tone="info"
            hint="all-time"
          />
          <StatCard
            label="FORMS SENT"
            value={a.forms_sent}
            icon={Send}
            tone="info"
            hint={`${formsPct}% conversion`}
          />
          <StatCard
            label="INTERESTED"
            value={a.interested_customers}
            icon={Heart}
            tone="warning"
            hint={`${interestedPct}% of total`}
          />
          <StatCard
            label="SUCCESS RATE"
            value={`${successPct}%`}
            icon={TrendingUp}
            tone="success"
            hint={`${successCount.toLocaleString()} answered`}
          />
        </div>

        {/* Outcome card — visual success vs failure */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Call outcome</CardTitle>
            <CardDescription>
              {successCount} successful · {failureCount} failed · {total - successCount - failureCount} other
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <OutcomeBar
              label="Success"
              count={successCount}
              total={total}
              tone="success"
              icon={CheckCircle2}
            />
            <OutcomeBar
              label="Failed / no answer"
              count={failureCount}
              total={total}
              tone="danger"
              icon={XCircle}
            />
          </CardContent>
        </Card>

        {/* Two-column: Lead quality + Loan types */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Lead quality */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Lead quality</CardTitle>
              <CardDescription>
                Hot {lq?.hot ?? 0} · Warm {lq?.warm ?? 0} · Cold {lq?.cold ?? 0}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <LeadRow label="Hot" count={lq?.hot ?? 0} total={total} tone="danger" icon={Flame} />
              <LeadRow label="Warm" count={lq?.warm ?? 0} total={total} tone="warning" icon={Heart} />
              <LeadRow label="Cold" count={lq?.cold ?? 0} total={total} tone="neutral" icon={Heart} />
            </CardContent>
          </Card>

          {/* Loan type breakdown */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Loan type interest</CardTitle>
              <CardDescription>
                Customers who showed interest by category
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <LoanRow label="Education" count={lt?.education ?? 0} total={total} icon={GraduationCap} />
              <LoanRow label="Business" count={lt?.business ?? 0} total={total} icon={Briefcase} />
              <LoanRow label="Personal" count={lt?.personal ?? 0} total={total} icon={User} />
            </CardContent>
          </Card>
        </div>

        {/* Footer summary */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Performance summary</CardTitle>
            <CardDescription>Where things stand right now</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Summary
              icon={TrendingUp}
              tone="success"
              label="Of every 100 calls we answer, "
              value={`${successPct} reach a real conversation`}
            />
            <Summary
              icon={Send}
              tone="info"
              label="Of every 100 total calls, "
              value={`${formsPct} convert to a WhatsApp form delivery`}
            />
            <Summary
              icon={Heart}
              tone="warning"
              label="Of every 100 total calls, "
              value={`${interestedPct} flag the customer as interested`}
            />
            <Summary
              icon={TrendingDown}
              tone="danger"
              label="Failure / no-answer rate is "
              value={`${failurePct}%`}
            />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

/* ───────────────────────── Subcomponents ─────────────────────────────── */

function OutcomeBar({
  label,
  count,
  total,
  tone,
  icon: Icon,
}: {
  label: string;
  count: number;
  total: number;
  tone: "success" | "danger";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const p = pct(count, total);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="inline-flex items-center gap-2 font-medium text-foreground">
          <Icon className={cn("h-3.5 w-3.5", tone === "success" ? "text-success" : "text-destructive")} />
          {label}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {count.toLocaleString()} · {p}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className={cn(
            "h-full transition-all",
            tone === "success" ? "bg-success" : "bg-destructive"
          )}
          style={{ width: `${Math.min(100, Math.max(1, p))}%` }}
        />
      </div>
    </div>
  );
}

function LeadRow({
  label,
  count,
  total,
  tone,
  icon: Icon,
}: {
  label: string;
  count: number;
  total: number;
  tone: "danger" | "warning" | "neutral";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const p = pct(count, total);
  const bar =
    tone === "danger"
      ? "bg-destructive"
      : tone === "warning"
      ? "bg-[hsl(var(--warning))]"
      : "bg-muted-foreground/40";
  const ring =
    tone === "danger"
      ? "bg-destructive/10 text-destructive"
      : tone === "warning"
      ? "bg-warning/10 text-[hsl(var(--warning))]"
      : "bg-muted text-muted-foreground";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="inline-flex items-center gap-2">
          <span className={cn("badge-icon ring-1 ring-border", ring)}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="font-medium text-foreground">{label}</span>
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {count.toLocaleString()} · {p}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
        <div className={cn("h-full transition-all", bar)} style={{ width: `${Math.min(100, Math.max(1, p))}%` }} />
      </div>
    </div>
  );
}

function LoanRow({
  label,
  count,
  total,
  icon: Icon,
}: {
  label: string;
  count: number;
  total: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const p = pct(count, total);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="inline-flex items-center gap-2 text-foreground">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {label}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {count.toLocaleString()} · {p}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
        <div className="h-full bg-primary/70 transition-all" style={{ width: `${Math.min(100, Math.max(1, p))}%` }} />
      </div>
    </div>
  );
}

function Summary({
  icon: Icon,
  tone,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: StatTone;
  label: string;
  value: string;
}) {
  const dot =
    tone === "success" ? "bg-success" :
    tone === "info" ? "bg-info" :
    tone === "warning" ? "bg-[hsl(var(--warning))]" :
    tone === "danger" ? "bg-destructive" : "bg-muted-foreground";
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("mt-1.5 inline-block h-2 w-2 rounded-full", dot)} />
      <span className="text-foreground/80">
        {label}<span className="font-semibold text-foreground">{value}</span>.
      </span>
    </div>
  );
}

function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}
