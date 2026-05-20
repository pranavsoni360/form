"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  AlertOctagon,
  BarChart3,
  Layers,
  PhoneCall,
  Radio,
  Users,
  Mic,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Optional grouping header above this item */
  group?: string;
};

const NAV: ReadonlyArray<NavItem> = [
  { group: "Operations", href: "/ops", label: "Overview", icon: BarChart3 },
  { href: "/ops/live", label: "Live Calls", icon: Radio },
  { href: "/ops/phones", label: "Phone Pool", icon: PhoneCall },
  { href: "/ops/workers", label: "Workers", icon: Users },
  { href: "/ops/errors", label: "Errors", icon: AlertOctagon },
  { href: "/ops/funnel", label: "Funnel", icon: Activity },
  { href: "/ops/recordings", label: "Recordings", icon: Mic },
];

export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <aside
      className={cn(
        "flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-card/40 px-3 py-5",
        className
      )}
    >
      {/* Logo / brand */}
      <Link
        href="/ops"
        className="mb-4 flex items-center gap-2.5 px-3 py-1.5"
        aria-label="LOS Ops home"
      >
        <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/15 ring-1 ring-primary/30">
          <Layers className="h-4 w-4 text-primary" />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">LOS Ops</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Console
          </div>
        </div>
      </Link>

      <nav className="flex flex-col gap-0.5">
        {NAV.map((item) => {
          const isActive =
            item.href === "/ops"
              ? pathname === "/ops"
              : pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <div key={item.href}>
              {item.group && (
                <div className="mb-1 mt-3 px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {item.group}
                </div>
              )}
              <Link
                href={item.href}
                className={cn(
                  "group flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-card hover:text-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                  )}
                />
                <span>{item.label}</span>
                {isActive && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                )}
              </Link>
            </div>
          );
        })}
      </nav>

      <div className="mt-auto px-3 py-3 text-[10px] text-muted-foreground">
        <div className="font-mono">v{process.env.NEXT_PUBLIC_APP_VERSION || "dev"}</div>
      </div>
    </aside>
  );
}
