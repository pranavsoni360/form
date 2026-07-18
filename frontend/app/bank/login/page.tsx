'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { bankLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { Loader2, AlertTriangle, User, Lock, FileText, CheckCircle2, Clock, Eye, EyeOff } from 'lucide-react';

export default function BankLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await bankLogin(username, password);
      setAccessToken('bank', response.token);
      setCurrentUser('bank', response.user);
      router.push('/bank/dashboard');
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

        {/* Subtle texture overlay */}
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-white text-sm flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.15)', fontFamily: 'var(--font-heading)' }}>
            vv
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-white opacity-90" style={{ fontFamily: 'var(--font-heading)' }}>VirtualVaani</div>
            <div className="text-[11px] text-white opacity-40" style={{ fontFamily: 'var(--font-body)' }}>Bank Officer Portal</div>
          </div>
        </div>

        {/* Hero text */}
        <div className="relative z-10">
          <h1 className="text-[2.75rem] font-bold leading-[1.1] text-white mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
            Review and approve<br />loan applications<br />
            <span style={{ color: '#60A5FA' }}>efficiently.</span>
          </h1>
          <p className="text-base leading-relaxed mb-10" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-body)' }}>
            AI-assisted review pipeline with complete applicant profiles, document verification, and one-click approval workflows.
          </p>
          <div className="space-y-3.5">
            {[
              { icon: FileText,     text: 'View complete applicant profiles and documents' },
              { icon: CheckCircle2, text: 'Officer and supervisor approval workflow' },
              { icon: Clock,        text: 'Real-time status updates and notifications' },
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
          © 2026 VirtualVaani · Authorized bank personnel only
        </p>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 flex items-center justify-center p-8 lg:p-16 relative bg-slate-50 dark:bg-slate-950">
        {/* Dot grid */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px', opacity: 0.4 }} />
        {/* Ambient glow */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[40rem] h-[20rem] rounded-full bg-blue-400/[0.05] dark:bg-blue-400/[0.07] blur-3xl" />
        </div>

        <div className="w-full max-w-sm relative z-10">

          {/* Portal icon */}
          <div className="mb-6">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6 bg-blue-600 shadow-lg shadow-blue-600/20">
              <FileText className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold mb-1 text-slate-900 dark:text-slate-100" style={{ fontFamily: 'var(--font-heading)' }}>Bank Portal</h1>
            <p className="text-sm text-slate-400 dark:text-slate-500" style={{ fontFamily: 'var(--font-body)' }}>Sign in with your bank credentials</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-slate-700 dark:text-slate-300" style={{ fontFamily: 'var(--font-body)' }}>
                Username <span style={{ color: '#DC2626' }}>*</span>
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9CA3AF' }} />
                <input type="text" value={username} onChange={e => setUsername(e.target.value)} required autoFocus
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none transition-all bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700"
                  style={{ fontFamily: 'var(--font-body)' }}
                  onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)'; }}
                  onBlur={e => { e.target.style.borderColor = ''; e.target.style.boxShadow = 'none'; }}
                  placeholder="Enter your username" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5 text-slate-700 dark:text-slate-300" style={{ fontFamily: 'var(--font-body)' }}>
                Password <span style={{ color: '#DC2626' }}>*</span>
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#9CA3AF' }} />
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required
                  className="w-full pl-10 pr-10 py-3 rounded-xl text-sm outline-none transition-all bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700"
                  style={{ fontFamily: 'var(--font-body)' }}
                  onFocus={e => { e.target.style.borderColor = '#3b82f6'; e.target.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)'; }}
                  onBlur={e => { e.target.style.borderColor = ''; e.target.style.boxShadow = 'none'; }}
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
              style={{ background: '#1D4ED8', fontFamily: 'var(--font-heading)', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1E40AF')}
              onMouseLeave={e => (e.currentTarget.style.background = '#1D4ED8')}>
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Signing in...</> : 'Sign in to Bank Portal'}
            </button>
          </form>

          <p className="text-xs text-center mt-6" style={{ color: '#9CA3AF', fontFamily: 'var(--font-body)' }}>
            Contact your administrator if you need access
          </p>
        </div>
      </div>
    </div>
  );
}
