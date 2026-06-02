'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { Lock, CheckCircle2, Loader2, Phone, Shield, Zap, Clock } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';

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

  const handleSendOTP = async () => {
    if (phone.length !== 10) { setError('Enter valid 10-digit mobile number'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: `+91${phone}` }),
      });
      const data = await res.json();
      if (data.status === 'otp_sent') {
        setSessionId(data.session_id);
        setStep('otp');
        setTimer(30);
        const interval = setInterval(() => {
          setTimer(t => { if (t <= 1) { clearInterval(interval); return 0; } return t - 1; });
        }, 1000);
      } else {
        setError(data.detail || 'Failed to send OTP');
      }
    } catch { setError('Connection error. Please try again.'); }
    finally { setLoading(false); }
  };
  handleSendOTPRef.current = handleSendOTP;

  const handleVerifyOTP = async () => {
    if (otp.length !== 6) { setError('Enter 6-digit OTP'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/verify-otp-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, otp }),
      });
      const data = await res.json();
      if (data.status === 'verified') {
        sessionStorage.setItem('loan_session', data.session_token);
        sessionStorage.setItem('session_expiry', data.expires_at);
        router.push('/loan-form');
      } else {
        setError(data.detail || 'Invalid OTP');
      }
    } catch { setError('Verification failed. Try again.'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex" style={{ background: '#F8F9FC' }}>

      {/* ── LEFT: Brand panel ── */}
      <div className="hidden lg:flex flex-col justify-between w-[46%] p-10 text-white relative overflow-hidden"
        style={{ background: 'linear-gradient(145deg, #1A1A2E 0%, #0F3460 100%)' }}>

        {/* Decorative circles */}
        <div className="absolute top-[-80px] right-[-80px] w-72 h-72 rounded-full opacity-10"
          style={{ background: '#2563EB' }} />
        <div className="absolute bottom-[-60px] left-[-60px] w-56 h-56 rounded-full opacity-10"
          style={{ background: '#2563EB' }} />

        {/* Logo */}
        <div className="flex items-center gap-3 relative z-10">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-lg"
            style={{ background: '#2563EB', fontFamily: 'var(--font-heading)' }}>
            VV
          </div>
          <span className="font-semibold text-lg tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
            VirtualVaani
          </span>
        </div>

        {/* Centre content */}
        <div className="relative z-10">
          <h2 className="text-4xl font-bold leading-tight mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
            Smart lending,<br />simplified.
          </h2>
          <p className="text-base mb-10" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>
            Complete your loan application in minutes with our AI-assisted process.
          </p>
          <div className="space-y-5">
            {[
              { icon: Shield, text: 'Bank-grade security with DigiLocker KYC' },
              { icon: Zap,    text: 'AI voice agent pre-fills your application' },
              { icon: Clock,  text: 'Decision within 24–48 hours' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-4">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(37,99,235,0.25)' }}>
                  <Icon className="w-4 h-4" style={{ color: '#60A5FA' }} />
                </div>
                <p className="text-sm" style={{ color: '#CBD5E1', fontFamily: 'var(--font-body)' }}>{text}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom */}
        <p className="text-xs relative z-10" style={{ color: '#475569', fontFamily: 'var(--font-body)' }}>
          © 2026 VirtualVaani · Powered by Virtual Galaxy Infotech
        </p>
      </div>

      {/* ── RIGHT: Form panel ── */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 lg:p-12 relative">
        <div className="absolute top-4 right-4"><ThemeToggle /></div>

        <div className="w-full max-w-md">

          {/* Mobile logo */}
          <div className="flex items-center justify-center gap-3 mb-8 lg:hidden">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-white text-base"
              style={{ background: '#1A1A2E', fontFamily: 'var(--font-heading)' }}>VV</div>
            <span className="font-semibold text-lg" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>
              VirtualVaani
            </span>
          </div>

          {/* Card */}
          <div className="bg-white rounded-2xl shadow-sm p-8" style={{ border: '1px solid #E2E8F0' }}>

            <div className="mb-7">
              <h1 className="text-2xl font-bold mb-1" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>
                {step === 'phone' ? 'Loan Application' : 'Verify OTP'}
              </h1>
              <p className="text-sm" style={{ color: '#475569', fontFamily: 'var(--font-body)' }}>
                {loading && autoTriggered.current && step === 'phone'
                  ? 'Sending OTP to your WhatsApp...'
                  : step === 'phone'
                    ? 'Enter your registered mobile number to continue'
                    : `OTP sent to WhatsApp for +91 ${phone}`}
              </p>
            </div>

            {/* Phone step */}
            {step === 'phone' && (
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: '#0F172A', fontFamily: 'var(--font-body)' }}>
                    Mobile Number <span style={{ color: '#DC2626' }}>*</span>
                  </label>
                  <div className="flex gap-2">
                    <div className="flex items-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm flex-shrink-0"
                      style={{ background: '#1A1A2E', color: '#fff', fontFamily: 'var(--font-body)' }}>
                      <Phone className="w-4 h-4" /> +91
                    </div>
                    <input type="tel" value={phone}
                      onChange={e => { setPhone(e.target.value.replace(/\D/g,'').slice(0,10)); setError(''); }}
                      className="flex-1 min-w-0 px-4 py-3 rounded-xl text-base outline-none transition"
                      style={{ border: '1.5px solid #E2E8F0', color: '#0F172A', background: '#fff',
                        fontFamily: 'var(--font-body)', fontSize: '1.05rem' }}
                      onFocus={e => (e.target.style.borderColor = '#1A1A2E')}
                      onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
                      placeholder="10-digit mobile" maxLength={10} autoFocus
                      onKeyDown={e => e.key === 'Enter' && handleSendOTP()} />
                  </div>
                </div>

                {error && (
                  <div className="rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                    <p className="text-sm" style={{ color: '#DC2626', fontFamily: 'var(--font-body)' }}>{error}</p>
                  </div>
                )}

                <button onClick={handleSendOTP} disabled={loading || phone.length !== 10}
                  className="w-full py-4 rounded-xl font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg, #1A1A2E 0%, #2563EB 100%)',
                    fontFamily: 'var(--font-heading)', fontSize: '0.95rem' }}>
                  {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Sending OTP...</> : 'Send OTP →'}
                </button>

                <div className="flex items-center gap-2 px-4 py-3 rounded-xl"
                  style={{ background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
                  <Lock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#2563EB' }} />
                  <p className="text-xs" style={{ color: '#1D4ED8', fontFamily: 'var(--font-body)' }}>
                    OTP will be sent to your WhatsApp number registered with the bank
                  </p>
                </div>
              </div>
            )}

            {/* OTP step */}
            {step === 'otp' && (
              <div className="space-y-5">
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl"
                  style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: '#059669' }} />
                  <p className="text-sm" style={{ color: '#065F46', fontFamily: 'var(--font-body)' }}>
                    OTP sent to WhatsApp for +91 {phone}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: '#0F172A', fontFamily: 'var(--font-body)' }}>
                    Enter 6-digit OTP <span style={{ color: '#DC2626' }}>*</span>
                  </label>
                  <input type="text" value={otp}
                    onChange={e => { setOtp(e.target.value.replace(/\D/g,'').slice(0,6)); setError(''); }}
                    className="w-full px-4 py-4 rounded-xl text-center outline-none transition"
                    style={{ border: '1.5px solid #E2E8F0', color: '#0F172A', background: '#fff',
                      fontFamily: 'var(--font-mono-loan)', fontSize: '1.75rem', letterSpacing: '0.4em' }}
                    onFocus={e => (e.target.style.borderColor = '#1A1A2E')}
                    onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
                    placeholder="000000" maxLength={6} autoFocus inputMode="numeric"
                    onKeyDown={e => e.key === 'Enter' && handleVerifyOTP()} />
                </div>

                {error && (
                  <div className="rounded-xl p-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                    <p className="text-sm" style={{ color: '#DC2626', fontFamily: 'var(--font-body)' }}>{error}</p>
                  </div>
                )}

                <button onClick={handleVerifyOTP} disabled={loading || otp.length !== 6}
                  className="w-full py-4 rounded-xl font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
                    fontFamily: 'var(--font-heading)', fontSize: '0.95rem' }}>
                  {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Verifying...</> : 'Verify OTP →'}
                </button>

                <div className="text-center">
                  {timer > 0
                    ? <p className="text-sm" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>
                        Resend OTP in {timer}s
                      </p>
                    : <button onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
                        className="text-sm font-medium hover:underline"
                        style={{ color: '#2563EB', fontFamily: 'var(--font-body)' }}>
                        Change number / Resend OTP
                      </button>
                  }
                </div>
              </div>
            )}
          </div>

          {/* Bottom */}
          <div className="mt-6 text-center">
            <p className="text-xs" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>
              Secure loan application portal · VirtualVaani
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}
