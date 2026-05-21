// lib/hooks/useApplicationStatus.ts — polled application-status hook for
// bank / vendor dashboards. Re-fetches every pollIntervalMs without showing
// the loading spinner on background refreshes.
"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface UseApplicationStatusOptions {
  appId: string | null;
  fetchFn: (appId: string) => Promise<any>;
  pollIntervalMs?: number; // default 30s — set to 0 to disable polling
  enabled?: boolean;
}

interface ApplicationStatusState {
  data: any | null;
  loading: boolean;
  error: string | null;
  lastFetched: Date | null;
}

export function useApplicationStatus({
  appId,
  fetchFn,
  pollIntervalMs = 30_000,
  enabled = true,
}: UseApplicationStatusOptions) {
  const [state, setState] = useState<ApplicationStatusState>({
    data: null,
    loading: true,
    error: null,
    lastFetched: null,
  });

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMounted = useRef(true);

  const doFetch = useCallback(async () => {
    if (!appId || !enabled) return;
    setState((prev) => ({ ...prev, error: null }));
    try {
      const data = await fetchFn(appId);
      if (!isMounted.current) return;
      setState({ data, loading: false, error: null, lastFetched: new Date() });
    } catch (err) {
      if (!isMounted.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: (err as Error).message || "Failed to load application",
      }));
    }
  }, [appId, fetchFn, enabled]);

  // Initial fetch
  useEffect(() => {
    setState((prev) => ({ ...prev, loading: true }));
    doFetch();
  }, [doFetch]);

  // Polling
  useEffect(() => {
    if (!pollIntervalMs || !enabled) return;
    intervalRef.current = setInterval(doFetch, pollIntervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [doFetch, pollIntervalMs, enabled]);

  useEffect(() => {
    return () => {
      isMounted.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const refetch = useCallback(() => doFetch(), [doFetch]);

  return { ...state, refetch };
}
