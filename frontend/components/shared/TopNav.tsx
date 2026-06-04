'use client';

import { useRouter, usePathname } from 'next/navigation';
import { Bell, ChevronRight, LogOut } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import { logout } from '@/lib/auth';
import { getCurrentUser } from '@/lib/auth';
import type { AuthType } from '@/lib/auth/roles';
import { LOGIN_PATHS } from '@/lib/auth/roles';

interface TopNavProps {
  authType: AuthType;
}

function getBreadcrumb(pathname: string): string[] {
  const segments = pathname.split('/').filter(Boolean);
  return segments.map(s =>
    s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ')
  );
}

const AVATAR_COLORS: Record<AuthType, string> = {
  bank:   '#2563EB',
  vendor: '#059669',
  admin:  '#7C3AED',
};

export default function TopNav({ authType }: TopNavProps) {
  const router   = useRouter();
  const pathname = usePathname();
  const user     = getCurrentUser(authType);
  const crumbs   = getBreadcrumb(pathname);
  const color    = AVATAR_COLORS[authType];

  const handleLogout = async () => {
    await logout(authType);
    router.replace(LOGIN_PATHS[authType]);
  };

  const initials = (user?.full_name || user?.username || 'U')
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <header className="h-14 flex items-center justify-between px-6 flex-shrink-0 sticky top-0 z-20"
      style={{
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
      }}>

      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5" aria-label="Breadcrumb">
        {crumbs.map((crumb, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
            <span
              className="text-sm"
              style={{
                color: i === crumbs.length - 1 ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: i === crumbs.length - 1 ? 600 : 400,
                fontFamily: 'Plus Jakarta Sans',
              }}
            >
              {crumb}
            </span>
          </div>
        ))}
      </nav>

      {/* Right side */}
      <div className="flex items-center gap-2">
        <ThemeToggle />

        {/* Bell */}
        <button className="relative w-9 h-9 rounded-xl flex items-center justify-center transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Bell className="w-4 h-4" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
            style={{ background: '#E63946' }} />
        </button>

        {/* Divider */}
        <div className="w-px h-6 mx-1" style={{ background: 'var(--border)' }} />

        {/* User */}
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl cursor-default"
            style={{ background: 'var(--bg-subtle)' }}>
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: color }}>
              <span className="text-white text-xs font-bold">{initials}</span>
            </div>
            <div className="hidden sm:block">
              <p className="text-xs font-semibold leading-none" style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                {user.full_name || user.username}
              </p>
              {user.role && (
                <p className="text-[10px] mt-0.5 capitalize" style={{ color: 'var(--text-muted)' }}>
                  {user.role.replace('bank_', '')}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="w-9 h-9 rounded-xl flex items-center justify-center transition-colors"
          style={{ color: 'var(--text-muted)' }}
          title="Sign out"
          onMouseEnter={e => {
            e.currentTarget.style.background = '#FEF2F2';
            e.currentTarget.style.color = '#DC2626';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}