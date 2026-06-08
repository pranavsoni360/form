'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { adminLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { Loader2, AlertTriangle, User, Lock, Shield, BarChart3, Settings } from 'lucide-react';

export default function AdminLoginPage() {
  return <Suspense><AdminLoginInner /></Suspense>;
}

function AdminLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    <div className="min-h-screen flex">

      {/* ── LEFT PANEL ── */}
      <div className="hidden lg:flex flex-col justify-between w-[46%] p-12 relative overflow-hidden select-none"
        style={{ background: 'linear-gradient(160deg, #0A1628 0%, #0F2040 50%, #0A1628 100%)' }}>

        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

        <div className="relative z-10 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-white text-sm flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.15)', fontFamily: 'var(--font-heading)' }}>
            vv
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-white opacity-90" style={{ fontFamily: 'var(--font-heading)' }}>VirtualVaani</div>
            <div className="text-[11px] text-white opacity-40" style={{ fontFamily: 'var(--font-body)' }}>Admin Portal</div>
          </div>
        </div>

        <div className="relative z-10">
          <h1 className="text-[2.75rem] font-bold leading-[1.1] text-white mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
            Manage the entire<br />lending operations<br />
            <span style={{ color: '#60A5FA' }}>efficiently.</span>
          </h1>
          <p className="text-base leading-relaxed mb-10" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-body)' }}>
            Full system access across all banks, agents, and workflows from one operations dashboard.
          </p>
          <div className="space-y-3.5">
            {[
              { icon: BarChart3, text: 'Real-time ops console — live calls, errors, workers' },
              { icon: Shield,    text: 'Multi-bank management with vendor partnerships' },
              { icon: Settings,  text: 'System configuration and user administration' },
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
          © 2026 VirtualVaani · Authorized personnel only
        </p>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 flex items-center justify-center p-8 lg:p-16 relative" style={{ background: '#fff' }}>
        <div className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(circle, #CBD5E1 1px, transparent 1px)', backgroundSize: '24px 24px', opacity: 0.4 }} />

        <div className="w-full max-w-sm relative z-10">
          <div className="mb-6">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
              style={{ background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
              <Shield className="w-6 h-6" style={{ color: '#2563EB' }} />
            </div>
            <h1 className="text-2xl font-bold mb-1" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>Admin Portal</h1>
            <p className="text-sm" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>Sign in to the operations dashboard</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151', fontFamily: 'var(--font-body)' }}>
                Email Address <span style={{ color: '#DC2626' }}>*</span>
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9CA3AF' }} />
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{ border: '1px solid #E5E7EB', background: '#fff', fontFamily: 'var(--font-body)', color: '#111827' }}
                  onFocus={e => { e.target.style.borderColor = '#1D4ED8'; e.target.style.boxShadow = '0 0 0 3px rgba(29,78,216,0.08)'; }}
                  onBlur={e => { e.target.style.borderColor = '#E5E7EB'; e.target.style.boxShadow = 'none'; }}
                  placeholder="admin@bank.com" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151', fontFamily: 'var(--font-body)' }}>
                Password <span style={{ color: '#DC2626' }}>*</span>
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9CA3AF' }} />
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{ border: '1px solid #E5E7EB', background: '#fff', fontFamily: 'var(--font-body)', color: '#111827' }}
                  onFocus={e => { e.target.style.borderColor = '#1D4ED8'; e.target.style.boxShadow = '0 0 0 3px rgba(29,78,216,0.08)'; }}
                  onBlur={e => { e.target.style.borderColor = '#E5E7EB'; e.target.style.boxShadow = 'none'; }}
                  placeholder="••••••••" />
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
              style={{ background: '#1D4ED8', fontFamily: 'var(--font-heading)', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1E40AF')}
              onMouseLeave={e => (e.currentTarget.style.background = '#1D4ED8')}>
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Signing in...</> : 'Sign in to Admin Portal'}
            </button>
          </form>

          <p className="text-xs text-center mt-6" style={{ color: '#9CA3AF', fontFamily: 'var(--font-body)' }}>
            Authorized personnel only
          </p>
        </div>
      </div>
    </div>
  );
}
