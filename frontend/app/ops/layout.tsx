import * as React from "react";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";

/**
 * /ops/* route group layout. Each leaf page renders its own <AppShell> with
 * a page-specific title/subtitle, so the sidebar nav highlights the right
 * item via usePathname().
 *
 * Auth gate (admin / bank-supervisor) lands in Phase 1 once we wire JWT
 * checks against /api/auth/me here as a Server Component.
 */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
