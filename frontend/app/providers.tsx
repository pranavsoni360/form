"use client";

import * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "sonner";

import { makeQueryClient } from "@/lib/query-client";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";

/**
 * Root client-side providers. Mounted from app/layout.tsx so the entire app
 * (legacy pages + new ops pages) shares one QueryClient + one EventSource.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // Lazy-create once per browser tab — React StrictMode double-invoke safe.
  const [client] = React.useState(makeQueryClient);

  return (
    <QueryClientProvider client={client}>
      <RealtimeProvider>
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{
            classNames: {
              toast: "group rounded-lg border border-border bg-card text-card-foreground shadow-glass",
            },
          }}
        />
      </RealtimeProvider>
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  );
}
