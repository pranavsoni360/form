import { useLocation } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'
import { useAuth } from '../contexts/AuthContext'

export function Topbar() {
  const location = useLocation()
  const { user } = useAuth()
  const parts = location.pathname.split('/').filter(Boolean)
  const initials = (user?.name || user?.username || '?')
    .split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <header className="h-14 flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-elevated)] px-4 md:px-6">
      <nav className="flex items-center gap-2 text-sm min-w-0">
        {parts.length === 0 ? (
          <span className="text-[var(--color-muted)]">Home</span>
        ) : (
          parts.map((p, i) => (
            <span key={i} className="flex items-center gap-2 truncate">
              {i > 0 && <span className="text-[var(--color-strong)]">/</span>}
              <span className={i === parts.length - 1 ? 'text-[var(--color-heading)] font-medium' : 'text-[var(--color-muted)]'}>
                {p.charAt(0).toUpperCase() + p.slice(1).replace(/-/g, ' ')}
              </span>
            </span>
          ))
        )}
      </nav>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <div className="h-9 w-9 rounded-full bg-[var(--color-brand-dim)] text-[var(--color-brand)] flex items-center justify-center text-xs font-semibold">
          {initials}
        </div>
      </div>
    </header>
  )
}
