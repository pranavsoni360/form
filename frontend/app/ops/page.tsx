"use client";

import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  Building2,
  CircleDot,
  Clock,
  Database,
  Flame,
  PhoneCall,
  PlusCircle,
  Radio,
  Sparkles,
  Users,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * /ops — Overview dashboard.
 *
 * Visual language matches the VirtualVaani Admin Portal screenshots: white
 * cards on a cream dot-grid canvas, dark-navy CTAs, soft pastel icon badges,
 * generous spacing. Phase 1 already wires real SSE; this page renders the
 * KPI grid + sections + design reference using fake placeholder values
 * until /api/agent/dashboard-stats + the SSE reducers are hooked into the
 * overview (Chunk E).
 */
export default function OpsOverviewPage() {
  return (
    <AppShell
      title="Operations dashboard"
      subtitle="Live calls, queue depth, worker health, and recent errors"
    >
      <div className="space-y-7">
        <HeaderActions />
        <KpiGrid />
        <ActiveCallsCard />
        <DesignReference />
      </div>
    </AppShell>
  );
}

/* ────────────────────────────── Header actions ─────────────────────────── */

function HeaderActions() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <StatusPill tone="success" label="Backend healthy" />
        <StatusPill tone="info" label="SSE · 0 listeners" dot={false} />
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/bank/batch"
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Building2 className="h-4 w-4" />
          Batch upload
        </Link>
        <Link href="/ops/live" className="btn-solid">
          <PlusCircle className="h-4 w-4" />
          Start a batch
        </Link>
      </div>
    </div>
  );
}

/* ─────────────────────────────── KPI grid ──────────────────────────────── */

const KPI_DATA = [
  {
    label: "Calls today",
    value: "0",
    delta: "—",
    icon: PhoneCall,
    tone: "info" as const,
    sub: "0 hot leads · 0 forms sent",
  },
  {
    label: "Active calls",
    value: "0",
    delta: "live",
    icon: CircleDot,
    tone: "success" as const,
    sub: "of 5 trunk capacity",
  },
  {
    label: "Queue depth",
    value: "0",
    delta: "—",
    icon: Activity,
    tone: "warning" as const,
    sub: "transcript_analyze jobs",
  },
  {
    label: "Error rate (5m)",
    value: "0.0%",
    delta: "—",
    icon: Flame,
    tone: "danger" as const,
    sub: "0 of 0 requests",
  },
  {
    label: "DB pool",
    value: "0 / 40",
    delta: "healthy",
    icon: Database,
    tone: "info" as const,
    sub: "min 10 · max 40",
  },
  {
    label: "Workers alive",
    value: "4 / 4",
    delta: "healthy",
    icon: Users,
    tone: "success" as const,
    sub: "4 job workers · 1 dispatcher",
  },
] as const;

function KpiGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {KPI_DATA.map((kpi) => (
        <KpiCard key={kpi.label} {...kpi} />
      ))}
    </div>
  );
}

const TONE_STYLES = {
  info:    "bg-info/10 text-info ring-info/20",
  success: "bg-success/10 text-success ring-success/25",
  warning: "bg-warning/15 text-[hsl(var(--warning))] ring-warning/25",
  danger:  "bg-destructive/10 text-destructive ring-destructive/20",
} as const;

function KpiCard({
  label,
  value,
  delta,
  icon: Icon,
  tone,
  sub,
}: {
  label: string;
  value: string;
  delta: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: keyof typeof TONE_STYLES;
  sub: string;
}) {
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <CardDescription className="text-[11px] font-medium uppercase tracking-[0.14em]">
            {label}
          </CardDescription>
          <span className={cn("badge-icon", TONE_STYLES[tone])}>
            <Icon className="h-4 w-4" />
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5 pt-0">
        <div className="font-mono text-3xl font-bold tracking-tight text-foreground">
          {value}
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">{sub}</span>
          <span
            className={cn(
              "font-mono",
              tone === "success" && "text-success",
              tone === "warning" && "text-[hsl(var(--warning))]",
              tone === "danger" && "text-destructive",
              tone === "info" && "text-muted-foreground"
            )}
          >
            {delta}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/* ──────────────────────── Active calls (preview) ───────────────────────── */

function ActiveCallsCard() {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-4">
        <div className="space-y-1">
          <CardTitle className="text-lg">Live call monitor</CardTitle>
          <CardDescription>
            Cards appear the moment the dispatcher picks a call up. Hop to{" "}
            <Link href="/ops/live" className="font-medium text-primary hover:underline">
              /ops/live
            </Link>{" "}
            for the full grid.
          </CardDescription>
        </div>
        <Badge variant="secondary" className="font-mono text-[10px] uppercase">
          0 active
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="grid place-items-center rounded-xl border border-dashed border-border bg-muted/30 px-6 py-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-card shadow-sm">
            <Radio className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-3 text-sm font-semibold">No active calls right now</div>
          <div className="mt-1 max-w-sm text-xs text-muted-foreground">
            Upload a CSV from{" "}
            <Link href="/bank/batch" className="font-medium text-primary hover:underline">
              Batch
            </Link>{" "}
            or start a single call — the dispatcher will pick it up within seconds and
            cards will appear live here.
          </div>
          <Link
            href="/bank/batch"
            className="btn-gradient mt-5"
          >
            <PlusCircle className="h-4 w-4" />
            Upload a batch
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── Design reference ──────────────────────────── */

function DesignReference() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2.5">
          <span className="badge-icon bg-primary/10 text-primary ring-primary/20">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <CardTitle className="text-base">Design language</CardTitle>
            <CardDescription className="text-xs">
              VirtualVaani aesthetic · cream + dark navy + admin purple
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Status pills */}
        <div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Status pills
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="success" label="Connected" />
            <StatusPill tone="info" label="Dialing" />
            <StatusPill tone="warning" label="Cooldown 2m 14s" />
            <StatusPill tone="danger" label="Circuit open" />
            <StatusPill tone="neutral" label="Pending" />
            <StatusPill tone="success" label="Healthy" dot={false} />
          </div>
        </div>

        <Separator />

        {/* Buttons */}
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              CTAs (admin chrome)
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-solid">
                <PlusCircle className="h-4 w-4" />
                Dark navy
              </button>
              <button className="btn-gradient">
                <PlusCircle className="h-4 w-4" />
                Blue gradient
              </button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
            </div>
          </div>

          <div>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Badges
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="default">Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="success">Success</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="info">Info</Badge>
              <Badge variant="outline">Outline</Badge>
            </div>
          </div>
        </div>

        <Separator />

        {/* Typography */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Heading
            </div>
            <div className="text-2xl font-bold tracking-tight">
              Loan Origination System
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              Reviews loan applications efficiently with AI-assisted pipelines.
            </div>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Mono · data
            </div>
            <div className="space-y-1 font-mono text-sm">
              <div>+91-XXXXX98765</div>
              <div className="text-muted-foreground">0:42 · 1,247 calls</div>
              <div className="text-3xl font-bold text-foreground">5000</div>
            </div>
          </div>
        </div>

        <Separator />

        {/* Phase banner */}
        <Link
          href="/ops/live"
          className="flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 transition-colors hover:bg-primary/10"
        >
          <div className="flex items-center gap-3">
            <span className="badge-icon bg-primary/15 text-primary ring-primary/30">
              <ArrowUpRight className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold">View live calls</div>
              <div className="text-xs text-muted-foreground">
                Real-time SSE — cards appear in &lt;200ms after dispatch
              </div>
            </div>
          </div>
          <Clock className="h-4 w-4 text-muted-foreground" />
        </Link>
      </CardContent>
    </Card>
  );
}
