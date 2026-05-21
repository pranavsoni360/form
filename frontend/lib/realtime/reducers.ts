/**
 * Topic-specific reducers. Each one folds a stream of events into a
 * page-friendly state shape. Pure functions — no side effects.
 *
 * Pattern: keep state simple + flat. Pages can derive sorted/filtered
 * views with useMemo() over the reduced state.
 */

import type { RealtimeEvent } from "./RealtimeProvider";

/* ───────────────────────────── calls topic ───────────────────────────── */

export interface CallEntry {
  call_id: string;
  status: "dispatching" | "calling" | "completed" | "failed";
  customer_name: string;
  phone: string;
  language?: string;
  agent_type?: string;
  batch_id?: string;
  bank_id?: string | null;
  started_at: number;   // ms, set when we first see the call
  ended_at?: number;    // ms, set on completed/failed
  outcome_success?: boolean;
}

export interface CallsState {
  byId: Record<string, CallEntry>;
  /** Order calls by started_at desc (newest first) without re-sorting on every render. */
  order: string[];
}

export const initialCallsState: CallsState = { byId: {}, order: [] };

export function callsReducer(state: CallsState, event: RealtimeEvent): CallsState {
  if (event.type !== "call_state") return state;
  const callId = event.call_id as string;
  if (!callId) return state;

  const existing = state.byId[callId];
  const now = (event.ts as number | undefined) ? (event.ts as number) * 1000 : Date.now();
  const status = event.status as CallEntry["status"];

  // Terminal states: keep the card for ~6 seconds so users can see the
  // outcome flash before it removes. Done in the page via setTimeout, but
  // the entry is updated here.
  const next: CallEntry = {
    call_id: callId,
    status,
    customer_name: (event.customer_name as string) ?? existing?.customer_name ?? "Customer",
    phone: (event.phone as string) ?? existing?.phone ?? "",
    language: (event.language as string) ?? existing?.language,
    agent_type: (event.agent_type as string) ?? existing?.agent_type,
    batch_id: (event.batch_id as string) ?? existing?.batch_id,
    bank_id: (event.bank_id as string | null | undefined) ?? existing?.bank_id ?? null,
    started_at: existing?.started_at ?? now,
    ended_at: status === "completed" || status === "failed" ? now : existing?.ended_at,
    outcome_success: event.outcome_success as boolean | undefined,
  };

  if (existing) {
    return { ...state, byId: { ...state.byId, [callId]: next } };
  }
  return {
    byId: { ...state.byId, [callId]: next },
    order: [callId, ...state.order],
  };
}

/** Remove a terminated call from the state (called after the "vanish" delay). */
export function removeCall(state: CallsState, callId: string): CallsState {
  if (!state.byId[callId]) return state;
  const { [callId]: _, ...byId } = state.byId;
  return { byId, order: state.order.filter((id) => id !== callId) };
}

/* ───────────────────────────── phones topic ──────────────────────────── */

export interface PhonePoolEntry {
  phone_id: string;
  phone_number?: string | null;
  active_calls: number;
  cooldown_until?: number | null; // ms epoch, optional
  last_action?: "acquire" | "release";
  last_update: number;
}

export interface PhonesState {
  byId: Record<string, PhonePoolEntry>;
}

export const initialPhonesState: PhonesState = { byId: {} };

export function phonesReducer(state: PhonesState, event: RealtimeEvent): PhonesState {
  if (event.type !== "pool_update") return state;
  const phoneId = event.phone_id as string | undefined;
  if (!phoneId) return state;

  const existing = state.byId[phoneId];
  const delta = (event.active_delta as number) ?? 0;
  const cooldownStarted = Boolean(event.cooldown_started);
  const cooldownSeconds = (event.cooldown_seconds as number) ?? 0;
  const now = (event.ts as number | undefined) ? (event.ts as number) * 1000 : Date.now();

  return {
    byId: {
      ...state.byId,
      [phoneId]: {
        phone_id: phoneId,
        phone_number: (event.phone_number as string | null | undefined) ?? existing?.phone_number ?? null,
        active_calls: Math.max(0, (existing?.active_calls ?? 0) + delta),
        cooldown_until: cooldownStarted
          ? now + cooldownSeconds * 1000
          : existing?.cooldown_until ?? null,
        last_action: event.action as "acquire" | "release" | undefined,
        last_update: now,
      },
    },
  };
}

/* ───────────────────────────── workers topic ─────────────────────────── */

export interface WorkerEntry {
  worker_id: string;
  kind: string;
  status: string;
  jobs_processed: number;
  uptime_seconds: number;
  last_heartbeat_at: number;
}

export interface QueueDepth {
  pending: number;
  failed: number;
  running: number;
  dead: number;
  workers_alive: number;
  workers_total: number;
  updated_at: number;
}

export interface WorkersState {
  byId: Record<string, WorkerEntry>;
  queueDepth: QueueDepth | null;
}

export const initialWorkersState: WorkersState = { byId: {}, queueDepth: null };

export function workersReducer(state: WorkersState, event: RealtimeEvent): WorkersState {
  const now = Date.now();
  if (event.type === "worker_heartbeat") {
    const wid = event.worker_id as string;
    if (!wid) return state;
    return {
      ...state,
      byId: {
        ...state.byId,
        [wid]: {
          worker_id: wid,
          kind: (event.kind as string) ?? "worker",
          status: (event.status as string) ?? "unknown",
          jobs_processed: (event.jobs_processed as number) ?? 0,
          uptime_seconds: (event.uptime_seconds as number) ?? 0,
          last_heartbeat_at: now,
        },
      },
    };
  }
  if (event.type === "queue_depth") {
    return {
      ...state,
      queueDepth: {
        pending: (event.pending as number) ?? 0,
        failed: (event.failed as number) ?? 0,
        running: (event.running as number) ?? 0,
        dead: (event.dead as number) ?? 0,
        workers_alive: (event.workers_alive as number) ?? 0,
        workers_total: (event.workers_total as number) ?? 0,
        updated_at: now,
      },
    };
  }
  return state;
}

/* ───────────────────────────── batches topic ─────────────────────────── */

export interface BatchProgress {
  batch_id: string;
  batch_uuid?: string;
  status: "running" | "done";
  total: number;
  completed: number;
  successful: number;
  failed: number;
  updated_at: number;
}

export interface BatchesState {
  byId: Record<string, BatchProgress>;
}

export const initialBatchesState: BatchesState = { byId: {} };

export function batchesReducer(state: BatchesState, event: RealtimeEvent): BatchesState {
  if (event.type !== "batch_progress") return state;
  const id = event.batch_id as string;
  if (!id) return state;
  return {
    byId: {
      ...state.byId,
      [id]: {
        batch_id: id,
        batch_uuid: event.batch_uuid as string | undefined,
        status: event.status as "running" | "done",
        total: (event.total as number) ?? 0,
        completed: (event.completed as number) ?? 0,
        successful: (event.successful as number) ?? 0,
        failed: (event.failed as number) ?? 0,
        updated_at: Date.now(),
      },
    },
  };
}

/* ───────────────────────────── errors topic ──────────────────────────── */

// Where the error came from — drives the badge color on /ops/errors.
// `backend` = FastAPI global handler. Others arrive via POST /api/internal/errors
// (HMAC-signed) from off-process sources.
export type ErrorSource =
  | "backend"
  | "agent"
  | "livekit"
  | "sip"
  | "docker"
  | "postgres"
  | "frontend";

export type ErrorLevel = "error" | "warning";

export interface ErrorEntry {
  correlation_id: string;
  source: ErrorSource;
  level: ErrorLevel;
  route: string;
  method: string;
  exc_type: string;
  message: string;
  trace?: string;
  metadata?: Record<string, unknown>;
  ts: number;
}

export interface ErrorsState {
  recent: ErrorEntry[]; // newest first, cap 100
}

export const initialErrorsState: ErrorsState = { recent: [] };

const ERROR_RING_SIZE = 100;

export function errorsReducer(state: ErrorsState, event: RealtimeEvent): ErrorsState {
  if (event.type !== "error") return state;
  const rawSource = (event.source as string | undefined)?.toLowerCase();
  const source: ErrorSource =
    rawSource === "agent" ||
    rawSource === "livekit" ||
    rawSource === "sip" ||
    rawSource === "docker" ||
    rawSource === "postgres" ||
    rawSource === "frontend"
      ? rawSource
      : "backend"; // default for legacy events without source field
  const rawLevel = (event.level as string | undefined)?.toLowerCase();
  const level: ErrorLevel = rawLevel === "warning" ? "warning" : "error";
  const entry: ErrorEntry = {
    correlation_id: (event.correlation_id as string) ?? "-",
    source,
    level,
    route: (event.route as string) ?? "?",
    method: (event.method as string) ?? "?",
    exc_type: (event.exc_type as string) ?? "?",
    message: (event.message as string) ?? "",
    trace: (event.trace as string | undefined) ?? undefined,
    metadata: (event.metadata as Record<string, unknown> | undefined) ?? undefined,
    ts: (event.ts as number | undefined)
      ? (event.ts as number) * 1000
      : Date.now(),
  };

  // Dedup. The backend replays the 500-event errors ring buffer to every new
  // SSE subscriber, so transient reconnects (network blip, token refresh,
  // React StrictMode double-mount in dev, opening another tab) would otherwise
  // multiply the row count.
  //
  // Primary key: correlation_id + ts (uuid hex from the backend, unique per
  // real error). Fallback key: (source, exc_type, ts, message) — needed when
  // correlation_id is "-" (backend exceptions raised before the request id
  // middleware populates it; also true of some webhook events). Without this
  // fallback the "-" events accumulate on every reconnect (8 → 9 → 10 …).
  const isDup = state.recent.some((e) =>
    entry.correlation_id !== "-"
      ? e.correlation_id === entry.correlation_id && e.ts === entry.ts
      : e.correlation_id === "-" &&
        e.source === entry.source &&
        e.exc_type === entry.exc_type &&
        e.ts === entry.ts &&
        e.message === entry.message,
  );
  if (isDup) return state;

  return { recent: [entry, ...state.recent].slice(0, ERROR_RING_SIZE) };
}
