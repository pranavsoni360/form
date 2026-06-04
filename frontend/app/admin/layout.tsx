'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { getAccessToken } from '@/lib/auth';

/**
 * Layout for all /admin/* routes.
 *
 * Auth gate: admin JWT required for every route except /admin/login.
 * Unauthenticated visitors are bounced to /admin/login?redirect=<original-path>
 * so after login they land exactly where they tried to go.
 *
 * Each page is responsible for its own chrome — the ops-style pages render
 * <AppShell> (sidebar + topbar), while the legacy admin pages (banks, vendors,
 * applications) bring their own minimal nav.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const isLogin  = pathname === '/admin/login';

  const [status, setStatus] = React.useState<'checking' | 'authed' | 'redirecting'>('checking');

  React.useEffect(() => {
    if (isLogin) {
      setStatus('authed');
      return;
    }
    const token = getAccessToken('admin');
    if (!token) {
      setStatus('redirecting');
      const dest = pathname && pathname.startsWith('/admin') ? pathname : '/admin/dashboard';
      router.replace(`/admin/login?redirect=${encodeURIComponent(dest)}`);
      return;
    }
    setStatus('authed');
  }, [router, pathname, isLogin]);

  // Login page renders without any chrome or auth wrapper
  if (isLogin) return <>{children}</>;

  if (status !== 'authed') {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-muted-foreground">
        <div className="text-sm">
          {status === 'checking' ? 'Verifying admin session…' : 'Redirecting to login…'}
        </div>
      </div>
    );
  }

  return <ErrorBoundary>{children}</ErrorBoundary>;
}
