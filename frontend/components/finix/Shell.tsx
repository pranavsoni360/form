"use client";

// Finix nested-panel shell (design_handoff_finix/README.md §Surfaces,
// §Content panel). Page bg → shell panels (surface) → cards (surface2).
// 12px gutter around the app and between the sidebar and content columns.
// The content column is ONE rounded 18px panel filling the viewport width,
// padded 16px 18px 20px, 16px gap between sections. No top bar.

import * as React from "react";
import { FinixThemeProvider } from "./theme";
import { Sidebar, type FinixNavItem, type SidebarIdentity, type SidebarAction } from "./Sidebar";

export function FinixShell({
  nav,
  identity,
  identityFooter,
  action,
  headerRight,
  children,
}: {
  nav: FinixNavItem[];
  identity: SidebarIdentity;
  /** Rendered in the identity card — the shells pass the idle session timer. */
  identityFooter?: React.ReactNode;
  action?: SidebarAction;
  /** Rendered top-right of the content panel (e.g. the notification bell). */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <FinixThemeProvider>
      <div className="finix-root min-h-screen">
        <div className="flex min-h-screen">
          <Sidebar
            nav={nav}
            identity={identity}
            identityFooter={identityFooter}
            action={action}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((v) => !v)}
          />
          {/* Content column: one 18px panel, right/top/bottom gutter of 12px. */}
          <main className="min-w-0 flex-1 py-3 pr-3">
            <div className="min-h-[calc(100vh-24px)] rounded-[18px] bg-fx-surface px-[18px] pb-5 pt-4">
              {headerRight && <div className="mb-2 flex justify-end">{headerRight}</div>}
              <div className="flex flex-col gap-4">{children}</div>
            </div>
          </main>
        </div>
      </div>
    </FinixThemeProvider>
  );
}
