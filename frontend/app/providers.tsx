"use client";

import * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { makeQueryClient } from "@/lib/query-client";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";

/**
 * Root client-side providers. Mounted from app/layout.tsx so the entire app
 * (legacy pages + new ops pages) shares one QueryClient + one EventSource.
 *
 * The TanStack React Query DevTools floating button was removed — it was
 * showing as a small logo in the bottom-left corner during dev and looked
 * out of place against the VirtualVaani chrome. The QueryClient itself is
 * still there doing its job (caching + refetching). To re-enable the panel
 * for debugging:
 *
 *   import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
 *   // …then add inside QueryClientProvider:
 *   {process.env.NODE_ENV === "development" && <ReactQueryDevtools />}
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
    </QueryClientProvider>
  );
}
