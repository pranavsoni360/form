"use client";

// Finix admin sidebar (design overhaul §1.2 / §1.3).
//
// Desktop (≥md): sticky left panel, collapsible between 240px (expanded) and
//   64px (icons only). Collapsed state persists in localStorage.
// Mobile (<md): fixed-position drawer overlay (z-50). Hidden by default;
//   the Shell renders a backdrop and passes mobileOpen / onMobileClose to
//   control it. Always 240px wide on mobile — collapsed/expanded is desktop-only.

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { FinixLogo } from "@/components/shared/FinixLogo";

export type FinixNavItem = {
  href: string;
  label: string;
  /** Monospace glyph stand-in; used as the icon in collapsed state. */
  glyph: string;
  count?: number;
  /** Optional group label ("Manage", "Insight"). Items without a group render first, ungrouped. */
  group?: string;
};

// Kept for shells that still pass it; Sidebar no longer renders it.
export type SidebarIdentity = {
  name: string;
  initials: string;
  tenant: string;
  role: string;
  date?: Date;
};

export type SidebarAction = {
  title: string;
  subtitle?: string;
  onClick?: () => void;
  href?: string;
  tone?: "accent" | "red";
};

export function Sidebar({
  nav,
  collapsed,
  onToggleCollapse,
  mobileOpen = false,
  onMobileClose,
}: {
  nav: FinixNavItem[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const pathname = usePathname();

  // Build ordered group list preserving insertion order.
  const groups = React.useMemo(() => {
    const map = new Map<string, FinixNavItem[]>();
    for (const item of nav) {
      const g = item.group ?? "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(item);
    }
    return Array.from(map.entries());
  }, [nav]);

  return (
    <aside
      className={cn(
        // Base
        "fx-sidebar flex h-screen shrink-0 flex-col overflow-hidden",
        // Mobile: fixed drawer overlay
        "fixed top-0 left-0 z-50",
        // Desktop: sticky in flow, auto z-index
        "md:sticky md:top-0 md:z-auto",
        // Slide transition (mobile) + width transition (desktop)
        "transition-[transform,width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
        // Show/hide on mobile via translate; always visible on desktop
        mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
      )}
      style={{
        width: collapsed ? 64 : 240,
        background: "var(--fx-sidebar-bg)",
        willChange: "transform, width",
      }}
    >
      {/* ── Logo + collapse button row ── */}
      <div
        className="flex h-14 shrink-0 items-center gap-3 px-3"
        style={{ borderBottom: "1px solid var(--fx-sidebar-border)" }}
      >
        {!collapsed && (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="finix-sidebar-logo shrink-0 inline-flex">
              <FinixLogo height={26} />
            </span>
            <span
              className="truncate text-[14px] font-medium"
              style={{ color: "var(--fx-sidebar-text)" }}
            >
              Finix
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-[8px] transition-colors",
            collapsed && "mx-auto",
          )}
          style={{ color: "var(--fx-sidebar-text2)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--fx-sidebar-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "")}
        >
          {collapsed ? (
            <PanelLeft className="h-[15px] w-[15px]" />
          ) : (
            <PanelLeftClose className="h-[15px] w-[15px]" />
          )}
        </button>
      </div>

      {/* ── Grouped nav ── */}
      <nav className="flex flex-1 flex-col overflow-y-auto py-3">
        {groups.map(([groupLabel, items]) => (
          <div key={groupLabel || "__ungrouped"} className={cn("px-2", groupLabel && "mb-1")}>
            {/* Group label — shown only when expanded */}
            {groupLabel && !collapsed && (
              <div
                className="mb-1 px-2 py-0.5 text-[10px] font-semibold uppercase"
                style={{
                  color: "var(--fx-sidebar-text2)",
                  letterSpacing: "0.11em",
                  opacity: 0.7,
                }}
              >
                {groupLabel}
              </div>
            )}

            {items.map((item) => {
              const active =
                item.href === pathname ||
                (item.href !== "/" && pathname?.startsWith(item.href));

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  // Close mobile drawer on nav
                  onClick={() => onMobileClose?.()}
                  className="relative flex h-10 items-center gap-3 rounded-[8px] px-2.5 text-[13px] transition-colors"
                  style={
                    active
                      ? {
                          background: "var(--fx-sidebar-bg2)",
                          color: "var(--fx-sidebar-text)",
                          boxShadow: "inset 3px 0 0 var(--fx-sidebar-accent)",
                        }
                      : { color: "var(--fx-sidebar-text2)" }
                  }
                  onMouseEnter={(e) => {
                    if (!active) {
                      e.currentTarget.style.background = "var(--fx-sidebar-hover)";
                      e.currentTarget.style.color = "var(--fx-sidebar-text)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!active) {
                      e.currentTarget.style.background = "";
                      e.currentTarget.style.color = "var(--fx-sidebar-text2)";
                    }
                  }}
                >
                  {/* Glyph — centred in collapsed mode */}
                  <span
                    className={cn(
                      "grid shrink-0 place-items-center text-[13px]",
                      collapsed ? "w-full" : "w-4",
                    )}
                    aria-hidden
                  >
                    {item.glyph}
                  </span>

                  {!collapsed && (
                    <>
                      <span className="truncate">{item.label}</span>
                      {item.count != null && (
                        <span
                          className="ml-auto text-[11px]"
                          style={{ color: "var(--fx-sidebar-text2)" }}
                        >
                          {item.count}
                        </span>
                      )}
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
