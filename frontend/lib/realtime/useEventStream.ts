"use client";

import * as React from "react";
import { RealtimeContext, type RealtimeEvent } from "./RealtimeProvider";

type Topic = "calls" | "phones" | "workers" | "errors" | "batches";

/**
 * Subscribe to one or more topics and fold each event into a state value.
 *
 * Usage:
 *   const calls = useEventStream<CallsState>(
 *     "calls",
 *     callsReducer,
 *     { byId: {}, count: 0 },
 *   );
 *
 * The reducer must be a stable reference (useCallback or module-level)
 * to avoid re-subscribing on every render.
 */
export function useEventStream<S>(
  topics: Topic | ReadonlyArray<Topic>,
  reducer: (state: S, event: RealtimeEvent) => S,
  initialState: S
): S {
  const { subscribe } = React.useContext(RealtimeContext);
  const [state, setState] = React.useState<S>(initialState);

  // Topics → frozen set so equality checks in deps are cheap.
  const topicsKey = React.useMemo(() => {
    const arr = Array.isArray(topics) ? topics : [topics];
    return arr.slice().sort().join(",");
  }, [topics]);

  React.useEffect(() => {
    const wanted = new Set(topicsKey.split(","));
    return subscribe((event) => {
      const eventTopic = (event.topic ?? "") as string;
      // _meta events (lag markers) always pass through if any topic matches
      if (eventTopic === "_meta") {
        setState((prev) => reducer(prev, event));
        return;
      }
      if (!wanted.has(eventTopic)) return;
      setState((prev) => reducer(prev, event));
    });
  }, [subscribe, topicsKey, reducer]);

  return state;
}
