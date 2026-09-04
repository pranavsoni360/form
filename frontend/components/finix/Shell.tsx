"use client";

// Finix nested-panel shell (design overhaul §1.1 / §1.4).
//
// Responsive layout:
//   Mobile (<md): sidebar is a fixed-position drawer (z-50), hidden by default.
//     A hamburger button in the AppBar opens it; a backdrop closes it.
//   Desktop (≥md): sidebar is sticky, left-of-content, collapsible to 64px.
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

function HamburgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function AppBar({
  identity,
  onLogout,
  identityFooter,
  right,
  onMenuOpen,
}: {
  identity: SidebarIdentity;
  onLogout: () => void;
  identityFooter?: React.ReactNode;
  right?: React.ReactNode;
  onMenuOpen?: () => void;
}) {
  return (
    <header
      className="flex h-14 shrink-0 items-center px-3 sm:px-5"
      style={{ borderBottom: "1px solid var(--fx-border)", background: "var(--fx-surface)" }}
    >
      {/* Hamburger — mobile only */}
      <button
        type="button"
        onClick={onMenuOpen}
        className="mr-2 grid h-8 w-8 shrink-0 place-items-center rounded-[8px] transition-colors md:hidden"
        style={{ color: "var(--fx-text2)" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--fx-surface2)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "")}
        aria-label="Open navigation"
      >
        <HamburgerIcon />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right controls */}
      <div className="flex items-center gap-2 sm:gap-3">
        {identityFooter}
        <FinixThemeToggle />
        {right}
        <UserMenu
          name={identity.name}
          initials={identity.initials}
          role={identity.role}
          tenant={identity.tenant}
          onLogout={onLogout}
        />
      </div>
    </header>
  );
}

function AppFooter() {
  return (
    <footer
      className="shrink-0 px-3 sm:px-5 py-3.5 text-center text-[11px]"
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
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Hydrate collapsed state from localStorage after mount.
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
        {/* Mobile overlay backdrop — click to close */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        )}

        {/* Sidebar — sticky on desktop, drawer overlay on mobile */}
        <Sidebar
          nav={nav}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />

        {/* Content column */}
        <div className="flex min-w-0 flex-1 flex-col md:py-3 md:pr-3">
          <div
            className="flex min-h-screen md:min-h-[calc(100vh-24px)] flex-col md:rounded-[18px]"
            style={{ background: "var(--fx-surface)" }}
          >
            {/* App bar */}
            <AppBar
              identity={identity}
              onLogout={onLogout}
              identityFooter={identityFooter}
              right={headerRight}
              onMenuOpen={() => setMobileOpen(true)}
            />

            {/* Page content */}
            <main className="flex flex-1 flex-col gap-3 px-3 pb-4 pt-4 sm:px-4 md:gap-4 md:px-[18px] md:pt-5">
              {children}
            </main>

            {/* Footer */}
            <AppFooter />
          </div>
        </div>
      </div>
    </FinixThemeProvider>
  );
}
