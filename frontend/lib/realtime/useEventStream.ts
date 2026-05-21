"use client";

import * as React from "react";
import { RealtimeContext, type RealtimeEvent } from "./RealtimeProvider";

type Topic = "calls" | "phones" | "workers" | "errors" | "batches";

/**
 * Subscribe to one or more topics and fold each event into a state value.
 *
 * Usage (live-only):
 *   const calls = useEventStream<CallsState>(
 *     "calls",
 *     callsReducer,
 *     { byId: {}, count: 0 },
 *   );
 *
 * Usage with REST seed (page mount loads history from DB, then live SSE on top):
 *   const errors = useEventStream<ErrorsState>(
 *     "errors",
 *     errorsReducer,
 *     initialErrorsState,
 *     {
 *       seed: async () => {
 *         const r = await fetch(`${API_URL}/api/ops/errors?limit=100`);
 *         return r.ok ? (await r.json()).errors : [];
 *       },
 *     },
 *   );
 *
 * Each event from `seed()` is fed through the same reducer as live events,
 * so the reducer's existing dedup logic naturally collapses any duplicates
 * that the SSE replay would also send. Topic is auto-stamped if missing.
 *
 * The reducer must be a stable reference (useCallback or module-level)
 * to avoid re-subscribing on every render.
 */
export function useEventStream<S>(
  topics: Topic | ReadonlyArray<Topic>,
  reducer: (state: S, event: RealtimeEvent) => S,
  initialState: S,
  options?: { seed?: () => Promise<RealtimeEvent[]> }
): S {
  const { subscribe } = React.useContext(RealtimeContext);
  const [state, setState] = React.useState<S>(initialState);

  const topicsKey = React.useMemo(() => {
    const arr = Array.isArray(topics) ? topics : [topics];
    return arr.slice().sort().join(",");
  }, [topics]);

  // Live SSE subscription — unchanged
  React.useEffect(() => {
    const wanted = new Set(topicsKey.split(","));
    return subscribe((event) => {
      const eventTopic = (event.topic ?? "") as string;
      if (eventTopic === "_meta") {
        setState((prev) => reducer(prev, event));
        return;
      }
      if (!wanted.has(eventTopic)) return;
      setState((prev) => reducer(prev, event));
    });
  }, [subscribe, topicsKey, reducer]);

  // One-shot REST seed on mount. The reducer's dedup means duplicate events
  // (also delivered via SSE replay) are silently collapsed — safe to fire
  // independently of the SSE subscription.
  const seedFn = options?.seed;
  React.useEffect(() => {
    if (!seedFn) return;
    let cancelled = false;
    (async () => {
      try {
        const events = await seedFn();
        if (cancelled) return;
        // Stamp topic if the REST endpoint doesn't include it — keeps the
        // SSE-shape filter in the live handler symmetric.
        const fallbackTopic = topicsKey.split(",")[0];
        setState((prev) => {
          let s = prev;
          for (const ev of events) {
            const withTopic: RealtimeEvent = ev.topic
              ? ev
              : { ...ev, topic: fallbackTopic };
            s = reducer(s, withTopic);
          }
          return s;
        });
      } catch {
        // Seed failure is non-fatal — live SSE still works.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
