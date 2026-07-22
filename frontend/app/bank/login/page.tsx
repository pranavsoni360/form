'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { bankLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { Loader2, AlertTriangle, User, Lock, FileText, CheckCircle2, Clock, Eye, EyeOff, X, Info } from 'lucide-react';

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-50">
              <Info className="h-4 w-4 text-blue-600" />
            </span>
            <h2 className="text-sm font-semibold text-slate-800">Forgot Password</h2>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-5 space-y-3">
          <p className="text-sm text-slate-600" style={{ fontFamily: 'var(--font-body)' }}>
            To reset your password, please contact your system administrator.
          </p>
          <div className="rounded-xl bg-blue-50 border border-blue-100 px-4 py-3">
            <p className="text-xs font-medium text-blue-800" style={{ fontFamily: 'var(--font-body)' }}>
              Your administrator can reset your password from the Admin Portal.
            </p>
          </div>
          <button onClick={onClose}
            className="w-full py-2.5 rounded-xl font-semibold text-white text-sm transition-all"
            style={{ background: '#1D4ED8', fontFamily: 'var(--font-heading)' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#1E40AF')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1D4ED8')}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BankLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForgot, setShowForgot] = useState(false);

  // ── Masked-value password handling ──────────────────────────────────────
  // The real password is NEVER written into the <input>'s DOM value. The field
  // is uncontrolled and, while hidden, holds only bullet chars (•) — so
  // DevTools/Inspect shows "••••", never the plaintext. The real value lives
  // only in `pwRef` (JS memory) and is what we submit. Clicking the eye toggle
  // reveals the real value (that is the toggle's explicit purpose).
  // Trade-offs (accepted): breaks browser password-managers, autofill, and is
  // not screen-reader-friendly for the revealed value.
  const MASK = '•'; // •
  const pwRef = useRef('');                            // authoritative real password
  const pwInputRef = useRef<HTMLInputElement>(null);
  const selRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  // Snapshot the selection BEFORE the browser mutates the field. For a collapsed
  // Backspace/Delete we widen the range so the diff below knows what was removed.
  const snapSelection = (key?: string) => {
    const el = pwInputRef.current;
    if (!el) return;
    let start = el.selectionStart ?? 0;
    let end = el.selectionEnd ?? 0;
    if (start === end && key) {
      if (key === 'Backspace' && start > 0) start -= 1;
      else if (key === 'Delete') end += 1;
    }
    selRef.current = { start, end };
  };

  // Reconstruct the real value from the pre-edit selection + whatever the browser
  // just placed into the field, then immediately re-mask and restore the caret.
  const handlePasswordInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const display = el.value;                          // post-edit (bullets + any typed chars)
    const { start, end } = selRef.current;             // pre-edit selection into the real string
    const real = pwRef.current;
    const selCount = end - start;
    const insertedCount = display.length - (real.length - selCount);
    const inserted = insertedCount > 0 ? display.slice(start, start + insertedCount) : '';
    const next = real.slice(0, start) + inserted + real.slice(end);

    pwRef.current = next;
    const caret = start + (insertedCount > 0 ? insertedCount : 0);
    el.value = showPassword ? next : MASK.repeat(next.length);
    el.setSelectionRange(caret, caret);
    selRef.current = { start: caret, end: caret };
  };

  // Re-render the display when the show/hide toggle flips (length is 1:1 → keep caret).
  useEffect(() => {
    const el = pwInputRef.current;
    if (!el) return;
    const s = el.selectionStart, en = el.selectionEnd;
    el.value = showPassword ? pwRef.current : MASK.repeat(pwRef.current.length);
    if (s != null && en != null) el.setSelectionRange(s, en);
  }, [showPassword]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await bankLogin(username, pwRef.current);
      setAccessToken('bank', response.token);
      setCurrentUser('bank', response.user);
      router.push('/bank/dashboard');
    } catch (err: any) {
      setError(err.message || 'Invalid credentials. Please try again.');
    } finally {
      setLoading(false);
      // Security: wipe the real password from memory AND the input after every
      // submit attempt, so nothing lingers in JS state or the DOM.
      pwRef.current = '';
      if (pwInputRef.current) pwInputRef.current.value = '';
    }
  };

  return (
    <>
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
                  autoComplete="off" spellCheck={false} autoCorrect="off" autoCapitalize="off"
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
                <input type={showPassword ? 'text' : 'password'} ref={pwInputRef} defaultValue="" required
                  autoComplete="off" spellCheck={false} autoCorrect="off" autoCapitalize="off"
                  onKeyDown={e => snapSelection(e.key)}
                  onPaste={() => snapSelection()}
                  onCut={() => snapSelection()}
                  onChange={handlePasswordInput}
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
              <div className="flex justify-end mt-1.5">
                <button type="button" onClick={() => setShowForgot(true)}
                  className="text-xs font-medium transition-colors"
                  style={{ color: '#3b82f6', fontFamily: 'var(--font-body)' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#1D4ED8')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#3b82f6')}>
                  Forgot password?
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

    {showForgot && <ForgotPasswordModal onClose={() => setShowForgot(false)} />}
    </>
  );
}
