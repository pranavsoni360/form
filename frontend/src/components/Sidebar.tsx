import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

type NavItem = { to: string; label: string; icon: string }

const adminNav: NavItem[] = [
  { to: '/admin',              label: 'Dashboard',    icon: 'grid' },
  { to: '/admin/banks',        label: 'Banks',        icon: 'building' },
  { to: '/admin/vendors',      label: 'Vendors',      icon: 'store' },
  { to: '/admin/applications', label: 'Applications', icon: 'file' },
  { to: '/admin/calls',        label: 'Calls',        icon: 'phone' },
]

const bankNav: NavItem[] = [
  { to: '/portal',              label: 'Dashboard',    icon: 'grid' },
  { to: '/portal/applications', label: 'Applications', icon: 'file' },
  { to: '/portal/vendors',      label: 'Vendors',      icon: 'store' },
  { to: '/portal/calls',        label: 'Calls',        icon: 'phone' },
]

const vendorNav: NavItem[] = [
  { to: '/portal',              label: 'Dashboard',    icon: 'grid' },
  { to: '/portal/applications', label: 'Applications', icon: 'file' },
  { to: '/portal/calls',        label: 'Calls',        icon: 'phone' },
]

function Icon({ name }: { name: string }) {
  const common = { width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (name) {
    case 'grid':     return <svg {...common} viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
    case 'building': return <svg {...common} viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 21V9M15 21V9M4 9h16"/></svg>
    case 'store':    return <svg {...common} viewBox="0 0 24 24"><path d="M3 7l2-4h14l2 4M3 7v13h18V7M3 7h18M9 21V11h6v10"/></svg>
    case 'file':     return <svg {...common} viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    case 'phone':    return <svg {...common} viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/></svg>
    default: return null
  }
}

export function Sidebar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const items = user?.role === 'admin' ? adminNav : user?.role === 'bank_user' ? bankNav : vendorNav

  return (
    <aside className="hidden md:flex w-60 flex-col border-r border-[var(--color-line)] bg-[var(--color-sidebar)]">
      <div className="flex h-14 items-center gap-2 px-5 border-b border-[var(--color-line)]">
        <div className="h-8 w-8 rounded-lg bg-[var(--color-brand)] flex items-center justify-center text-white font-bold text-sm">L</div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold tracking-tight text-[var(--color-heading)]">LOS</span>
          <span className="text-[10px] uppercase text-[var(--color-muted)] tracking-wider">
            {user?.role === 'admin' ? 'Admin' : user?.role === 'bank_user' ? 'Bank portal' : 'Vendor portal'}
          </span>
        </div>
      </div>
      <nav className="flex-1 py-4 px-2 space-y-0.5">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/admin' || item.to === '/portal'}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-[var(--color-sidebar-active)] text-[var(--color-brand)] font-medium'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-heading)] hover:bg-[var(--color-sidebar-hover)]'
              }`
            }
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="p-2 border-t border-[var(--color-line)]">
        <div className="px-3 py-2 text-xs">
          <div className="text-[var(--color-heading)] font-medium truncate">{user?.name || user?.username}</div>
          <div className="text-[var(--color-muted)] truncate">
            {user?.role === 'bank_user' && user?.bank_code}
            {user?.role === 'vendor_user' && `${user?.bank_code} · ${user?.vendor_code}`}
            {user?.role === 'admin' && 'Administrator'}
          </div>
        </div>
        <button
          type="button"
          onClick={async () => { await logout(); navigate(user?.role === 'admin' ? '/admin/login' : '/login') }}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--color-muted)] hover:text-red-500 hover:bg-[var(--color-sidebar-hover)] transition-colors"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
