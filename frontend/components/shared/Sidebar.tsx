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
  ChevronLeft,
  Download,
  FileText,
  ListChecks,
  Mic,
  Moon,
  PhoneCall,
  Radio,
  Sun,
  TrendingUp,
  Upload,
  Users,
} from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { FinixLogoMark } from "@/components/shared/FinixLogo";

/* ─── Types (kept for MobileNav compatibility) ───────────────────────────── */

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

/* ─── Flat nav for sidebar visual ────────────────────────────────────────── */

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
  { href: "/ops/analytics",  label: "Analytics",    icon: TrendingUp },
];

/* ─── Sidebar ─────────────────────────────────────────────────────────────── */

export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const [dateStr, setDateStr] = React.useState("");
  const [name, setName] = React.useState("Admin");
  const [isDark, setIsDark] = React.useState(true);

  React.useEffect(() => {
    const d = new Date();
    const day = d.toLocaleDateString("en-GB", { weekday: "long" });
    const date = d.getDate();
    const month = d.toLocaleDateString("en-GB", { month: "short" });
    const year = d.getFullYear();
    setDateStr(`${day}, ${date} ${month} ${year}`);
  }, []);

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
    try {
      if (next) {
        document.documentElement.classList.add("dark");
        localStorage.setItem("los-theme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        localStorage.setItem("los-theme", "light");
      }
    } catch {}
  };

  const initials = name.slice(0, 2).toUpperCase();

  return (
    <aside
      className={cn(
        "hidden h-screen w-64 shrink-0 sticky top-0 flex-col lg:flex bg-card border-r border-border",
        className
      )}
    >
      {/* Logo */}
      <Link href="/ops" className="flex items-center gap-2.5 px-5 pt-5 pb-4" aria-label="Finix Ops">
        <FinixLogoMark size={30} className="text-foreground flex-shrink-0" />
        <span
          className="font-bold text-foreground text-base"
          style={{ fontFamily: "var(--font-heading)", letterSpacing: "-0.02em" }}
        >
          Finix
        </span>
      </Link>

      {/* User card */}
      <div className="mx-3 mb-4 rounded-xl p-3 bg-muted border border-border">
        <div className="flex items-center justify-between mb-2.5">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
            style={{ background: "linear-gradient(135deg, #1A1A2E 0%, #2563EB 100%)" }}
          >
            {initials}
          </span>
          <button
            onClick={toggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground"
          >
            {isDark ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
          </button>
        </div>
        {dateStr && (
          <div className="text-[10px] mb-1 leading-tight text-muted-foreground">
            {dateStr}
          </div>
        )}
        <div className="text-sm font-semibold text-foreground leading-tight">{name}</div>
        <div className="text-[11px] mt-0.5 text-muted-foreground">
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
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isActive ? "text-foreground" : "text-muted-foreground"
                  )}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>


      {/* Collapse */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs cursor-default select-none text-muted-foreground">
          <ChevronLeft className="w-3.5 h-3.5" />
          Collapse
        </div>
      </div>

      {/* Copyright */}
      <p className="px-6 pb-4 text-[10px] leading-tight text-muted-foreground select-none">
        © 2026 Finix · Virtual Galaxy Infotech Limited
      </p>
    </aside>
  );
}
