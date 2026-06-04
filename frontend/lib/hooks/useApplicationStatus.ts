// lib/hooks/useApplicationStatus.ts
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { AuthType } from '@/lib/auth/roles';

interface UseApplicationStatusOptions {
  appId:         string | null;
  fetchFn:       (appId: string) => Promise<any>;
  pollIntervalMs?: number;     // default 30s — set to 0 to disable polling
  enabled?:        boolean;
}

interface ApplicationStatusState {
  data:       any | null;
  loading:    boolean;
  error:      string | null;
  lastFetched: Date | null;
}

export function useApplicationStatus({
  appId,
  fetchFn,
  pollIntervalMs = 30_000,
  enabled        = true,
}: UseApplicationStatusOptions) {
  const [state, setState] = useState<ApplicationStatusState>({
    data:        null,
    loading:     true,
    error:       null,
    lastFetched: null,
  });

  const intervalRef  = useRef<NodeJS.Timeout | null>(null);
  const isMounted    = useRef(true);

  const fetch = useCallback(async () => {
    if (!appId || !enabled) return;

    // Don't show loading spinner on background polls
    setState(prev => ({ ...prev, error: null }));

    try {
      const data = await fetchFn(appId);
      if (!isMounted.current) return;
      setState({ data, loading: false, error: null, lastFetched: new Date() });
    } catch (err) {
      if (!isMounted.current) return;
      setState(prev => ({
        ...prev,
        loading: false,
        error: (err as Error).message || 'Failed to load application',
      }));
    }
  }, [appId, fetchFn, enabled]);

  // Initial fetch
  useEffect(() => {
    setState(prev => ({ ...prev, loading: true }));
    fetch();
  }, [fetch]);

  // Polling
  useEffect(() => {
    if (!pollIntervalMs || !enabled) return;

    intervalRef.current = setInterval(fetch, pollIntervalMs);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetch, pollIntervalMs, enabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMounted.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const refetch = useCallback(() => fetch(), [fetch]);

  return {
    ...state,
    refetch,
  };
}