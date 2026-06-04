import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, Phone, Layers, RefreshCcw, Mic,
  PhoneCall, TrendingDown, Download, LayoutDashboard,
  Radio, AlertTriangle, Users,
} from "lucide-react";
import { TopBar } from "./TopBar";
import { cn } from "@/lib/utils";

const OPS_NAV = [
  { label: "Dashboard",   href: "/admin/dashboard",   icon: <LayoutDashboard className="w-4 h-4" /> },
  { label: "Live",        href: "/admin/live",         icon: <Radio className="w-4 h-4" /> },
  { label: "Calls",       href: "/admin/calls",        icon: <Phone className="w-4 h-4" /> },
  { label: "Batch",       href: "/admin/batch",        icon: <Layers className="w-4 h-4" /> },
  { label: "Analytics",   href: "/admin/analytics",    icon: <BarChart3 className="w-4 h-4" /> },
  { label: "Callbacks",   href: "/admin/callbacks",    icon: <RefreshCcw className="w-4 h-4" /> },
  { label: "Recordings",  href: "/admin/recordings",   icon: <Mic className="w-4 h-4" /> },
  { label: "Phones",      href: "/admin/phones",       icon: <PhoneCall className="w-4 h-4" /> },
  { label: "Workers",     href: "/admin/workers",      icon: <Users className="w-4 h-4" /> },
  { label: "Funnel",      href: "/admin/funnel",       icon: <TrendingDown className="w-4 h-4" /> },
  { label: "Exports",     href: "/admin/exports",      icon: <Download className="w-4 h-4" /> },
  { label: "Errors",      href: "/admin/errors",       icon: <AlertTriangle className="w-4 h-4" /> },
] as const;

function OpsSidebar() {
  const pathname = usePathname();
  return (
    <aside className="fixed left-0 top-0 h-screen w-56 flex flex-col z-30 border-r border-border bg-card">
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-border">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center brand-gradient">
          <span className="text-white font-bold text-xs">VV</span>
        </div>
        <div>
          <p className="text-[10px] font-medium text-muted-foreground tracking-widest">VIRTUALVAANI</p>
          <p className="text-sm font-semibold text-foreground">Ops Portal</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {OPS_NAV.map(item => {
          const active = item.href === "/admin/dashboard"
            ? pathname === "/admin/dashboard" || pathname === "/admin"
            : pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

/**
 * VirtualVaani-style two-column shell: persistent sidebar + sticky top bar +
 * cream-toned main content with a subtle dot grid overlay.
 *
 * Used by every /ops/* route.
 */
export function AppShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <OpsSidebar />
      <div className="flex min-w-0 flex-1 flex-col ml-56">
        <TopBar title={subtitle} />
        <main className="bg-dotgrid relative flex-1 px-8 py-7">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
