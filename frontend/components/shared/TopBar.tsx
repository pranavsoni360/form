"use client";

import { usePathname } from "next/navigation";
import { Bell, ChevronRight, Moon, Sun } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { ConnectionDot } from "./ConnectionDot";

/**
 * VirtualVaani-style top bar.
 *
 * Left:  breadcrumb path derived from the pathname (Admin › Dashboard)
 * Right: SSE connection dot · theme toggle · notification bell · user avatar pill
 */
export function TopBar({ title }: { title?: string }) {
  const pathname = usePathname();
  const crumbs = derivedCrumbs(pathname || "/ops");

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border bg-card/80 px-8 backdrop-blur-md">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.href + i}>
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span
              className={cn(
                i === crumbs.length - 1
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {c.label}
            </span>
          </React.Fragment>
        ))}
        {title && (
          <span className="ml-3 hidden border-l border-border pl-3 text-xs text-muted-foreground lg:inline">
            {title}
          </span>
        )}
      </nav>

      {/* Right actions */}
      <div className="ml-auto flex items-center gap-2">
        <ConnectionDot className="mr-1 hidden lg:inline-flex" />

        <ThemeToggle />

        <button
          aria-label="Notifications"
          className="relative grid h-9 w-9 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Bell className="h-4 w-4" />
          <span
            className="absolute right-2 top-2 grid h-2 w-2 place-items-center rounded-full bg-destructive ring-2 ring-card"
            aria-hidden
          />
        </button>

        {/* User avatar pill */}
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-2 py-1.5 pr-3">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/15 text-xs font-bold text-primary ring-1 ring-primary/30">
            U
          </span>
          <span className="text-xs font-semibold">Admin</span>
        </div>
      </div>
    </header>
  );
}

/* ─── Breadcrumb helper ───────────────────────────────────────────────────── */

function derivedCrumbs(pathname: string): { href: string; label: string }[] {
  const parts = pathname.split("/").filter(Boolean);
  // /ops → ["ops"] → "Admin › Dashboard"
  // /ops/live → ["ops","live"] → "Admin › Live Calls"
  if (parts[0] === "ops") {
    const root = { href: "/ops", label: "Admin" };
    if (parts.length === 1) return [root, { href: "/ops", label: "Dashboard" }];
    const last = parts[parts.length - 1];
    return [root, { href: pathname, label: prettify(last) }];
  }
  // Fallback for any other route — Title Case each segment
  let acc = "";
  return parts.map((p) => {
    acc += "/" + p;
    return { href: acc, label: prettify(p) };
  });
}

function prettify(s: string): string {
  return s
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ─── Theme toggle ────────────────────────────────────────────────────────── */

function ThemeToggle() {
  const [isDark, setIsDark] = React.useState(false);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
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
    } catch {
      /* localStorage unavailable — toggle still works for the session */
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="grid h-9 w-9 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
