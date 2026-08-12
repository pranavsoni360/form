"use client";

// Shared shell for the bank admin portal (users / usage / settings). Guards on
// a bank_admin token, fetches identity from /me, and renders the Finix shell
// with the portal nav. Each screen composes its content inside <BankAdminShell>.

import * as React from "react";
import { useRouter } from "next/navigation";
import { getAccessToken, getCurrentUser, logout } from "@/lib/auth";
import { getMe } from "@/lib/api/bank";
import { FinixShell, type FinixNavItem, type SidebarAction } from "@/components/finix";

const NAV: FinixNavItem[] = [
  { href: "/bank/admin/users", label: "Users", glyph: "◎" },
  { href: "/bank/admin/usage", label: "Usage & call statistics", glyph: "∿" },
  { href: "/bank/admin/settings", label: "Settings", glyph: "⚙" },
  { href: "/bank/scorecard", label: "Scorecard", glyph: "▦" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function BankAdminShell({
  action,
  children,
}: {
  action?: SidebarAction;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [me, setMe] = React.useState<any>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const token = getAccessToken("bank");
    if (!token) {
      router.replace("/bank/login");
      return;
    }
    // Optimistic identity from cached user; confirm role via /me.
    const cached = getCurrentUser("bank");
    if (cached) setMe(cached);
    getMe(token)
      .then((u) => {
        if (u.role !== "bank_admin") {
          router.replace("/bank/dashboard");
          return;
        }
        setMe(u);
        setReady(true);
      })
      .catch(() => {
        logout("bank");
        router.replace("/bank/login");
      });
  }, [router]);

  if (!ready && !me) {
    return (
      <div className="finix-root grid min-h-screen place-items-center text-[13px] text-fx-text3">
        Loading…
      </div>
    );
  }

  const name = me?.name || me?.full_name || "Bank admin";
  return (
    <FinixShell
      nav={NAV}
      identity={{
        name,
        initials: initialsOf(name),
        tenant: me?.bank_code || me?.bank_name || "—",
        role: "Bank admin",
      }}
      action={action}
    >
      {children}
    </FinixShell>
  );
}
