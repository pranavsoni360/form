"use client";

import {
  Activity,
  ArrowUpRight,
  CircleDot,
  Clock,
  Database,
  Flame,
  PhoneCall,
  Server,
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
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * PHASE 0 — Design system showcase.
 *
 * Once the look is approved, Phase 1 replaces this body with the real
 * Overview dashboard (live KPIs from the backend + Tremor charts +
 * SSE-driven active-calls list).
 *
 * Everything below renders with FAKE data so you can review the visual
 * language end-to-end.
 */
export default function OpsOverviewPage() {
  return (
    <AppShell
      title="Overview"
      subtitle="System health · today's calling activity · alerts"
    >
      <div className="mx-auto max-w-7xl space-y-8">
        <PhaseBanner />
        <KpiGrid />
        <SectionDivider title="Active calls" hint="Live preview · Phase 1 will wire SSE" />
        <ActiveCallsPreview />
        <SectionDivider title="Design language reference" hint="All primitives in one place" />
        <DesignReference />
      </div>
    </AppShell>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function PhaseBanner() {
  return (
    <div className="flex items-center justify-between rounded-xl border border-primary/30 bg-gradient-to-r from-primary/10 to-transparent px-5 py-3.5">
      <div className="flex items-center gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/20 ring-1 ring-primary/40">
          <Sparkles className="h-4 w-4 text-primary" />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Phase 0 — Foundation</div>
          <div className="text-xs text-muted-foreground">
            shadcn/ui + Tremor + Geist font + Retell-style dark theme. Approve this look
            to unlock Phase 1 (live SSE dashboards).
          </div>
        </div>
      </div>
      <Button variant="outline" size="sm" className="border-primary/40 text-primary hover:bg-primary/10">
        View plan
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function SectionDivider({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-end justify-between">
      <div className="space-y-0.5">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        {hint && <div className="text-[11px] text-muted-foreground/70">{hint}</div>}
      </div>
      <Separator className="ml-4 flex-1" />
    </div>
  );
}

/* ──────────────────────────── KPI Grid ──────────────────────────── */

const KPI_DATA = [
  {
    label: "Calls today",
    value: "0",
    delta: "—",
    icon: PhoneCall,
    tone: "default" as const,
    sub: "0 hot leads",
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
    tone: "default" as const,
    sub: "transcript_analyze jobs",
  },
  {
    label: "Error rate (5m)",
    value: "0.0%",
    delta: "—",
    icon: Flame,
    tone: "default" as const,
    sub: "0 of 0 requests",
  },
  {
    label: "DB pool",
    value: "0 / 40",
    delta: "—",
    icon: Database,
    tone: "default" as const,
    sub: "min 10 · max 40",
  },
  {
    label: "Workers",
    value: "4 / 4",
    delta: "healthy",
    icon: Users,
    tone: "success" as const,
    sub: "4 job · 1 dispatcher",
  },
];

function KpiGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {KPI_DATA.map((kpi) => (
        <KpiCard key={kpi.label} {...kpi} />
      ))}
    </div>
  );
}

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
  tone: "default" | "success" | "warning" | "danger";
  sub: string;
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardDescription className="text-[11px] uppercase tracking-wider">
            {label}
          </CardDescription>
          <span
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md ring-1",
              tone === "success" && "bg-success/10 text-success ring-success/30",
              tone === "warning" && "bg-warning/10 text-warning ring-warning/30",
              tone === "danger" && "bg-destructive/10 text-destructive ring-destructive/30",
              tone === "default" && "bg-muted/40 text-muted-foreground ring-border"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="font-mono text-kpi text-foreground">{value}</div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">{sub}</span>
          <span
            className={cn(
              "font-mono",
              tone === "success" && "text-success",
              tone === "warning" && "text-warning",
              tone === "danger" && "text-destructive",
              tone === "default" && "text-muted-foreground"
            )}
          >
            {delta}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────── Active calls preview ──────────────────────────── */

function ActiveCallsPreview() {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-4">
        <div>
          <CardTitle>Live call monitor</CardTitle>
          <CardDescription>0 calls in-flight · refreshes via SSE (Phase 1)</CardDescription>
        </div>
        <StatusPill tone="neutral" label="Idle" />
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* Placeholder cards — Phase 1 replaces with <LiveCallCard /> driven by SSE */}
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-dashed border-border/60 bg-card/40 p-4"
            >
              <Skeleton className="mb-2 h-3 w-24" />
              <Skeleton className="mb-3 h-5 w-40" />
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="mt-3 flex h-12 items-end gap-1">
                {Array.from({ length: 16 }).map((_, j) => (
                  <Skeleton
                    key={j}
                    className="w-1.5"
                    style={{ height: `${20 + ((i * 13 + j * 7) % 32)}px` }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-center rounded-md border border-dashed border-border/40 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          <Clock className="mr-2 h-3.5 w-3.5" />
          Phase 1 wires this section to the real-time SSE stream.
        </div>
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────── Design reference ──────────────────────────── */

function DesignReference() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Status pills</CardTitle>
          <CardDescription>Used for call state, worker health, batch status</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <StatusPill tone="success" label="Connected" />
          <StatusPill tone="info" label="Dialing" />
          <StatusPill tone="warning" label="Cooldown 2m 14s" />
          <StatusPill tone="danger" label="Circuit open" />
          <StatusPill tone="neutral" label="Pending" />
          <StatusPill tone="success" label="Healthy" dot={false} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Badges & buttons</CardTitle>
          <CardDescription>shadcn primitives wired to Retell tokens</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant="default">Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="outline">Outline</Badge>
          </div>
          <Separator />
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Stop calling</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="More">
              <Server className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Typography</CardTitle>
          <CardDescription>Geist Sans for UI · Geist Mono for data</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-baseline gap-6">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Sans</span>
            <span className="text-3xl font-semibold tracking-tight">Loan Origination System</span>
          </div>
          <div className="flex items-baseline gap-6">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Mono</span>
            <span className="font-mono text-2xl">+91-XXXXX98765 · 0:42 · 1,247 calls</span>
          </div>
          <div className="flex items-baseline gap-6">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">KPI</span>
            <span className="font-mono text-kpi text-foreground">5000</span>
            <span className="text-sm text-muted-foreground">calls / day target</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
