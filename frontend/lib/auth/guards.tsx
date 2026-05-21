// lib/auth/guards.tsx — declarative auth + role guards for portal pages.
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn, getCurrentUser } from "./index";
import { LOGIN_PATHS, DASHBOARD_PATHS } from "./roles";
import type { AuthType } from "./roles";

interface GuardProps {
  children: React.ReactNode;
  type: AuthType;
  // Optional: restrict to a specific role within a portal (e.g. only
  // 'supervisor' on a supervisor-only page).
  requiredRole?: string;
}

// ── AuthGuard — redirects to login if not authenticated ──

export function AuthGuard({ children, type, requiredRole }: GuardProps) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    if (!isLoggedIn(type)) {
      router.replace(LOGIN_PATHS[type]);
      return;
    }

    if (requiredRole) {
      const user = getCurrentUser(type);
      if (!user || user.role !== requiredRole) {
        router.replace(DASHBOARD_PATHS[type]);
        return;
      }
    }

    setAuthorized(true);
  }, [router, type, requiredRole]);

  if (!authorized) return null;
  return <>{children}</>;
}

// ── GuestGuard — redirects to dashboard if already logged in ──
// Use on login pages so authenticated users don't see the form.

export function GuestGuard({
  children,
  type,
}: {
  children: React.ReactNode;
  type: AuthType;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLoggedIn(type)) {
      router.replace(DASHBOARD_PATHS[type]);
      return;
    }
    setReady(true);
  }, [router, type]);

  if (!ready) return null;
  return <>{children}</>;
}

// ── HOC variants ──

export function withAuth<P extends object>(
  Component: React.ComponentType<P>,
  type: AuthType,
  requiredRole?: string,
) {
  return function ProtectedPage(props: P) {
    return (
      <AuthGuard type={type} requiredRole={requiredRole}>
        <Component {...props} />
      </AuthGuard>
    );
  };
}

export function withGuest<P extends object>(
  Component: React.ComponentType<P>,
  type: AuthType,
) {
  return function GuestPage(props: P) {
    return (
      <GuestGuard type={type}>
        <Component {...props} />
      </GuestGuard>
    );
  };
}
