'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { Loader2, AlertTriangle, Lock, Shield, CheckCircle2, Clock, Phone } from 'lucide-react';

export default function Home() {
  return <Suspense><OTPPage /></Suspense>;
}

function OTPPage() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [timer, setTimer] = useState(0);
  const searchParams = useSearchParams();
  const autoTriggered = useRef(false);

  useEffect(() => {
    const phoneParam = searchParams.get('phone');
    if (phoneParam && /^\d{10}$/.test(phoneParam) && !autoTriggered.current) {
      setPhone(phoneParam);
      autoTriggered.current = true;
    }
  }, [searchParams]);

  useEffect(() => {
    if (autoTriggered.current && phone.length === 10 && step === 'phone' && !sessionId) {
      handleSendOTPRef.current();
    }
  }, [phone]);

  const handleSendOTPRef = useRef<() => void>(() => {});

  // Extract a human-readable reason from any error-response shape so the real
  // cause is always shown (not a generic fallback). Handles FastAPI's string
  // `detail`, its 422 array-of-objects `detail`, our global handler's `error`,
  // a `message`, or bare HTTP status.
  const errorReason = (data: any, res: Response, fallback: string): string => {
    const d = data?.detail;
    if (typeof d === 'string' && d.trim()) return d;
    if (Array.isArray(d) && d.length) {
      const msg = d.map((e: any) => e?.msg || e?.message).filter(Boolean).join('; ');
      if (msg) return msg;
    }
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
    if (typeof data?.error === 'string' && data.error.trim()) return data.error;
    if (res && !res.ok) return `${fallback} (error ${res.status})`;
    return fallback;
  };

  const handleSendOTP = async () => {
    if (phone.length !== 10) { setError('Enter a valid 10-digit mobile number'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: `+91${phone}` }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === 'otp_sent') {
        setSessionId(data.session_id);
        setStep('otp');
        setTimer(30);
        const interval = setInterval(() => {
          setTimer(t => { if (t <= 1) { clearInterval(interval); return 0; } return t - 1; });
        }, 1000);
      } else {
        setError(errorReason(data, res, 'Failed to send OTP'));
      }
    } catch { setError('Connection error. Please check your internet and try again.'); }
    finally { setLoading(false); }
  };
  handleSendOTPRef.current = handleSendOTP;

  const handleVerifyOTP = async () => {
    if (otp.length !== 6) { setError('Enter the 6-digit OTP'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/verify-otp-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, otp }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === 'verified') {
        sessionStorage.setItem('loan_session', data.session_token);
        sessionStorage.setItem('session_expiry', data.expires_at);
        router.push('/loan-form');
      } else {
        setError(errorReason(data, res, 'Invalid OTP. Please try again.'));
      }
    } catch { setError('Verification failed. Please check your internet and try again.'); }
    finally { setLoading(false); }
  };

  const tiles = [
    { icon: Phone,        title: 'Mobile OTP',   sub: 'Secure login' },
    { icon: Shield,       title: 'KYC Verified',  sub: 'Aadhaar + PAN' },
    { icon: Clock,        title: '24–48 hrs',     sub: 'Decision time' },
  ];

  return (
    <div className="min-h-screen flex">

      {/* ── LEFT PANEL ── */}
      <div className="hidden lg:flex flex-col justify-between w-[46%] p-12 relative overflow-hidden select-none"
        style={{ background: '#071A38' }}>

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-9 h-9 rounded flex items-center justify-center font-bold text-sm flex-shrink-0"
            style={{ background: '#fff', color: '#071A38', fontFamily: 'var(--font-heading)' }}>
            F
          </div>
          <div>
            <div className="text-sm font-bold text-white" style={{ fontFamily: 'var(--font-heading)' }}>Finix</div>
            <div className="text-[11px] text-white opacity-40" style={{ fontFamily: 'var(--font-body)' }}>Loan Application Portal</div>
          </div>
        </div>

        {/* Hero text */}
        <div className="relative z-10">
          <h1 className="text-[2.75rem] font-bold leading-[1.1] text-white mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
            Apply for a loan<br />from the comfort<br />
            <span style={{ color: '#93C5FD' }}>of your home.</span>
          </h1>
          <p className="text-base leading-relaxed mb-10" style={{ color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-body)' }}>
            Quick digital application with Aadhaar and PAN verification. Get a decision in 24–48 hours.
          </p>
          {/* Feature tiles */}
          <div className="grid grid-cols-3 gap-3">
            {tiles.map(({ icon: Icon, title, sub }) => (
              <div key={title} className="rounded-xl p-3 text-center"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <Icon className="w-5 h-5 mx-auto mb-1.5" style={{ color: 'rgba(255,255,255,0.5)' }} />
                <p className="text-xs font-semibold text-white" style={{ fontFamily: 'var(--font-heading)' }}>{title}</p>
                <p className="text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-body)' }}>{sub}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs" style={{ color: 'rgba(255,255,255,0.2)', fontFamily: 'var(--font-body)' }}>
          © 2026 Finix · Powered by Virtual Galaxy Infotech
        </p>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 flex items-center justify-center p-8 lg:p-16 relative" style={{ background: '#fff' }}>

        <div className="w-full max-w-sm relative z-10">

          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded flex items-center justify-center font-bold text-xs"
              style={{ background: '#071A38', color: '#fff', fontFamily: 'var(--font-heading)' }}>F</div>
            <span className="font-semibold" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>Finix</span>
          </div>

          {/* Portal icon */}
          <div className="mb-6">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
              style={{ background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
              <Lock className="w-6 h-6" style={{ color: '#2563EB' }} />
            </div>
            <h1 className="text-2xl font-bold mb-1" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>
              {step === 'phone' ? 'Loan Application' : 'Verify OTP'}
            </h1>
            <p className="text-sm" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>
              {loading && autoTriggered.current && step === 'phone'
                ? 'Sending OTP to your WhatsApp...'
                : step === 'phone'
                  ? 'Enter your registered mobile number to continue'
                  : `OTP sent to WhatsApp for +91 ${phone}`}
            </p>
          </div>

          {/* Phone step */}
          {step === 'phone' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151', fontFamily: 'var(--font-body)' }}>
                  Mobile number <span style={{ color: '#DC2626' }}>*</span>
                </label>
                <div className="flex gap-2">
                  <div className="flex items-center gap-1.5 px-3 py-3 rounded-xl flex-shrink-0 font-medium text-sm"
                    style={{ background: '#0A1628', color: '#fff', fontFamily: 'var(--font-body)', minWidth: '80px', justifyContent: 'center' }}>
                    IN +91
                  </div>
                  <input type="tel" value={phone}
                    onChange={e => { setPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); setError(''); }}
                    className="flex-1 min-w-0 px-4 py-3 rounded-xl text-sm outline-none transition-all"
                    style={{ border: '1px solid #E5E7EB', background: '#fff', fontFamily: 'var(--font-body)', color: '#111827' }}
                    onFocus={e => { e.target.style.borderColor = '#1D4ED8'; e.target.style.boxShadow = '0 0 0 3px rgba(29,78,216,0.08)'; }}
                    onBlur={e => { e.target.style.borderColor = '#E5E7EB'; e.target.style.boxShadow = 'none'; }}
                    placeholder="10-digit number" maxLength={10} autoFocus
                    onKeyDown={e => e.key === 'Enter' && handleSendOTP()} />
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2.5 rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#DC2626' }} />
                  <p className="text-sm" style={{ color: '#991B1B', fontFamily: 'var(--font-body)' }}>{error}</p>
                </div>
              )}

              <button onClick={handleSendOTP} disabled={loading || phone.length !== 10}
                className="w-full py-3 rounded-xl font-semibold text-white text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ background: loading || phone.length !== 10 ? '#94A3B8' : '#1D4ED8', fontFamily: 'var(--font-heading)' }}
                onMouseEnter={e => { if (!loading && phone.length === 10) e.currentTarget.style.background = '#1E40AF'; }}
                onMouseLeave={e => { if (!loading && phone.length === 10) e.currentTarget.style.background = '#1D4ED8'; }}>
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Sending...</> : 'Send OTP on WhatsApp'}
              </button>

              <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: '#F0F9FF', border: '1px solid #BAE6FD' }}>
                <Lock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#0284C7' }} />
                <p className="text-xs" style={{ color: '#075985', fontFamily: 'var(--font-body)' }}>
                  OTP will be sent to your WhatsApp number registered with the bank
                </p>
              </div>
            </div>
          )}

          {/* OTP step */}
          {step === 'otp' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-xl p-3" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: '#059669' }} />
                <p className="text-sm" style={{ color: '#065F46', fontFamily: 'var(--font-body)' }}>OTP sent to +91 {phone}</p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: '#374151', fontFamily: 'var(--font-body)' }}>
                  Enter 6-digit OTP <span style={{ color: '#DC2626' }}>*</span>
                </label>
                <input type="text" value={otp}
                  onChange={e => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
                  className="w-full px-4 py-4 rounded-xl text-center outline-none transition-all"
                  style={{ border: '1px solid #E5E7EB', background: '#fff', fontFamily: 'var(--font-mono-loan)', fontSize: '1.5rem', letterSpacing: '0.4em', color: '#111827' }}
                  onFocus={e => { e.target.style.borderColor = '#1D4ED8'; e.target.style.boxShadow = '0 0 0 3px rgba(29,78,216,0.08)'; }}
                  onBlur={e => { e.target.style.borderColor = '#E5E7EB'; e.target.style.boxShadow = 'none'; }}
                  placeholder="000000" maxLength={6} autoFocus inputMode="numeric"
                  onKeyDown={e => e.key === 'Enter' && handleVerifyOTP()} />
              </div>

              {error && (
                <div className="flex items-start gap-2.5 rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#DC2626' }} />
                  <p className="text-sm" style={{ color: '#991B1B', fontFamily: 'var(--font-body)' }}>{error}</p>
                </div>
              )}

              <button onClick={handleVerifyOTP} disabled={loading || otp.length !== 6}
                className="w-full py-3 rounded-xl font-semibold text-white text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ background: '#059669', fontFamily: 'var(--font-heading)' }}
                onMouseEnter={e => { if (!loading && otp.length === 6) e.currentTarget.style.background = '#047857'; }}
                onMouseLeave={e => { if (!loading && otp.length === 6) e.currentTarget.style.background = '#059669'; }}>
                {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Verifying...</> : 'Verify OTP'}
              </button>

              <div className="text-center">
                {timer > 0
                  ? <p className="text-sm" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>Resend OTP in {timer}s</p>
                  : <button onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
                      className="text-sm font-medium" style={{ color: '#1D4ED8', fontFamily: 'var(--font-body)' }}>
                      Change number / Resend OTP
                    </button>
                }
              </div>
            </div>
          )}

          <p className="text-xs text-center mt-6" style={{ color: '#9CA3AF', fontFamily: 'var(--font-body)' }}>
            Secure loan application portal · Your data is encrypted
          </p>
        </div>
      </div>
    </div>
  );
}
