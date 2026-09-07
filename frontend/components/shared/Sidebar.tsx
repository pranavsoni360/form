"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertOctagon,
  BarChart3,
  Briefcase,
  Building2,
  CalendarClock,
  Download,
  FileText,
  ListChecks,
  Mic,
  Moon,
  PhoneCall,
  Radio,
  ShieldCheck,
  Sun,
  TrendingUp,
  Upload,
  Users,
} from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { FinixLogo } from "@/components/shared/FinixLogo";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

export type NavGroup = { label: string; items: ReadonlyArray<NavItem> };

export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Overview",
    items: [
      { href: "/ops", label: "Dashboard", icon: BarChart3 },
      { href: "/ops/live", label: "Live Calls", icon: Radio },
    ],
  },
  {
    label: "Calls",
    items: [
      { href: "/ops/calls", label: "All calls", icon: ListChecks },
      { href: "/ops/recordings", label: "Recordings", icon: Mic },
      { href: "/ops/callbacks", label: "Callbacks", icon: CalendarClock },
      { href: "/ops/analytics", label: "Analytics", icon: TrendingUp },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/ops/batch", label: "Batch calling", icon: Upload },
      { href: "/ops/exports", label: "Exports", icon: Download },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/ops/phones", label: "Phone pool", icon: PhoneCall },
      { href: "/ops/workers", label: "Workers", icon: Users },
      { href: "/ops/errors", label: "Errors", icon: AlertOctagon },
      { href: "/ops/audit", label: "Audit trail", icon: ShieldCheck },
      { href: "/ops/funnel", label: "Funnel", icon: Activity },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/admin/banks", label: "Banks", icon: Building2 },
      { href: "/admin/vendors", label: "Vendors", icon: Briefcase },
      { href: "/admin/dashboard", label: "Applications", icon: FileText },
    ],
  },
];

const FLAT_NAV = [
  { href: "/ops",            label: "Dashboard",    icon: BarChart3,    exact: true },
  { href: "/ops/live",       label: "Live calls",   icon: Radio },
  { href: "/ops/calls",      label: "All calls",    icon: ListChecks },
  { href: "/ops/batch",      label: "Batch calling",icon: Upload },
  { href: "/ops/phones",     label: "Phone pool",   icon: PhoneCall },
  { href: "/ops/callbacks",  label: "Callbacks",    icon: CalendarClock },
  { href: "/ops/funnel",     label: "Funnel",       icon: Activity },
  { href: "/ops/exports",    label: "Exports",      icon: Download },
  { href: "/ops/recordings", label: "Recordings",   icon: Mic },
  { href: "/ops/workers",    label: "Workers",      icon: Users },
  { href: "/ops/errors",     label: "Errors",       icon: AlertOctagon },
  { href: "/ops/audit",      label: "Audit trail",  icon: ShieldCheck },
  { href: "/ops/analytics",  label: "Analytics",    icon: TrendingUp },
];

function setTheme(dark: boolean) {
  try {
    if (dark) {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("los-theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("los-theme", "light");
    }
  } catch {}
}

export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const [name, setName] = React.useState("Admin");
  const [isDark, setIsDark] = React.useState(true);

  React.useEffect(() => {
    try {
      const u = localStorage.getItem("los_admin_user");
      if (u) {
        const parsed = JSON.parse(u);
        const display = parsed?.username || parsed?.email?.split("@")[0] || "Admin";
        setName(display.charAt(0).toUpperCase() + display.slice(1));
      }
    } catch {}
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    setTheme(next);
  };

  const initials = name.slice(0, 2).toUpperCase();

  return (
    <aside
      className={cn("hidden h-screen w-64 shrink-0 sticky top-0 flex-col lg:flex", className)}
      style={{
        background: "var(--fx-sidebar-bg)",
        borderRight: "1px solid var(--fx-sidebar-border)",
      }}
    >
      {/* Logo */}
      <Link href="/ops" className="flex items-center gap-3 px-5 pt-5 pb-4" aria-label="Finix Ops">
        <FinixLogo height={28} className="shrink-0" />
        <div className="leading-tight">
          <div
            className="text-[10px] uppercase tracking-[0.18em]"
            style={{ color: "var(--fx-sidebar-text2)" }}
          >
            Calling ops
          </div>
        </div>
      </Link>

      {/* User card */}
      <div
        className="mx-3 mb-4 rounded-[12px] p-3"
        style={{ background: "var(--fx-surface2)", border: "1px solid var(--fx-sidebar-border)" }}
      >
        <div className="flex items-center justify-between mb-2">
          <span
            className="w-8 h-8 rounded-[8px] flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
            style={{ background: "linear-gradient(135deg, #1A1A2E 0%, #2563EB 100%)" }}
          >
            {initials}
          </span>
          {/* Theme toggle */}
          <div
            className="flex items-center rounded-[8px] overflow-hidden"
            style={{ border: "1px solid var(--fx-border)" }}
          >
            <button
              onClick={() => { if (isDark) toggleTheme(); }}
              aria-label="Switch to light mode"
              aria-pressed={!isDark}
              className="w-7 h-7 flex items-center justify-center transition-colors"
              style={{
                background: !isDark ? "var(--fx-surface)" : "transparent",
                color: !isDark ? "var(--fx-text)" : "var(--fx-text3)",
              }}
            >
              <Sun className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => { if (!isDark) toggleTheme(); }}
              aria-label="Switch to dark mode"
              aria-pressed={isDark}
              className="w-7 h-7 flex items-center justify-center transition-colors"
              style={{
                background: isDark ? "var(--fx-surface)" : "transparent",
                color: isDark ? "var(--fx-text)" : "var(--fx-text3)",
              }}
            >
              <Moon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="text-[13px] font-medium leading-tight" style={{ color: "var(--fx-sidebar-text)" }}>
          {name}
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: "var(--fx-sidebar-text2)" }}>
          Virtual Galaxy · calling ops
        </div>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto min-h-0 px-3">
        <nav className="flex flex-col gap-0.5">
          {FLAT_NAV.map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : !!(pathname?.startsWith(item.href) && item.href !== "/ops");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="relative flex items-center gap-3 rounded-[8px] px-3 py-2 text-[13px] font-medium transition-all overflow-hidden"
                style={{
                  background: isActive ? "var(--fx-sidebar-bg2)" : "transparent",
                  color: isActive ? "var(--fx-sidebar-text)" : "var(--fx-sidebar-text2)",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = "var(--fx-sidebar-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                {isActive && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full"
                    style={{ height: "60%", background: "var(--fx-sidebar-accent)" }}
                  />
                )}
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Copyright footer */}
      <p
        className="px-5 py-4 text-[10px] leading-tight select-none"
        style={{ color: "var(--fx-text3)", borderTop: "1px solid var(--fx-sidebar-border)" }}
      >
        © 2026 Finix · Virtual Galaxy Infotech Limited
      </p>
    </aside>
  );
}
