"use client";

// Shared shell for the bank admin portal (users / usage / audit / settings).
// Guards on a bank_admin token, fetches identity from /me, then renders the
// Finix shell with the portal nav. Each screen composes its content inside
// <BankAdminShell>.
//
// The identity card has moved out of the sidebar into the AppBar's UserMenu
// (spec §1.1). The sidebar action card (Invite user) has been removed (§2.2).

import * as React from "react";
import { useRouter } from "next/navigation";
import { getAccessToken, logout } from "@/lib/auth";
import { getMe } from "@/lib/api/bank";
import { FinixShell, SessionTimer, type FinixNavItem } from "@/components/finix";
import { BankNotificationBell } from "@/components/audit/BankNotificationBell";

// Nav items carry a `group` so the sidebar can render section labels.
// Manage: day-to-day admin tasks. Insight: read-only reporting.
const NAV: FinixNavItem[] = [
  { href: "/bank/admin/users",    label: "Users",                   glyph: "◎", group: "Manage"  },
  { href: "/bank/admin/settings", label: "Settings",                glyph: "⚙", group: "Manage"  },
  { href: "/bank/admin/usage",    label: "Usage & call statistics", glyph: "∿", group: "Insight" },
  { href: "/bank/admin/audit",    label: "Audit trail",             glyph: "⚿", group: "Insight" },
  { href: "/bank/scorecard",      label: "Scorecard",               glyph: "▦", group: "Insight" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function BankAdminShell({ children, headerActions }: { children: React.ReactNode; headerActions?: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = React.useState<any>(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const token = getAccessToken("bank");
    if (!token) {
      router.replace("/bank/login");
      return;
    }
    // Role is confirmed server-side via /me before ANY admin chrome renders —
    // a supervisor/officer must never see the admin portal, even for a frame.
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

  if (!ready) {
    return (
      <div className="finix-root grid min-h-screen place-items-center text-[13px] text-fx-text3">
        Loading…
      </div>
    );
  }

  const doLogout = () => {
    logout("bank");
    router.replace("/bank/login");
  };

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
      identityFooter={<SessionTimer onLogout={doLogout} />}
      onLogout={doLogout}
      headerRight={
        <div className="flex items-center gap-2">
          {headerActions}
          <BankNotificationBell auditHref="/bank/admin/audit" />
        </div>
      }
    >
      {children}
    </FinixShell>
  );
}
