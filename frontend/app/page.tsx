'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { Building2, Lock, CheckCircle2, Loader2, Phone } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';


export default function Home() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [timer, setTimer] = useState(0);

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
        router.push('/loan-form/application');
      } else {
        setError(data.detail || 'Invalid OTP');
      }
    } catch { setError('Verification failed. Try again.'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-950 flex items-center justify-center p-4 transition-colors">
      <div className="bg-white dark:bg-dark-card rounded-2xl shadow-xl dark:shadow-gray-900/50 p-8 max-w-md w-full transition-colors">
        <div className="flex justify-end mb-4"><ThemeToggle /></div>
        <div className="text-center mb-8">
          <div className="mb-4"><Building2 className="w-14 h-14 text-blue-600 mx-auto" /></div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Loan Application</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {step === 'phone' ? 'Enter your registered mobile number to continue' : `Enter the OTP sent to your WhatsApp (+91 ${phone})`}
          </p>
        </div>

        {step === 'phone' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Mobile Number <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                <div className="px-4 py-3 bg-gray-100 dark:bg-dark-input border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-200 font-medium flex items-center gap-1">
                  <Phone className="w-4 h-4" /> +91
                </div>
                <input type="tel" value={phone} onChange={e => { setPhone(e.target.value.replace(/\D/g,'').slice(0,10)); setError(''); }}
                  className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-lg"
                  placeholder="10-digit mobile" maxLength={10} autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleSendOTP()} />
              </div>
            </div>
            {error && <div className="bg-red-50 dark:bg-dark-section border border-red-200 dark:border-gray-700 rounded-lg p-3"><p className="text-sm text-red-800">{error}</p></div>}
            <button onClick={handleSendOTP} disabled={loading || phone.length !== 10}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
              {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Sending OTP...</> : 'Send OTP'}
            </button>
            <div className="bg-blue-50 dark:bg-dark-section border border-blue-200 dark:border-gray-700 rounded-lg p-3">
              <p className="text-xs text-blue-800 dark:text-gray-300 flex items-center gap-1"><Lock className="w-3 h-3" />OTP will be sent to your WhatsApp number registered with the bank</p>
            </div>
          </div>
        )}

        {step === 'otp' && (
          <div className="space-y-4">
            <div className="bg-green-50 dark:bg-dark-section border border-green-200 dark:border-gray-700 rounded-lg p-3 text-center">
              <p className="text-sm text-green-800 dark:text-gray-300 flex items-center justify-center gap-1"><CheckCircle2 className="w-4 h-4" />OTP sent to WhatsApp for +91 {phone}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Enter 6-digit OTP <span className="text-red-500">*</span></label>
              <input type="text" value={otp} onChange={e => { setOtp(e.target.value.replace(/\D/g,'').slice(0,6)); setError(''); }}
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-center text-2xl font-bold tracking-widest"
                placeholder="000000" maxLength={6} autoFocus
                onKeyDown={e => e.key === 'Enter' && handleVerifyOTP()} />
            </div>
            {error && <div className="bg-red-50 dark:bg-dark-section border border-red-200 dark:border-gray-700 rounded-lg p-3"><p className="text-sm text-red-800">{error}</p></div>}
            <button onClick={handleVerifyOTP} disabled={loading || otp.length !== 6}
              className="w-full bg-gradient-to-r from-green-600 to-emerald-600 text-white py-4 rounded-xl font-semibold hover:from-green-700 hover:to-emerald-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
              {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Verifying...</> : 'Verify OTP'}
            </button>
            <div className="text-center">
              {timer > 0
                ? <p className="text-sm text-gray-500 dark:text-gray-400">Resend OTP in {timer}s</p>
                : <button onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
                    className="text-sm text-blue-600 hover:underline">Change number / Resend OTP</button>
              }
            </div>
          </div>
        )}

        <div className="mt-6 pt-4 border-t dark:border-gray-700 text-center">
          <p className="text-xs text-gray-400 dark:text-gray-500">Secure loan application portal</p>
        </div>
      </div>
    </div>
  );
}
