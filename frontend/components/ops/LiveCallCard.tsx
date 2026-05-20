"use client";

import * as React from "react";
import { PhoneCall, CheckCircle2, XCircle, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DurationTicker } from "./DurationTicker";
import type { CallEntry } from "@/lib/realtime/reducers";

/**
 * One live call. Visual states:
 *   - dispatching: muted card, pulsing dot
 *   - calling:     green-tinted border, animated dot
 *   - completed:   green border, check icon, "Connected"
 *   - failed:      red border, X icon, "Failed"
 *
 * Phone number is masked at the network edge (backend already redacts the
 * middle digits before publishing the SSE event). We just format what we
 * receive.
 */
const STATUS_META = {
  dispatching: {
    label: "Dispatching",
    border: "border-info/40",
    dot: "bg-info animate-pulse-dot",
    badgeVariant: "info" as const,
    icon: PhoneCall,
  },
  calling: {
    label: "Calling",
    border: "border-success/40",
    dot: "bg-success animate-pulse-dot",
    badgeVariant: "success" as const,
    icon: Sparkles,
  },
  completed: {
    label: "Connected",
    border: "border-success/60",
    dot: "bg-success",
    badgeVariant: "success" as const,
    icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    border: "border-destructive/60",
    dot: "bg-destructive",
    badgeVariant: "destructive" as const,
    icon: XCircle,
  },
} as const;

export function LiveCallCard({ call }: { call: CallEntry }) {
  const meta = STATUS_META[call.status];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card p-4 transition-all duration-300 hover:shadow-glass",
        meta.border
      )}
    >
      {/* Top row — status + agent type */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full", meta.dot)} aria-hidden />
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {meta.label}
          </span>
        </div>
        <Badge variant="secondary" className="font-mono text-[10px] uppercase">
          {call.agent_type || "loan_enquiry"}
        </Badge>
      </div>

      {/* Customer name + phone */}
      <div className="mb-3">
        <div className="text-base font-semibold leading-tight">
          {call.customer_name}
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          {maskPhone(call.phone)}
        </div>
      </div>

      {/* Bottom row — language + duration / outcome */}
      <div className="flex items-center justify-between text-xs">
        <span className="rounded-md bg-muted/40 px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {call.language || "hindi"}
        </span>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {call.status === "completed" || call.status === "failed" ? (
            <DurationTicker startedAt={call.started_at} endedAt={call.ended_at ?? null} />
          ) : (
            <DurationTicker startedAt={call.started_at} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Mask middle digits — keep +91 prefix and last 2 digits visible. */
function maskPhone(p: string): string {
  if (!p) return "";
  const digits = p.replace(/\D/g, "");
  if (digits.length < 5) return p;
  const tail = digits.slice(-2);
  return `+91-XXXXX${tail}`;
}
