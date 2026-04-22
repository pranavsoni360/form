import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { motion } from 'motion/react'
import { useAuth } from '../contexts/AuthContext'
import { ThemeToggle } from '../components/ThemeToggle'

type Tab = 'bank' | 'vendor' | 'customer'

export default function LoginPage({ mode = 'portal' }: { mode?: 'portal' | 'admin' }) {
  const { user, loading, loginAdmin, loginPortal } = useAuth()
  const location = useLocation()
  const [tab, setTab] = useState<Tab>('bank')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!loading && user) {
    if (user.role === 'admin') return <Navigate to="/admin" replace />
    return <Navigate to="/portal" replace state={{ from: location }} />
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (mode === 'admin') {
        await loginAdmin(username, password)
      } else if (tab === 'customer') {
        setError('Customer portal is coming soon.')
        return
      } else {
        await loginPortal(username, password, tab)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setSubmitting(false)
    }
  }

  const isAdmin = mode === 'admin'
  const customerDisabled = tab === 'customer'

  return (
    <div className="flex min-h-screen w-full bg-[var(--color-page)]">
      {/* Left panel — brand */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-10 bg-gradient-to-br from-[var(--color-brand)]/10 via-[var(--color-brand-glow)] to-[var(--color-surface)]">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--color-brand)] flex items-center justify-center text-white font-bold text-sm">L</div>
          <span className="font-semibold tracking-tight text-[var(--color-heading)]">LOS</span>
        </div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <h1 className="text-4xl font-bold text-[var(--color-heading)] leading-tight max-w-md">
            Loan origination, <span className="text-[var(--color-brand)]">end-to-end</span>.
          </h1>
          <p className="mt-4 text-[var(--color-muted)] max-w-md">
            Review applications, call prospects, and disburse loans from a single, tenant-aware workspace.
          </p>
          <div className="mt-10 grid grid-cols-3 gap-4 max-w-md">
            {[
              { label: 'Banks', value: 'Client portal' },
              { label: 'Vendors', value: 'Storefront portal' },
              { label: 'AI Agent', value: 'Live transcripts' },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
                <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{s.label}</div>
                <div className="mt-1 text-sm font-medium text-[var(--color-heading)]">{s.value}</div>
              </div>
            ))}
          </div>
        </motion.div>
        <div className="text-xs text-[var(--color-muted)]">© LOS · Multi-tenant LOS v3</div>
      </div>

      {/* Right panel — form */}
      <div className="flex w-full lg:w-1/2 items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="flex justify-end mb-6"><ThemeToggle /></div>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-8 shadow-sm">
            <h2 className="text-2xl font-semibold text-[var(--color-heading)]">
              {isAdmin ? 'Admin console' : 'Welcome back'}
            </h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {isAdmin ? 'Sign in to manage banks, vendors and system settings.' : 'Sign in to the LOS portal.'}
            </p>

            {!isAdmin && (
              <div role="tablist" className="mt-6 grid grid-cols-3 rounded-lg border border-[var(--color-line)] p-1 bg-[var(--color-faint)]">
                {(['bank', 'vendor', 'customer'] as Tab[]).map((t) => (
                  <button
                    type="button"
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      tab === t
                        ? 'bg-[var(--color-surface)] text-[var(--color-brand)] shadow-sm'
                        : 'text-[var(--color-muted)] hover:text-[var(--color-heading)]'
                    }`}
                  >
                    {t === 'bank' ? 'Bank' : t === 'vendor' ? 'Vendor' : 'Customer'}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="block">
                <span className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">
                  {customerDisabled ? 'Phone' : 'Username'}
                </span>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={customerDisabled}
                  placeholder={isAdmin ? 'admin' : customerDisabled ? '+91 99999 99999' : 'your-username'}
                  className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2.5 text-[var(--color-heading)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] disabled:opacity-50"
                  autoComplete="username"
                  required={!customerDisabled}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wide">
                  {customerDisabled ? 'OTP (coming soon)' : 'Password'}
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={customerDisabled}
                  placeholder="••••••••"
                  className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2.5 text-[var(--color-heading)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] disabled:opacity-50"
                  autoComplete="current-password"
                  required={!customerDisabled}
                />
              </label>

              {customerDisabled && (
                <div className="rounded-lg bg-[var(--color-brand-dim)] px-3 py-2 text-sm text-[var(--color-brand)]">
                  Customer self-service portal is coming soon. Please use the link you received over WhatsApp.
                </div>
              )}
              {error && (
                <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || customerDisabled}
                className="w-full rounded-lg bg-[var(--color-brand)] px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[var(--color-brand-hover)] disabled:opacity-60 transition-colors"
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <p className="mt-6 text-center text-xs text-[var(--color-muted)]">
              {isAdmin ? (
                <>Not an admin? <a className="text-[var(--color-brand)] hover:underline" href="/login">Go to portal</a></>
              ) : (
                <>Developer admin? <a className="text-[var(--color-brand)] hover:underline" href="/admin/login">Sign in here</a></>
              )}
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  )
}
