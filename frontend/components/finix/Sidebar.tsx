"use client";

// Finix sidebar (design_handoff_finix/README.md §Sidebar).
//
// 264px expanded, 64px collapsed. Own column with 12px gutters, sticky, full
// viewport height. Composition top→bottom: logo row, identity block (avatar,
// theme pill, weekday+date, name, tenant · role), nav panel (inset, 34px items,
// glyph column, right-aligned counts, active = surface2), spacer, ONE
// accent-gradient action card, collapse row. Collapsed: only glyphs remain.

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useFinixTheme } from "./theme";
import { formatDate } from "./format";

export type FinixNavItem = {
  href: string;
  label: string;
  /** Monospace glyph stand-in; replace with a real icon set later. */
  glyph: string;
  count?: number;
};

export type SidebarIdentity = {
  name: string;
  initials: string;
  tenant: string;
  role: string;
  /** Weekday + date line. Defaults to today. */
  date?: Date;
};

export type SidebarAction = {
  title: string;
  subtitle?: string;
  onClick?: () => void;
  href?: string;
  /** Red-tinted read-only variant (e.g. quota-exceeded "Request quota increase"). */
  tone?: "accent" | "red";
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ThemePill() {
  const { theme, setTheme } = useFinixTheme();
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-fx-bg p-0.5">
      <button
        type="button"
        aria-label="Dark theme"
        aria-pressed={theme === "dark"}
        onClick={() => setTheme("dark")}
        className={cn(
          "grid h-6 w-6 place-items-center rounded-full text-[12px]",
          theme === "dark" ? "bg-fx-surface text-fx-text" : "text-fx-text3",
        )}
      >
        ☾
      </button>
      <button
        type="button"
        aria-label="Light theme"
        aria-pressed={theme === "light"}
        onClick={() => setTheme("light")}
        className={cn(
          "grid h-6 w-6 place-items-center rounded-full text-[12px]",
          theme === "light" ? "bg-fx-surface text-fx-text" : "text-fx-text3",
        )}
      >
        ☀
      </button>
    </div>
  );
}

export function Sidebar({
  nav,
  identity,
  action,
  collapsed,
  onToggleCollapse,
}: {
  nav: FinixNavItem[];
  identity: SidebarIdentity;
  action?: SidebarAction;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const pathname = usePathname();
  const date = identity.date ?? new Date();
  const dateLine = `${WEEKDAYS[date.getDay()]} · ${formatDate(date)}`;

  return (
    <aside
      className="sticky top-0 flex h-screen shrink-0 flex-col gap-3 p-3"
      style={{ width: collapsed ? 64 : 264 }}
    >
      {/* Logo row */}
      <div className="flex items-center gap-2.5 px-1">
        <span
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px] text-[15px] font-medium text-white"
          style={{ background: "var(--fx-accent-grad)", boxShadow: "var(--fx-accent-glow)" }}
        >
          F
        </span>
        {!collapsed && <span className="text-[15px] font-medium text-fx-text">Finix</span>}
      </div>

      {/* Identity block */}
      {!collapsed && (
        <div className="rounded-[14px] bg-fx-surface p-3">
          <div className="flex items-center gap-2">
            <span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-fx-surface2 text-[13px] font-medium text-fx-text">
              {identity.initials}
            </span>
            <div className="ml-auto">
              <ThemePill />
            </div>
          </div>
          <div className="mt-2 text-[11px] text-fx-text3">{dateLine}</div>
          <div className="text-[16px] font-medium text-fx-text">{identity.name}</div>
          <div className="text-[12px] text-fx-text3">
            {identity.tenant} · {identity.role}
          </div>
        </div>
      )}

      {/* Nav panel */}
      <nav className="rounded-[14px] bg-fx-surface p-2">
        {nav.map((item) => {
          const active = item.href === pathname || (item.href !== "/" && pathname?.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex h-[34px] items-center gap-2 rounded-[10px] px-2 transition-colors",
                active ? "bg-fx-surface2 text-fx-text" : "text-fx-text2 hover:bg-fx-surface2",
              )}
            >
              <span className="fx-mono grid w-[14px] shrink-0 place-items-center text-[13px]">{item.glyph}</span>
              {!collapsed && (
                <>
                  <span className="text-[13px]">{item.label}</span>
                  {item.count != null && (
                    <span className="fx-mono ml-auto text-[11px] text-fx-text3">{item.count}</span>
                  )}
                </>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* One primary action card */}
      {action && !collapsed && (
        <ActionCard action={action} />
      )}

      {/* Collapse row */}
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex h-[30px] items-center gap-2 px-2 text-fx-text3 hover:text-fx-text2"
      >
        <span className="fx-mono text-[13px]">{collapsed ? "»" : "«"}</span>
        {!collapsed && <span className="text-[13px]">Collapse</span>}
      </button>
    </aside>
  );
}

function ActionCard({ action }: { action: SidebarAction }) {
  const red = action.tone === "red";
  const inner = (
    <div
      className="rounded-[14px] p-3"
      style={
        red
          ? { background: "var(--fx-red-tint)", boxShadow: "inset 0 0 0 1px var(--fx-red)" }
          : { background: "var(--fx-accent-grad)", boxShadow: "var(--fx-accent-glow)" }
      }
    >
      <div className={cn("text-[13px] font-medium", red ? "text-fx-red" : "text-white")}>{action.title}</div>
      {action.subtitle && (
        <div className="mt-0.5 text-[11px]" style={{ color: red ? "var(--fx-red)" : "oklch(0.95 0.02 265 / 0.75)" }}>
          {action.subtitle}
        </div>
      )}
    </div>
  );
  if (action.href) return <Link href={action.href}>{inner}</Link>;
  return (
    <button type="button" onClick={action.onClick} className="w-full text-left">
      {inner}
    </button>
  );
}
