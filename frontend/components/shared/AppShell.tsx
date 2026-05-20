import * as React from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Two-column ops shell: persistent sidebar + sticky top bar + main content.
 * Used by every /ops/* route. Forces dark theme on its subtree so the rest
 * of the app (light-mode legacy pages) is unaffected.
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
    <div className="dark flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} subtitle={subtitle} />
        <main className="flex-1 px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
