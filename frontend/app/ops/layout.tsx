"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { ensureValidToken } from "@/lib/auth";

/**
 * /ops/* route group layout.
 *
 * Auth gate: requires an admin JWT in localStorage (`los_admin_token`). If
 * absent, we redirect to /admin/login WITH the current path attached as a
 * `?redirect=...` param, so after a successful login the user lands back
 * exactly where they tried to go (not on /admin/dashboard).
 *
 * We render a tiny "checking" placeholder for the first paint so unauthenticated
 * users never see a degraded /ops UI (broken SSE, empty stat cards, etc.)
 * before the redirect fires.
 *
 * Each leaf page renders its own <AppShell> with a page-specific title/subtitle
 * — the sidebar nav highlights the right item via usePathname().
 */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = React.useState<"checking" | "authed" | "redirecting">("checking");

  // Default ops pages to dark mode on first visit (if user hasn't chosen light)
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem("los-theme");
      if (saved !== "light") {
        document.documentElement.classList.add("dark");
        document.documentElement.setAttribute("data-theme", "dark");
        if (!saved) localStorage.setItem("los-theme", "dark");
      } else {
        document.documentElement.setAttribute("data-theme", "light");
      }
    } catch {}
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      // Validate the token (expiry-aware) and silently refresh a lapsed session
      // via the httpOnly cookie. A missing/expired token with no valid refresh
      // cookie → not authenticated → redirect to login. This closes the hole
      // where a stale token slipped past a mere presence check.
      const token = await ensureValidToken("admin");
      if (cancelled) return;
      if (!token) {
        setStatus("redirecting");
        const dest = pathname && pathname.startsWith("/ops") ? pathname : "/ops";
        router.replace(`/admin/login?redirect=${encodeURIComponent(dest)}`);
        return;
      }
      setStatus("authed");
    })();
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  if (status !== "authed") {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        <div className="text-sm">
          {status === "checking" ? "Verifying admin session…" : "Redirecting to login…"}
        </div>
      </div>
    );
  }

  return <ErrorBoundary>{children}</ErrorBoundary>;
}
