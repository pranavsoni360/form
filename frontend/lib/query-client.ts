"use client";

import { QueryClient } from "@tanstack/react-query";

/**
 * App-wide React Query client. Tuned for ops dashboards:
 * - staleTime 30s so most page-to-page transitions feel instant
 * - 1 retry on transient failures, with 1s base delay + exp backoff
 * - refetch on window focus (operator switching tabs sees fresh data)
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: 1,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
      },
      mutations: { retry: 0 },
    },
  });
}
