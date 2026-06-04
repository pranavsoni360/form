'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, User, Lock, FileText, CheckCircle, Clock } from 'lucide-react';

import { bankLogin } from '@/lib/api/bank';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { GuestGuard } from '@/lib/auth/guards';

import Input       from '@/components/ui/Input';
import ThemeToggle from '@/components/shared/ThemeToggle';

function BankLoginForm() {
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await bankLogin(username, password);
      setAccessToken('bank', response.token);
      setCurrentUser('bank', response.user);
      router.replace('/bank/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex auth-bg">

      {/* Left — brand panel */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 relative overflow-hidden"
        style={{ background: 'linear-gradient(135deg, #1E3A5F 0%, #0F2744 50%, #091C33 100%)' }}>

        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #2563EB, transparent)' }} />
          <div className="absolute -bottom-32 -left-32 w-80 h-80 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #059669, transparent)' }} />
          <svg className="absolute inset-0 w-full h-full opacity-5" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid2" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid2)" />
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
          <p className="text-white/50 text-sm">Bank Officer Portal</p>
        </div>

        <div className="relative z-10">
          <h1 className="text-4xl font-bold text-white leading-tight mb-4"
            style={{ fontFamily: 'Plus Jakarta Sans' }}>
            Review and approve<br />
            loan applications<br />
            <span style={{ color: '#60A5FA' }}>efficiently.</span>
          </h1>
          <p className="text-white/60 text-base leading-relaxed max-w-sm">
            AI-assisted review pipeline with complete applicant profiles,
            document verification, and one-click approval workflows.
          </p>
        </div>

        <div className="relative z-10 space-y-3">
          {[
            { icon: FileText,     text: 'View complete applicant profiles and documents' },
            { icon: CheckCircle,  text: 'Officer and supervisor approval workflow' },
            { icon: Clock,        text: 'Real-time status updates and notifications' },
          ].map(item => (
            <div key={item.text} className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.08)' }}>
                <item.icon className="w-3.5 h-3.5 text-white/70" />
              </div>
              <p className="text-white/60 text-sm">{item.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Right — login */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
        <div className="absolute top-6 right-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-sm animate-fade-in">

          <div className="flex items-center gap-2 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded-lg brand-gradient flex items-center justify-center">
              <span className="text-white font-bold text-xs">VV</span>
            </div>
            <span className="font-bold text-base" style={{ fontFamily: 'Plus Jakarta Sans', color: 'var(--text-primary)' }}>
              VirtualVaani
            </span>
          </div>

          <div className="mb-8">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5"
              style={{ background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.2)' }}>
              <Building2 className="w-6 h-6" style={{ color: '#2563EB' }} />
            </div>
            <h2 className="text-2xl font-bold mb-1"
              style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
              Bank Portal
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Sign in with your bank credentials
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              label="Username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Enter your username"
              leftIcon={<User className="w-4 h-4" />}
              required
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              leftIcon={<Lock className="w-4 h-4" />}
              required
            />

            {error && (
              <div className="p-3 rounded-xl text-sm"
                style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#DC2626' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all duration-200 mt-2 disabled:opacity-50"
              style={{
                background: 'linear-gradient(135deg, #1E3A5F 0%, #2563EB 100%)',
                boxShadow: '0 2px 8px rgba(37,99,235,0.3)',
              }}
              onMouseEnter={e => !loading && (e.currentTarget.style.transform = 'translateY(-1px)')}
              onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
            >
              {loading ? 'Signing in...' : 'Sign in to Bank Portal'}
            </button>
          </form>

          <p className="text-xs text-center mt-8" style={{ color: 'var(--text-muted)' }}>
            Contact your administrator if you need access
          </p>
        </div>
      </div>
    </div>
  );
}

export default function BankLoginPage() {
  return (
    <GuestGuard type="bank">
      <BankLoginForm />
    </GuestGuard>
  );
}