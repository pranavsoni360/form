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
  const [showPassword, setShowPassword] = useState(false)
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
                <div className="relative mt-1">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={customerDisabled}
                    placeholder="••••••••"
                    className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] pl-3 pr-10 py-2.5 text-[var(--color-heading)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] disabled:opacity-50"
                    autoComplete="current-password"
                    required={!customerDisabled}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    disabled={customerDisabled}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-[var(--color-muted)] hover:text-[var(--color-heading)] disabled:opacity-50"
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
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

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.88 9.88A3 3 0 0 0 12 15a3 3 0 0 0 2.12-.88" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}
