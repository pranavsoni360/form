"use client";

// Shared Finix shell for the bank OFFICER / SUPERVISOR screens (Job 2 migration).
// Mirrors the admin BankAdminShell but with the officer/supervisor nav and a
// logout action. Preserves every destination the old per-page header had:
// Dashboard (queue), Calls, Batch, Scorecard — plus logout.
//
// NO FEATURE LOSS: this only reframes navigation. The old header exposed
// Calls / Batch / Scorecard + Logout and a back-arrow to the dashboard; all of
// those are represented here.

import * as React from "react";
import { useRouter } from "next/navigation";
import { getAccessToken, getCurrentUser, logout } from "@/lib/auth";
import { getMe } from "@/lib/api/bank";
import { FinixShell, SessionTimer, type FinixNavItem, type SidebarAction } from "@/components/finix";
import { BankNotificationBell } from "@/components/audit/BankNotificationBell";

const NAV: FinixNavItem[] = [
  { href: "/bank/dashboard", label: "My queue", glyph: "▤" },
  { href: "/bank/calls", label: "Call logs", glyph: "✆" },
  { href: "/bank/batch", label: "Batch calling", glyph: "◫" },
  { href: "/bank/scorecard", label: "Scorecard", glyph: "▦" },
  { href: "/bank/audit", label: "Audit trail", glyph: "⚿" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function BankUserShell({
  action,
  headerActions,
  children,
}: {
  action?: SidebarAction;
  headerActions?: React.ReactNode;
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
    const cached = getCurrentUser("bank");
    getMe(token)
      .then((u) => {
        // Bank admins have their OWN portal; they must never see the officer/
        // supervisor chrome, so bounce before rendering anything.
        if (u.role === "bank_admin") {
          router.replace("/bank/admin/users");
          return;
        }
        setMe(u);
        setReady(true);
      })
      .catch(() => {
        // A transient /me failure shouldn't blank the screen — but only fall
        // back to the cached identity when it is NOT a bank_admin (else we'd
        // flash the wrong portal). Otherwise send to login.
        if (cached && cached.role !== "bank_admin") {
          setMe(cached);
          setReady(true);
        } else {
          logout("bank");
          router.replace("/bank/login");
        }
      });
  }, [router]);

  // Never render officer/supervisor chrome until the role is confirmed.
  if (!ready) {
    return (
      <div className="finix-root grid min-h-screen place-items-center text-[13px] text-fx-text3">
        Loading…
      </div>
    );
  }

  const name = me?.name || me?.full_name || "Bank user";
  const roleLabel = me?.role === "bank_supervisor" ? "Supervisor" : "Officer";

  // Default action: sign out. A screen can override with its own primary action.
  // `logout()` is async: it posts to /api/auth/logout and clears local auth
  // only after that resolves. Navigating without awaiting it could leave the
  // token in storage, so the login page could bounce straight back in.
  const doLogout = async () => {
    await logout("bank");
    router.replace("/bank/login");
  };

  const logoutAction: SidebarAction = {
    title: "Sign out",
    subtitle: me?.bank_name || undefined,
    onClick: () => {
      logout("bank");
      router.replace("/bank/login");
    },
  };

  return (
    <FinixShell
      nav={NAV}
      identity={{
        name,
        initials: initialsOf(name),
        tenant: me?.bank_code || me?.bank_name || "—",
        role: roleLabel,
      }}
      identityFooter={<SessionTimer onLogout={doLogout} />}
      // The UserMenu's "Sign out" needs this too. FinixShell defaults onLogout
      // to a no-op, so omitting it made the menu item render, highlight and
      // close — while doing nothing at all. Only SessionTimer was wired, so
      // sign-out worked on idle timeout but never when clicked.
      onLogout={doLogout}
      action={action ?? logoutAction}
      headerRight={
        <div className="flex items-center gap-2">
          {headerActions}
          <BankNotificationBell auditHref="/bank/audit" />
        </div>
      }
    >
      {children}
    </FinixShell>
  );
}
