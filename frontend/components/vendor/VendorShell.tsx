"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Banknote,
  Briefcase,
  LayoutDashboard,
  LogOut,
} from "lucide-react";

import { clearAuth, getCurrentUser } from "@/lib/auth";
import { cn } from "@/lib/utils";

/**
 * Vendor portal shell — same layout shape as /ops AppShell, but with vendor-
 * specific nav (Dashboard / Applications / Settlements) and emerald accent
 * to signal "NBFC partner" surface, not bank-internal.
 *
 * Kept separate from /components/shared/Sidebar (which is admin/ops-bound)
 * so changes here don't ripple into operations dashboards.
 */

const NAV = [
  { href: "/vendor/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/vendor/applications", label: "Applications", icon: Briefcase },
  { href: "/vendor/settlements", label: "Settlements", icon: Banknote },
];

export function VendorShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [user, setUser] = React.useState<any>(null);
  React.useEffect(() => setUser(getCurrentUser("vendor")), []);

  const logout = () => {
    clearAuth("vendor");
    window.location.href = "/vendor/login";
  };

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 dark:bg-gray-950 dark:text-gray-100">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <Link href="/vendor/dashboard" className="flex items-center gap-3 px-5 py-5">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm">
            <Banknote className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <div className="text-[11px] font-bold uppercase tracking-wider">VirtualVaani</div>
            <div className="text-sm font-semibold">Vendor Portal</div>
          </div>
        </Link>

        <nav className="flex-1 px-3 py-2">
          <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Navigation
          </div>
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname?.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                  active
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-700 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-800",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 px-4 py-3 dark:border-gray-800">
          {user && (
            <div className="mb-2 text-xs text-slate-500 dark:text-gray-400">
              <div className="truncate font-medium text-slate-800 dark:text-gray-200">
                {user.name || user.username}
              </div>
              <div className="truncate">{user.vendor_name}</div>
            </div>
          )}
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 px-8 py-4 backdrop-blur dark:border-gray-800 dark:bg-gray-900/80">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-gray-400">{subtitle}</p>}
        </header>
        <main className="flex-1 px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
