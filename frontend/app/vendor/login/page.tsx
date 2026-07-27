"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle, User, Lock, Banknote, CheckCircle2, TrendingUp, Eye, EyeOff } from "lucide-react";
import { vendorLogin } from "@/lib/api/vendor";
import { setAccessToken, setCurrentUser } from "@/lib/auth";

export default function VendorLoginPage() {
  return (
    <React.Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-white">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#065F46' }} />
      </div>
    }>
      <VendorLoginForm />
    </React.Suspense>
  );
}

function VendorLoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirect") || "/vendor/dashboard";
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const resp = await vendorLogin(username, password);
      setAccessToken("vendor", resp.token);
      setCurrentUser("vendor", resp.user);
      router.replace(redirectTo);
    } catch (err: any) {
      setError(err?.message || "Invalid credentials. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const focusStyle = (color: string) => ({
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => { e.target.style.borderColor = color; e.target.style.boxShadow = `0 0 0 3px ${color}14`; },
    onBlur:  (e: React.FocusEvent<HTMLInputElement>) => { e.target.style.borderColor = '#E5E7EB'; e.target.style.boxShadow = 'none'; },
  });

  return (
    <div className="min-h-screen flex">

      {/* ── LEFT PANEL ── */}
      <div className="hidden lg:flex flex-col justify-between w-[46%] p-12 relative overflow-hidden select-none"
        style={{ background: 'linear-gradient(160deg, #052E16 0%, #064E3B 50%, #052E16 100%)' }}>

        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-white text-sm flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.15)', fontFamily: 'var(--font-heading)' }}>
            vv
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-white opacity-90" style={{ fontFamily: 'var(--font-heading)' }}>Finix</div>
            <div className="text-[11px] text-white opacity-40" style={{ fontFamily: 'var(--font-body)' }}>Vendor & NBFC Portal</div>
          </div>
        </div>

        {/* Hero text */}
        <div className="relative z-10">
          <h1 className="text-[2.75rem] font-bold leading-[1.1] text-white mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
            Disburse loans<br />and grow your<br />
            <span style={{ color: '#34D399' }}>lending portfolio.</span>
          </h1>
          <p className="text-base leading-relaxed mb-10" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-body)' }}>
            Access pre-approved loan applications, manage disbursements, and track settlements — all in one platform.
          </p>
          <div className="space-y-3.5">
            {[
              { icon: Banknote,      text: 'Access pre-approved loan applications' },
              { icon: CheckCircle2,  text: 'One-click disbursement workflow' },
              { icon: TrendingUp,    text: 'Track settlements and portfolio performance' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: 'rgba(255,255,255,0.5)' }} />
                </div>
                <p className="text-sm" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-body)' }}>{text}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs" style={{ color: 'rgba(255,255,255,0.2)', fontFamily: 'var(--font-body)' }}>
          © 2026 Finix · Authorized NBFC partners only
        </p>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 flex items-center justify-center p-8 lg:p-16 relative" style={{ background: '#fff' }}>
        <div className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(circle, #CBD5E1 1px, transparent 1px)', backgroundSize: '24px 24px', opacity: 0.4 }} />

        <div className="w-full max-w-sm relative z-10">

          <div className="mb-6">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
              style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
              <User className="w-6 h-6" style={{ color: '#059669' }} />
            </div>
            <h1 className="text-2xl font-bold mb-1" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>Vendor Portal</h1>
            <p className="text-sm" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>NBFC & lender access</p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151', fontFamily: 'var(--font-body)' }}>
                Username <span style={{ color: '#DC2626' }}>*</span>
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9CA3AF' }} />
                <input type="text" value={username} onChange={e => setUsername(e.target.value)} required autoFocus
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{ border: '1px solid #E5E7EB', background: '#fff', fontFamily: 'var(--font-body)', color: '#111827' }}
                  {...focusStyle('#059669')}
                  placeholder="Enter your username" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151', fontFamily: 'var(--font-body)' }}>
                Password <span style={{ color: '#DC2626' }}>*</span>
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9CA3AF' }} />
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required
                  className="w-full pl-10 pr-10 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{ border: '1px solid #E5E7EB', background: '#fff', fontFamily: 'var(--font-body)', color: '#111827' }}
                  {...focusStyle('#059669')}
                  placeholder="••••••••" />
                <button type="button" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                  className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#DC2626' }} />
                <p className="text-sm" style={{ color: '#991B1B', fontFamily: 'var(--font-body)' }}>{error}</p>
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full py-3 rounded-xl font-semibold text-white text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 mt-2"
              style={{ background: '#059669', fontFamily: 'var(--font-heading)', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#047857')}
              onMouseLeave={e => (e.currentTarget.style.background = '#059669')}>
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Signing in...</> : 'Sign in to Vendor Portal'}
            </button>
          </form>

          <p className="text-xs text-center mt-6" style={{ color: '#9CA3AF', fontFamily: 'var(--font-body)' }}>
            Contact your administrator for access
          </p>
        </div>
      </div>
    </div>
  );
}
