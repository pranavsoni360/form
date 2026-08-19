"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Banknote,
  Briefcase,
  LayoutDashboard,
  LogOut,
  Menu,
  X,
} from "lucide-react";

import { clearAuth, getCurrentUser } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { FinixLogoMark } from "@/components/shared/FinixLogo";

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
  const [navOpen, setNavOpen] = React.useState(false);
  React.useEffect(() => setUser(getCurrentUser("vendor")), []);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => setNavOpen(false), [pathname]);

  // Lock body scroll + Escape-to-close while the mobile drawer is open.
  React.useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [navOpen]);

  const logout = () => {
    clearAuth("vendor");
    window.location.href = "/vendor/login";
  };

  const Brand = (
    <Link href="/vendor/dashboard" className="flex items-center gap-3 px-5 py-5">
      <FinixLogoMark size={30} shieldColor="#1B2A4A" className="shrink-0" />
      <div className="leading-tight">
        <div className="text-[11px] font-bold uppercase tracking-wider">Finix</div>
        <div className="text-sm font-semibold">Vendor Portal</div>
      </div>
    </Link>
  );

  const NavLinks = (
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
  );

  const UserFooter = (
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
  );

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 dark:bg-gray-950 dark:text-gray-100">
      {/* Desktop sidebar — hidden below lg, replaced by the drawer */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-gray-800 dark:bg-gray-900 lg:flex">
        {Brand}
        {NavLinks}
        {UserFooter}
      </aside>

      {/* Mobile drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setNavOpen(false)} aria-hidden />
          <aside className="absolute left-0 top-0 flex h-full w-72 max-w-[85%] flex-col border-r border-slate-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between pr-3">
              {Brand}
              <button
                onClick={() => setNavOpen(false)}
                aria-label="Close navigation menu"
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {NavLinks}
            {UserFooter}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/80 px-4 py-4 backdrop-blur dark:border-gray-800 dark:bg-gray-900/80 lg:px-8">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation menu"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800 lg:hidden"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-gray-400">{subtitle}</p>}
          </div>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
