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
  LogOut,
  Mic,
  PhoneCall,
  Radio,
  TrendingUp,
  Upload,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { clearAuth } from "@/lib/auth";

/**
 * VirtualVaani-style sidebar.
 *
 * Top: "vv" logo mark + VIRTUALVAANI / Admin Portal label
 * Body: NAVIGATION section header + nav items (icon + label + active pill)
 * Bottom: user pill + LOS version stamp
 *
 * Active state matches the screenshot exactly: dark-navy filled pill,
 * white text, slightly inset radius.
 */

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

// Sidebar groups — matches the way an operator thinks about the system:
// "Show me state" (Dashboard / Live) → "Show me data" (Calls / Recordings /
// Callbacks / Analytics) → "Take action" (Batch / Exports) → "Show me the
// system" (Phones / Workers / Errors / Funnel).
type NavGroup = { label: string; items: ReadonlyArray<NavItem> };

const NAV_GROUPS: ReadonlyArray<NavGroup> = [
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
      { href: "/ops/calls", label: "All Calls", icon: ListChecks },
      { href: "/ops/recordings", label: "Recordings", icon: Mic },
      { href: "/ops/callbacks", label: "Callbacks", icon: CalendarClock },
      { href: "/ops/analytics", label: "Analytics", icon: TrendingUp },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/ops/batch", label: "Batch", icon: Upload },
      { href: "/ops/exports", label: "Exports", icon: Download },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/ops/phones", label: "Phone Pool", icon: PhoneCall },
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

export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const handleLogout = () => {
    clearAuth("admin");
    window.location.href = "/admin/login";
  };
  return (
    <aside
      className={cn(
        "flex w-64 shrink-0 flex-col border-r border-border bg-card",
        className
      )}
    >
      {/* Brand */}
      <Link
        href="/ops"
        className="flex items-center gap-3 px-5 py-5"
        aria-label="VirtualVaani Ops"
      >
        <span className="grid h-10 w-10 place-items-center rounded-xl text-white shadow-sm"
          style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)' }}>
          <span className="font-mono text-sm font-bold tracking-tighter">vv</span>
        </span>
        <div className="leading-tight">
          <div className="text-[11px] font-bold uppercase tracking-wider text-foreground">
            VirtualVaani
          </div>
          <div className="text-sm font-semibold tracking-tight text-foreground">
            Admin Portal
          </div>
        </div>
      </Link>

      {/* Navigation */}
      <div className="flex-1 px-3">
        <div className="mb-2 mt-2 px-3 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Navigation
        </div>
        <nav className="flex flex-col gap-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="space-y-0.5">
              <div className="mb-1 px-3 text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
                {group.label}
              </div>
              {group.items.map((item) => {
                const isActive =
                  item.href === "/ops"
                    ? pathname === "/ops"
                    : pathname?.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-all",
                      isActive
                        ? "bg-primary text-white shadow-sm"
                        : "text-foreground/70 hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isActive ? "text-white" : "text-muted-foreground group-hover:text-foreground"
                      )}
                    />
                    <span className="font-medium">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </div>

      {/* Footer: user pill */}
      <div className="mx-3 mb-4 mt-2 rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/15 text-xs font-bold text-primary ring-1 ring-primary/30">
            A
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-xs font-semibold">Admin Portal</div>
            <div className="text-[10px] text-muted-foreground">
              VirtualVaani LOS v1.0
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="Sign out"
            className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-destructive"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
