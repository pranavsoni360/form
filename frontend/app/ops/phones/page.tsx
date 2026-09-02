"use client";

import * as React from "react";
import { opsFetch } from "@/lib/ops-fetch";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CircleDot,
  Clock,
  PhoneCall,
  PowerOff,
  ShieldAlert,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { StatCard } from "@/components/ops/StatCard";
import { FilterPills, type FilterOption } from "@/components/ops/FilterPills";
import { DataTable, type DataTableColumn } from "@/components/ops/DataTable";
import { UtilizationBar } from "@/components/ops/UtilizationBar";
import { CountdownPill } from "@/components/ops/CountdownPill";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { API_URL } from "@/lib/api";
import { useEventStream } from "@/lib/realtime/useEventStream";
import {
  phonesReducer,
  initialPhonesState,
  type PhonesState,
} from "@/lib/realtime/reducers";

/* ───────────────────────────── Types ─────────────────────────────────── */

interface PhoneNumberRow {
  id: string;
  phone_number: string | null;
  active_calls: number;
  total_calls: number;
  cooldown_until: string | null; // ISO string from backend
  status: "active" | "disabled" | "quarantined";
  updated_at: string | null;
  /** Why the number was quarantined/disabled (auto-pause failure reason) */
  last_failure_reason: string | null;
  /** Joined into the flat row */
  pool_id: string;
  pool_name: string;
  pool_capacity: number;
}

interface PhonePoolsResponse {
  pools: Array<{
    id: string;
    name: string;
    capacity: number;
    bank_id: string | null;
    numbers: Array<{
      id: string;
      phone_number: string | null;
      active_calls: number;
      total_calls: number;
      cooldown_until: string | null;
      status: "active" | "disabled" | "quarantined";
      updated_at: string | null;
      last_failure_reason: string | null;
    }>;
  }>;
}

type Filter = "all" | "active" | "cooldown" | "quarantined" | "disabled";

/* ───────────────────────────── Page ──────────────────────────────────── */

export default function OpsPhonesPage() {
  // 1. Initial REST snapshot (cached by React Query)
  const seed = useQuery<PhonePoolsResponse>({
    queryKey: ["phone-pools"],
    queryFn: async () => {
      const res = await opsFetch(`${API_URL}/api/ops/phone-pools`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000, // background refresh every 30s — cheap safety net
  });

  // 2. SSE deltas merged on top of the snapshot
  const deltas = useEventStream<PhonesState>(
    "phones",
    phonesReducer,
    initialPhonesState
  );

  // 3. Flatten pools[].numbers[] into a single row list + apply SSE deltas
  const flatRows: PhoneNumberRow[] = React.useMemo(() => {
    if (!seed.data) return [];
    const out: PhoneNumberRow[] = [];
    for (const pool of seed.data.pools) {
      for (const n of pool.numbers) {
        const delta = deltas.byId[n.id];
        out.push({
          id: n.id,
          phone_number: n.phone_number,
          active_calls: delta ? delta.active_calls : n.active_calls,
          total_calls: n.total_calls,
          cooldown_until:
            delta?.cooldown_until != null
              ? new Date(delta.cooldown_until).toISOString()
              : n.cooldown_until,
          status: n.status,
          updated_at: n.updated_at,
          last_failure_reason: n.last_failure_reason,
          pool_id: pool.id,
          pool_name: pool.name,
          pool_capacity: pool.capacity,
        });
      }
    }
    return out;
  }, [seed.data, deltas]);

  // 4. Filter
  const [filter, setFilter] = React.useState<Filter>("all");
  const filteredRows = React.useMemo(() => {
    const nowMs = Date.now();
    return flatRows.filter((r) => {
      if (filter === "all") return true;
      if (filter === "active") {
        return r.status === "active" && (!r.cooldown_until || new Date(r.cooldown_until).getTime() <= nowMs);
      }
      if (filter === "cooldown") {
        return r.cooldown_until && new Date(r.cooldown_until).getTime() > nowMs;
      }
      // Quarantined (auto-paused) and Disabled (manually paused) are distinct
      // states, each its own list — OPS-22. Previously "disabled" caught both.
      if (filter === "quarantined") {
        return r.status === "quarantined";
      }
      if (filter === "disabled") {
        return r.status === "disabled";
      }
      return true;
    });
  }, [flatRows, filter]);

  // 5. Counts for stat row
  const counts = React.useMemo(() => {
    const nowMs = Date.now();
    let active = 0;
    let cooldown = 0;
    let quarantined = 0;
    let disabled = 0;
    for (const r of flatRows) {
      if (r.status === "quarantined") {
        quarantined += 1;
        continue;
      }
      if (r.status === "disabled") {
        disabled += 1;
        continue;
      }
      if (r.cooldown_until && new Date(r.cooldown_until).getTime() > nowMs) {
        cooldown += 1;
      } else {
        active += 1;
      }
    }
    return {
      pools: seed.data?.pools.length ?? 0,
      total: flatRows.length,
      active,
      cooldown,
      quarantined,
      disabled,
    };
  }, [flatRows, seed.data]);

  const filterOptions: ReadonlyArray<FilterOption<Filter>> = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "cooldown", label: "In cooldown" },
    { value: "quarantined", label: "Quarantined" },
    { value: "disabled", label: "Disabled" },
  ];

  const filterCounts: Partial<Record<Filter, number>> = {
    all: counts.total,
    active: counts.active,
    cooldown: counts.cooldown,
    quarantined: counts.quarantined,
    disabled: counts.disabled,
  };

  // 6. Table columns
  const columns: ReadonlyArray<DataTableColumn<PhoneNumberRow>> = [
    {
      key: "phone",
      header: "Number",
      render: (r) => (
        <div className="space-y-0.5">
          <div className="font-mono text-sm font-semibold text-foreground">
            {r.phone_number ? maskPhone(r.phone_number) : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground">id {r.id.slice(0, 8)}</div>
        </div>
      ),
    },
    {
      key: "pool",
      header: "Pool",
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-[11px] font-mono text-foreground/80">
          <Building2 className="h-3 w-3" />
          {r.pool_name}
        </span>
      ),
    },
    {
      key: "util",
      header: "Utilization",
      render: (r) => <UtilizationBar value={r.active_calls} max={r.pool_capacity} />,
    },
    {
      key: "cooldown",
      header: "Cooldown",
      render: (r) => (
        <CountdownPill until={r.cooldown_until ? new Date(r.cooldown_until).getTime() : null} />
      ),
    },
    {
      key: "total",
      header: "Total today",
      align: "right",
      render: (r) => (
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {r.total_calls.toLocaleString()}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.status} reason={r.last_failure_reason} />,
    },
  ];

  return (
    <AppShell
      title="Phone pool"
      subtitle={`${counts.pools} pool${counts.pools === 1 ? "" : "s"} · ${counts.total} number${counts.total === 1 ? "" : "s"} · live SSE`}
    >
      <div className="space-y-6">
        {/* Stat row */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <StatCard label="POOLS" value={counts.pools} icon={Building2} tone="neutral" />
          <StatCard label="ACTIVE" value={counts.active} icon={CircleDot} tone="success" />
          <StatCard label="IN COOLDOWN" value={counts.cooldown} icon={Clock} tone="warning" />
          <StatCard label="QUARANTINED" value={counts.quarantined} icon={ShieldAlert} tone="warning" />
          <StatCard label="DISABLED" value={counts.disabled} icon={PowerOff} tone="danger" />
        </div>

        {/* Filter pills */}
        <FilterPills
          options={filterOptions}
          value={filter}
          onChange={setFilter}
          counts={filterCounts}
        />

        {/* Table */}
        {seed.isLoading ? (
          <TableSkeleton />
        ) : seed.error ? (
          <ErrorBox message={(seed.error as Error).message} />
        ) : (
          <DataTable
            columns={columns}
            rows={filteredRows}
            rowKey={(r) => r.id}
            empty={<EmptyBox filter={filter} />}
          />
        )}
      </div>
    </AppShell>
  );
}

/* ───────────────────────────── Helpers ───────────────────────────────── */

function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  if (digits.length < 5) return p;
  const tail = digits.slice(-2);
  return `+91-XXXXX${tail}`;
}

function StatusBadge({ status, reason }: { status: PhoneNumberRow["status"]; reason?: string | null }) {
  if (status === "active") return <Badge variant="success">Active</Badge>;
  // Quarantined/disabled numbers say WHY (OPS-22): the reason shows inline and
  // as a hover title. Quarantined is auto-paused after failures; disabled is
  // manually paused.
  const badge =
    status === "disabled" ? (
      <Badge variant="secondary">Disabled</Badge>
    ) : (
      <Badge variant="destructive">Quarantined</Badge>
    );
  if (!reason) return badge;
  return (
    <div className="space-y-0.5" title={reason}>
      {badge}
      <div className="max-w-[220px] truncate text-[10px] text-muted-foreground">{reason}</div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card p-4 shadow-sm">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

function EmptyBox({ filter }: { filter: Filter }) {
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
        <PhoneCall className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="mt-3 text-sm font-semibold">No numbers match this filter</div>
      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
        {filter === "all"
          ? "Seed the phone_numbers table to register outbound trunks. The dispatcher falls back to SIP_TRUNK_ID env until then."
          : "Try the All filter to see every number registered in any pool."}
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-5 py-4 text-sm text-destructive">
      Couldn&apos;t load phone pools: <span className="font-mono">{message}</span>
    </div>
  );
}
