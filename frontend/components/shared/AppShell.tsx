import * as React from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * VirtualVaani-style two-column shell: persistent sidebar + sticky top bar +
 * cream-toned main content with a subtle dot grid overlay.
 *
 * Used by every /ops/* route. Inherits whatever theme (.dark or default
 * light) is set on <html> — the legacy `los-theme` toggle wired into
 * app/layout.tsx still works, so users can switch.
 */
export function AppShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={subtitle} />
        <main className="bg-dotgrid relative flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
