/**
 * Activity buffer reducer — keeps a rolling ring of the last N event timestamps
 * for any topic. Used by /ops overview to render the "Recent activity" chart
 * without needing a backend time-series endpoint yet.
 *
 * Pure function over RealtimeEvent[]; pages derive a 10-second bucketed series
 * via useMemo.
 */

import type { RealtimeEvent } from "./RealtimeProvider";

export interface ActivityEntry {
  ts: number;           // ms epoch
  topic: string;
  type: string;
  /** For calls topic: dispatching / completed / failed — for chart segmentation */
  status?: string;
}

export interface ActivityState {
  /** Newest first, capped at MAX_RING */
  events: ActivityEntry[];
}

const MAX_RING = 600;          // ~10 minutes of events at ~1/sec
const RETAIN_WINDOW_MS = 10 * 60 * 1000;

export const initialActivityState: ActivityState = { events: [] };

export function activityReducer(state: ActivityState, event: RealtimeEvent): ActivityState {
  // Only record events relevant to the activity chart. Heartbeats + queue_depth
  // fire every 2-10s and would drown out genuine traffic.
  const topic = (event.topic as string) ?? "";
  const type = event.type;
  if (topic === "_meta") return state;
  if (type === "worker_heartbeat" || type === "queue_depth") return state;
  if (type === "_connected") return state;

  const now = (event.ts as number | undefined)
    ? (event.ts as number) * 1000
    : Date.now();

  // Drop events older than RETAIN_WINDOW_MS so the buffer self-trims
  const cutoff = Date.now() - RETAIN_WINDOW_MS;
  const fresh = state.events.filter((e) => e.ts >= cutoff);

  const entry: ActivityEntry = {
    ts: now,
    topic,
    type,
    status: typeof event.status === "string" ? event.status : undefined,
  };

  return { events: [entry, ...fresh].slice(0, MAX_RING) };
}

/**
 * Bucket the buffer into a Recharts-friendly series. Returns one row per
 * bucket in chronological order (oldest first), even when there are zero
 * events in a bucket — so the chart x-axis stays continuous.
 */
export function bucketActivity(
  events: ReadonlyArray<ActivityEntry>,
  windowMs: number,
  bucketMs: number,
  topics?: ReadonlyArray<string>
): Array<{ t: number; label: string; calls: number; errors: number }> {
  const now = Date.now();
  const start = now - windowMs;
  // Round start DOWN to a clean bucket boundary so the x-axis lines up
  const alignedStart = Math.floor(start / bucketMs) * bucketMs;
  const nBuckets = Math.ceil(windowMs / bucketMs);

  const out = Array.from({ length: nBuckets }, (_, i) => {
    const t = alignedStart + i * bucketMs;
    return {
      t,
      label: formatBucketLabel(t, bucketMs),
      calls: 0,
      errors: 0,
    };
  });

  const filter = topics ? new Set(topics) : null;
  for (const e of events) {
    if (filter && !filter.has(e.topic)) continue;
    if (e.ts < alignedStart) continue;
    const idx = Math.floor((e.ts - alignedStart) / bucketMs);
    if (idx < 0 || idx >= out.length) continue;
    if (e.topic === "errors") out[idx].errors += 1;
    else if (e.topic === "calls") out[idx].calls += 1;
  }
  return out;
}

function formatBucketLabel(t: number, bucketMs: number): string {
  const d = new Date(t);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (bucketMs < 60_000) {
    const ss = d.getSeconds().toString().padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}`;
}
