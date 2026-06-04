'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Lock, CheckCircle2, Loader2,
  Shield, Smartphone, FileText, Clock
} from 'lucide-react';

import { API_URL } from '@/lib/api/index';
import { SESSION_KEYS } from '@/lib/utils/constants';
import ThemeToggle from '@/components/shared/ThemeToggle';

function OTPPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const [phone, setPhone]   = useState('');
  const [otp, setOtp]       = useState('');
  const [step, setStep]     = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');
  const [sessionId, setSessionId] = useState('');
  const [timer, setTimer]   = useState(0);
  const [resendAttempts, setResendAttempts] = useState(0);
  const [resendBlockedUntil, setResendBlockedUntil] = useState<Date | null>(null);

  const autoTriggered    = useRef(false);
  const handleSendOTPRef = useRef<() => void>(() => {});

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

  const startTimer = () => {
    setTimer(180);
    const interval = setInterval(() => {
      setTimer(t => { if (t <= 1) { clearInterval(interval); return 0; } return t - 1; });
    }, 1000);
  };

  const handleSendOTP = async () => {
    if (phone.length !== 10) { setError('Enter a valid 10-digit mobile number'); return; }
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${API_URL}/api/request-otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: `+91${phone}` }),
      });
      const data = await res.json();
      if (data.status === 'otp_sent') {
        setSessionId(data.session_id);
        setStep('otp');
        const newAttempts = resendAttempts + 1;
        setResendAttempts(newAttempts);
        if (newAttempts >= 3) setResendBlockedUntil(new Date(Date.now() + 60 * 60 * 1000));
        startTimer();
      } else if (res.status === 429) {
        setResendBlockedUntil(new Date(Date.now() + 60 * 60 * 1000));
        setError(data.detail || 'Too many OTP requests. Please wait 1 hour.');
      } else {
        setError(data.detail || 'Failed to send OTP');
      }
    } catch { setError('Connection error. Please try again.'); }
    finally { setLoading(false); }
  };
  handleSendOTPRef.current = handleSendOTP;

  const handleVerifyOTP = async () => {
    if (otp.length !== 6) { setError('Enter the 6-digit OTP'); return; }
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${API_URL}/api/verify-otp-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, otp }),
      });
      const data = await res.json();
      if (data.status === 'verified') {
        sessionStorage.setItem(SESSION_KEYS.LOAN_SESSION, data.session_token);
        sessionStorage.setItem(SESSION_KEYS.SESSION_EXPIRY, data.expires_at);
        router.push('/loan-form/application');
      } else {
        setError(data.detail || 'Invalid OTP. Please try again.');
      }
    } catch { setError('Verification failed. Please try again.'); }
    finally { setLoading(false); }
  };

  const isBlocked = resendBlockedUntil && resendBlockedUntil > new Date();

  return (
    <div className="min-h-screen flex auth-bg">

      {/* Left — brand panel */}
      <div className="hidden lg:flex lg:w-[45%] flex-col justify-between p-12 relative overflow-hidden brand-gradient">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #E63946, transparent)' }} />
          <div className="absolute bottom-0 left-0 right-0 h-64 opacity-10"
            style={{ background: 'linear-gradient(to top, #2563EB, transparent)' }} />
          <svg className="absolute inset-0 w-full h-full opacity-5" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid4" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid4)" />
          </svg>
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.12)' }}>
              <span className="text-white font-bold text-sm" style={{ fontFamily: 'Plus Jakarta Sans' }}>VV</span>
            </div>
            <span className="text-white font-bold text-lg" style={{ fontFamily: 'Plus Jakarta Sans' }}>VirtualVaani</span>
          </div>
          <p className="text-white/50 text-sm">Loan Application Portal</p>
        </div>

        <div className="relative z-10">
          <h1 className="text-4xl font-bold text-white leading-tight mb-4"
            style={{ fontFamily: 'Plus Jakarta Sans' }}>
            Apply for a loan<br />
            from the comfort<br />
            <span style={{ color: '#E63946' }}>of your home.</span>
          </h1>
          <p className="text-white/60 text-base leading-relaxed max-w-sm">
            Quick digital application with Aadhaar and PAN verification.
            Get a decision in 24–48 hours.
          </p>
        </div>

        <div className="relative z-10 grid grid-cols-3 gap-3">
          {[
            { icon: Smartphone, label: 'Mobile OTP',    sub: 'Secure login' },
            { icon: Shield,     label: 'KYC Verified',  sub: 'Aadhaar + PAN' },
            { icon: Clock,      label: '24–48 hrs',     sub: 'Decision time' },
          ].map(item => (
            <div key={item.label} className="rounded-xl p-3 text-center"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <item.icon className="w-5 h-5 mx-auto mb-1.5 text-white/70" />
              <p className="text-white text-xs font-semibold">{item.label}</p>
              <p className="text-white/50 text-[10px]">{item.sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
        <div className="absolute top-6 right-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-sm animate-fade-in">

          {/* Mobile logo */}
          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded-lg brand-gradient flex items-center justify-center">
              <span className="text-white font-bold text-xs">VV</span>
            </div>
            <span className="font-bold text-base" style={{ fontFamily: 'Plus Jakarta Sans', color: 'var(--text-primary)' }}>
              VirtualVaani
            </span>
          </div>

          {step === 'phone' ? (
            <>
              <div className="mb-8">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5"
                  style={{ background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.2)' }}>
                  <FileText className="w-6 h-6" style={{ color: '#2563EB' }} />
                </div>
                <h2 className="text-2xl font-bold mb-1"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                  Loan Application
                </h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Enter your registered mobile number to continue
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2"
                    style={{ color: 'var(--text-secondary)', fontFamily: 'Plus Jakarta Sans' }}>
                    Mobile number <span className="text-red-500">*</span>
                  </label>
                  <div className="flex gap-2">
                    <div className="flex items-center gap-1.5 px-3 rounded-xl border text-sm font-medium flex-shrink-0"
                      style={{
                        background: 'var(--bg-subtle)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                        height: '44px',
                      }}>
                      🇮🇳 +91
                    </div>
                    <input
                      type="tel"
                      value={phone}
                      onChange={e => { setPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); setError(''); }}
                      onKeyDown={e => e.key === 'Enter' && handleSendOTP()}
                      className="flex-1 min-w-0 rounded-xl text-base outline-none transition-all"
                      style={{
                        padding: '10px 16px',
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-primary)',
                        fontFamily: 'DM Sans',
                      }}
                      placeholder="10-digit number"
                      maxLength={10}
                      autoFocus
                      inputMode="numeric"
                      onFocus={e => e.target.style.borderColor = '#1A1A2E'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'}
                    />
                  </div>
                </div>

                {error && (
                  <div className="p-3 rounded-xl text-sm"
                    style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#DC2626' }}>
                    {error}
                  </div>
                )}

                <button
                  onClick={handleSendOTP}
                  disabled={loading || phone.length !== 10}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{
                    background: phone.length === 10 ? 'linear-gradient(135deg, #1A1A2E 0%, #0F3460 100%)' : 'var(--border-strong)',
                    boxShadow: phone.length === 10 ? '0 2px 8px rgba(26,26,46,0.3)' : 'none',
                  }}
                >
                  {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending OTP...</> : 'Send OTP on WhatsApp'}
                </button>

                <div className="flex items-start gap-2 p-3 rounded-xl"
                  style={{ background: 'rgba(37,99,235,0.06)', border: '1px solid rgba(37,99,235,0.12)' }}>
                  <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: '#2563EB' }} />
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    OTP will be sent to your WhatsApp number registered with the bank
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="mb-8">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5"
                  style={{ background: 'rgba(5,150,105,0.1)', border: '1px solid rgba(5,150,105,0.2)' }}>
                  <Smartphone className="w-6 h-6" style={{ color: '#059669' }} />
                </div>
                <h2 className="text-2xl font-bold mb-1"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                  Verify OTP
                </h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Sent to WhatsApp · +91 {phone}
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-2 p-3 rounded-xl"
                  style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.15)' }}>
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: '#059669' }} />
                  <p className="text-xs font-medium" style={{ color: '#059669' }}>
                    OTP sent successfully to +91 {phone}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2"
                    style={{ color: 'var(--text-secondary)', fontFamily: 'Plus Jakarta Sans' }}>
                    Enter 6-digit OTP <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={otp}
                    onChange={e => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleVerifyOTP()}
                    className="w-full rounded-xl outline-none transition-all text-center font-bold tracking-[0.4em]"
                    style={{
                      padding: '14px 16px',
                      fontSize: '24px',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)',
                      fontFamily: 'JetBrains Mono',
                    }}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    inputMode="numeric"
                    onFocus={e => e.target.style.borderColor = '#059669'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-xl text-sm"
                    style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#DC2626' }}>
                    {error}
                  </div>
                )}

                <button
                  onClick={handleVerifyOTP}
                  disabled={loading || otp.length !== 6}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{
                    background: otp.length === 6 ? 'linear-gradient(135deg, #064E3B 0%, #059669 100%)' : 'var(--border-strong)',
                    boxShadow: otp.length === 6 ? '0 2px 8px rgba(5,150,105,0.3)' : 'none',
                  }}
                >
                  {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Verifying...</> : 'Verify & Continue'}
                </button>

                <div className="text-center">
                  {isBlocked ? (
                    <p className="text-xs" style={{ color: '#DC2626' }}>Too many attempts — resend blocked for 1 hour.</p>
                  ) : timer > 0 ? (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Resend in {Math.floor(timer / 60)}:{String(timer % 60).padStart(2, '0')} · {Math.max(0, 3 - resendAttempts)} resend(s) left
                    </p>
                  ) : resendAttempts >= 3 ? (
                    <p className="text-xs" style={{ color: '#DC2626' }}>Max resend attempts reached.</p>
                  ) : (
                    <button onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
                      className="text-xs font-medium transition-colors"
                      style={{ color: '#2563EB' }}>
                      ← Change number / Resend OTP
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          <p className="text-xs text-center mt-8" style={{ color: 'var(--text-muted)' }}>
            Secure loan application portal · Your data is encrypted
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense>
      <OTPPage />
    </Suspense>
  );
}