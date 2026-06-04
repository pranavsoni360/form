'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';

export interface NavItem {
  label:    string;
  href:     string;
  icon:     React.ReactNode;
  badge?:   string;
}

interface SidebarProps {
  items:       NavItem[];
  portalName:  string;
  portalColor: string;
  authType:    'bank' | 'vendor' | 'admin';
}

const PORTAL_CONFIG = {
  bank:   { accent: '#2563EB', label: 'Bank Portal',   abbr: 'B' },
  vendor: { accent: '#059669', label: 'Vendor Portal', abbr: 'V' },
  admin:  { accent: '#7C3AED', label: 'Admin Portal',  abbr: 'A' },
};

export default function Sidebar({ items, portalName, authType }: SidebarProps) {
  const pathname = usePathname();
  const config   = PORTAL_CONFIG[authType];

  return (
    <aside className="fixed left-0 top-0 h-screen w-60 flex flex-col z-30"
      style={{ background: 'var(--bg-card)', borderRight: '1px solid var(--border)' }}>

      {/* Logo / Brand */}
      <div className="px-5 py-5" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-3">
          {/* Logo mark */}
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 brand-gradient">
            <span className="text-white font-bold text-sm" style={{ fontFamily: 'Plus Jakarta Sans' }}>
              VV
            </span>
          </div>
          <div>
            <p className="text-xs font-medium" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
              VIRTUALVAANI
            </p>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
              {portalName}
            </p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        <p className="section-label mb-2">Navigation</p>
        {items.map(item => {
          const active = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn('nav-item', active && 'active')}
            >
              <span className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.badge && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full"
                  style={{ background: config.accent + '20', color: config.accent }}>
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom — portal tag */}
      <div className="px-4 py-4" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 px-2 py-2 rounded-xl"
          style={{ background: 'var(--bg-subtle)' }}>
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: config.accent }}>
            <span className="text-white text-[10px] font-bold">{config.abbr}</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
              {config.label}
            </p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              VirtualVaani LOS v1.0
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}