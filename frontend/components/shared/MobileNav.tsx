"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { NAV_GROUPS } from "./Sidebar";

/**
 * Mobile navigation drawer for the ops/admin AppShell.
 *
 * The desktop <Sidebar> is `hidden lg:flex`, so below the `lg` breakpoint this
 * hamburger button (rendered in the TopBar) is the only way to navigate. It
 * opens a left slide-in drawer with the same NAV_GROUPS as the sidebar and
 * closes on nav-click, overlay-click, Escape, or route change.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // Close whenever the route changes (a nav link was followed).
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll + close on Escape while the drawer is open.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        className="grid h-9 w-9 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Menu className="h-4 w-4" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[70]">
          {/* Overlay */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          {/* Drawer */}
          <aside className="absolute left-0 top-0 flex h-full w-72 max-w-[85%] flex-col border-r border-border bg-card shadow-xl">
            <div className="flex items-center justify-between px-5 py-5">
              <div className="flex items-center gap-3">
                <span
                  className="grid h-10 w-10 place-items-center rounded-xl text-white shadow-sm"
                  style={{ background: "linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)" }}
                >
                  <span className="font-mono text-sm font-bold tracking-tighter">vv</span>
                </span>
                <div className="leading-tight">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-foreground">
                    Finix
                  </div>
                  <div className="text-sm font-semibold tracking-tight text-foreground">
                    Admin Portal
                  </div>
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close navigation menu"
                className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 px-3 pb-6">
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
                            "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all",
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
          </aside>
        </div>
      )}
    </div>
  );
}
