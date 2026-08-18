'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { adminLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { Loader2, AlertTriangle, User, Lock, Shield, BarChart3, Settings, Eye, EyeOff, Radio } from 'lucide-react';

export default function AdminLoginPage() {
  return <Suspense><AdminLoginInner /></Suspense>;
}

function AdminLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const safeRedirect = (raw: string | null): string => {
    if (!raw) return '/ops';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/ops';
    if (raw === '/ops' || raw.startsWith('/ops/') || raw === '/admin/dashboard' || raw.startsWith('/admin/banks') || raw.startsWith('/admin/applications')) return raw;
    return '/ops';
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await adminLogin(email, password);
      setAccessToken('admin', response.token);
      setCurrentUser('admin', response.user);
      router.push(safeRedirect(searchParams.get('redirect')));
    } catch (err: any) {
      setError(err.message || 'Invalid credentials. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex" style={{ background: '#06090F' }}>

      {/* ── LEFT PANEL ── */}
      <div className="hidden lg:flex flex-col justify-between w-[46%] p-12 relative overflow-hidden select-none"
        style={{ background: '#060A16', borderRight: '1px solid rgba(255,255,255,0.05)' }}>

        {/* Subtle dot grid */}
        <div className="absolute inset-0 opacity-[0.025]"
          style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '28px 28px' }} />

        {/* Aurora glows */}
        <div className="absolute pointer-events-none"
          style={{ top: '25%', left: '30%', width: '420px', height: '420px', transform: 'translate(-50%,-50%)', background: 'radial-gradient(circle, rgba(37,99,235,0.13) 0%, transparent 70%)', borderRadius: '50%' }} />
        <div className="absolute bottom-0 right-0 pointer-events-none"
          style={{ width: '280px', height: '280px', background: 'radial-gradient(circle at 100% 100%, rgba(14,165,233,0.07) 0%, transparent 70%)', borderRadius: '50%' }} />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <svg width="30" height="34" viewBox="0 0 60 68" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M30 2L4 14v20c0 16 11 30 26 34 15-4 26-18 26-34V14L30 2z"
              stroke="white" strokeWidth="3.5" strokeLinejoin="round" fill="none" opacity="0.9" />
            <path d="M20 34l7 7 13-14" stroke="#38BDF8" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <div className="text-base font-bold text-white" style={{ fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}>Finix</div>
            <div className="text-[10px] text-white opacity-35 uppercase tracking-widest" style={{ fontFamily: 'var(--font-body)' }}>Operations Console</div>
          </div>
        </div>

        {/* Hero */}
        <div className="relative z-10">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] mb-5" style={{ color: '#3B82F6' }}>
            Internal · Authorized Access Only
          </div>
          <h1 className="text-[2.6rem] font-bold leading-[1.1] text-white mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
            Manage lending<br />operations<br />
            <span style={{ color: '#60A5FA' }}>in real time.</span>
          </h1>
          <p className="text-base leading-relaxed mb-10" style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-body)' }}>
            Unified view of live calls, worker health, lead funnels, and multi-bank workflows — all in one dashboard.
          </p>
          <div className="space-y-3.5">
            {[
              { icon: Radio,    text: 'Live call monitor — SSE-powered real-time feed' },
              { icon: BarChart3, text: 'Lead funnel analytics across all banks' },
              { icon: Shield,   text: 'Role-gated access · multi-bank scope control' },
              { icon: Settings, text: 'Batch upload · phone pool · worker queue' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.18)' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: '#3B82F6' }} />
                </div>
                <p className="text-sm" style={{ color: 'rgba(255,255,255,0.42)', fontFamily: 'var(--font-body)' }}>{text}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs" style={{ color: 'rgba(255,255,255,0.15)', fontFamily: 'var(--font-body)' }}>
          © 2026 Finix · Virtual Galaxy Infotech Pvt. Ltd.
        </p>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 flex items-center justify-center p-8 lg:p-16 relative"
        style={{ background: '#080D1A' }}>

        {/* Dot grid */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(circle, rgba(107,141,214,0.35) 1px, transparent 1px)', backgroundSize: '24px 24px', opacity: 0.12 }} />

        {/* Glow top-right */}
        <div className="absolute top-0 right-0 pointer-events-none"
          style={{ width: '380px', height: '380px', background: 'radial-gradient(circle at 100% 0%, rgba(37,99,235,0.09) 0%, transparent 70%)' }} />

        <div className="w-full max-w-sm relative z-10">

          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-8 lg:hidden">
            <svg width="24" height="27" viewBox="0 0 60 68" fill="none">
              <path d="M30 2L4 14v20c0 16 11 30 26 34 15-4 26-18 26-34V14L30 2z"
                stroke="white" strokeWidth="3.5" strokeLinejoin="round" fill="none" opacity="0.9" />
              <path d="M20 34l7 7 13-14" stroke="#38BDF8" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-bold text-white" style={{ fontFamily: 'var(--font-heading)' }}>Finix</span>
          </div>

          {/* Glass card */}
          <div className="rounded-2xl p-8"
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.07)',
              backdropFilter: 'blur(20px)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
            }}>

            {/* Card header */}
            <div className="mb-7">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                style={{ background: 'rgba(37,99,235,0.15)', border: '1px solid rgba(37,99,235,0.25)' }}>
                <Shield className="w-5 h-5" style={{ color: '#60A5FA' }} />
              </div>
              <h1 className="text-xl font-bold mb-1" style={{ color: '#EFF4FF', fontFamily: 'var(--font-heading)' }}>
                Operations Console
              </h1>
              <p className="text-sm" style={{ color: 'rgba(255,255,255,0.32)', fontFamily: 'var(--font-body)' }}>
                Sign in with your admin credentials
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              {/* Email */}
              <div>
                <label className="block text-xs font-medium mb-1.5 uppercase tracking-[0.08em]"
                  style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-body)' }}>
                  Email Address
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'rgba(255,255,255,0.22)' }} />
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
                    className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none transition-all"
                    style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', fontFamily: 'var(--font-body)', color: '#EFF4FF' }}
                    onFocus={e => { e.target.style.borderColor = 'rgba(59,130,246,0.5)'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; e.target.style.background = 'rgba(255,255,255,0.06)'; }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.08)'; e.target.style.boxShadow = 'none'; e.target.style.background = 'rgba(255,255,255,0.04)'; }}
                    placeholder="admin@finix.in" />
                </div>
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-medium mb-1.5 uppercase tracking-[0.08em]"
                  style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-body)' }}>
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'rgba(255,255,255,0.22)' }} />
                  <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required
                    className="w-full pl-10 pr-10 py-3 rounded-xl text-sm outline-none transition-all"
                    style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', fontFamily: 'var(--font-body)', color: '#EFF4FF' }}
                    onFocus={e => { e.target.style.borderColor = 'rgba(59,130,246,0.5)'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.1)'; e.target.style.background = 'rgba(255,255,255,0.06)'; }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.08)'; e.target.style.boxShadow = 'none'; e.target.style.background = 'rgba(255,255,255,0.04)'; }}
                    placeholder="••••••••" />
                  <button type="button" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2"
                    style={{ color: 'rgba(255,255,255,0.28)' }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}>
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2.5 rounded-xl p-3"
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#F87171' }} />
                  <p className="text-sm" style={{ color: '#FCA5A5', fontFamily: 'var(--font-body)' }}>{error}</p>
                </div>
              )}

              {/* Submit */}
              <button type="submit" disabled={loading}
                className="w-full py-3 rounded-xl font-semibold text-white text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 mt-1"
                style={{
                  background: loading ? 'rgba(37,99,235,0.6)' : 'linear-gradient(135deg, #1D4ED8 0%, #2563EB 100%)',
                  boxShadow: loading ? 'none' : '0 4px 20px rgba(37,99,235,0.3)',
                  fontFamily: 'var(--font-heading)',
                }}
                onMouseEnter={e => { if (!loading) { e.currentTarget.style.background = 'linear-gradient(135deg, #1E40AF 0%, #1D4ED8 100%)'; e.currentTarget.style.boxShadow = '0 4px 24px rgba(37,99,235,0.42)'; } }}
                onMouseLeave={e => { if (!loading) { e.currentTarget.style.background = 'linear-gradient(135deg, #1D4ED8 0%, #2563EB 100%)'; e.currentTarget.style.boxShadow = '0 4px 20px rgba(37,99,235,0.3)'; } }}>
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Signing in...</> : 'Sign in to Console'}
              </button>
            </form>
          </div>

          <p className="text-xs text-center mt-5" style={{ color: 'rgba(255,255,255,0.15)', fontFamily: 'var(--font-body)' }}>
            Authorized personnel only · Virtual Galaxy Infotech
          </p>
        </div>
      </div>
    </div>
  );
}
