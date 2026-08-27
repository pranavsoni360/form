"use client";

// Finix nested-panel shell (design overhaul §1.1 / §1.4).
//
// Layout (top→bottom in the content column):
//   AppBar — 56px, full width of content area; theme toggle + bell + user menu on the right.
//   Page content — flex-col gap-4, grows to fill.
//   AppFooter — © copyright, sticks to bottom on short pages (margin-top: auto).
//
// The sidebar is always-dark (#0A1B2D) and lives to the left. The content
// column is the standard --fx-surface rounded panel.
//
// Collapsed state persists in localStorage under "finix.sidebar.collapsed".

import * as React from "react";
import { FinixThemeProvider } from "./theme";
import { Sidebar, type FinixNavItem, type SidebarIdentity, type SidebarAction } from "./Sidebar";
import { UserMenu } from "./UserMenu";
import { FinixThemeToggle } from "./ThemeToggleButton";

export { type FinixNavItem, type SidebarIdentity, type SidebarAction };

const COLLAPSED_KEY = "finix.sidebar.collapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}

function AppBar({
  identity,
  onLogout,
  identityFooter,
  right,
}: {
  identity: SidebarIdentity;
  onLogout: () => void;
  identityFooter?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <header
      className="flex h-14 shrink-0 items-center px-5"
      style={{ borderBottom: "1px solid var(--fx-border)", background: "var(--fx-surface)" }}
    >
      {/* Left spacer so right controls push to the edge */}
      <div className="flex-1" />

      {/* Right controls: theme toggle · bell · user menu */}
      <div className="flex items-center gap-2">
        <FinixThemeToggle />
        {right}
        <UserMenu
          name={identity.name}
          initials={identity.initials}
          role={identity.role}
          tenant={identity.tenant}
          onLogout={onLogout}
          sessionTimer={identityFooter}
        />
      </div>
    </header>
  );
}

function AppFooter() {
  return (
    <footer
      className="shrink-0 px-5 py-3.5 text-center text-[11px]"
      style={{
        borderTop: "1px solid var(--fx-border)",
        color: "var(--fx-text3)",
        marginTop: "auto",
      }}
    >
      © 2026 Finix · Virtual Galaxy Infotech Limited
      {process.env.NEXT_PUBLIC_BUILD_ENV && (
        <span className="ml-3 opacity-50">{process.env.NEXT_PUBLIC_BUILD_ENV}</span>
      )}
    </footer>
  );
}

export function FinixShell({
  nav,
  identity,
  identityFooter,
  onLogout = () => {},
  headerRight,
  children,
  // Kept for API compatibility — no longer rendered.
  action: _action,
}: {
  nav: FinixNavItem[];
  identity: SidebarIdentity;
  /** Passed to UserMenu (e.g. <SessionTimer>). */
  identityFooter?: React.ReactNode;
  onLogout?: () => void;
  /** Rendered in the AppBar right slot (e.g. notification bell). */
  headerRight?: React.ReactNode;
  /** @deprecated — sidebar action card removed per spec §2.2. */
  action?: SidebarAction;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  // Hydrate from localStorage after mount.
  React.useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  function toggleCollapse() {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* storage off */ }
      return next;
    });
  }

  return (
    <FinixThemeProvider>
      <div className="finix-root flex min-h-screen" style={{ background: "var(--fx-bg)" }}>
        {/* Sidebar — always-dark, sticky */}
        <Sidebar nav={nav} collapsed={collapsed} onToggleCollapse={toggleCollapse} />

        {/* Content column — rounded panel right of sidebar */}
        <div className="flex min-w-0 flex-1 flex-col py-3 pr-3">
          <div
            className="flex min-h-[calc(100vh-24px)] flex-col rounded-[18px]"
            style={{ background: "var(--fx-surface)" }}
          >
            {/* App bar */}
            <AppBar
              identity={identity}
              onLogout={onLogout}
              identityFooter={identityFooter}
              right={headerRight}
            />

            {/* Page content */}
            <main className="flex flex-1 flex-col gap-4 px-[18px] pb-4 pt-5">
              {children}
            </main>

            {/* Footer sticks to the bottom of the content column */}
            <AppFooter />
          </div>
        </div>
      </div>
    </FinixThemeProvider>
  );
}
