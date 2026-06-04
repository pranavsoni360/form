'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, User, Lock, Banknote, FileCheck, TrendingUp } from 'lucide-react';

import { vendorLogin } from '@/lib/api/vendor';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { GuestGuard } from '@/lib/auth/guards';

import Input       from '@/components/ui/Input';
import ThemeToggle from '@/components/shared/ThemeToggle';

function VendorLoginForm() {
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
      const response = await vendorLogin(username, password);
      setAccessToken('vendor', response.token);
      setCurrentUser('vendor', response.user);
      router.replace('/vendor/dashboard');
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
        style={{ background: 'linear-gradient(135deg, #064E3B 0%, #065F46 50%, #047857 100%)' }}>

        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #34D399, transparent)' }} />
          <div className="absolute -bottom-32 -left-32 w-80 h-80 rounded-full opacity-10"
            style={{ background: 'radial-gradient(circle, #059669, transparent)' }} />
          <svg className="absolute inset-0 w-full h-full opacity-5" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid3" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid3)" />
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
          <p className="text-white/50 text-sm">Vendor & NBFC Portal</p>
        </div>

        <div className="relative z-10">
          <h1 className="text-4xl font-bold text-white leading-tight mb-4"
            style={{ fontFamily: 'Plus Jakarta Sans' }}>
            Disburse loans<br />
            and grow your<br />
            <span style={{ color: '#34D399' }}>lending portfolio.</span>
          </h1>
          <p className="text-white/60 text-base leading-relaxed max-w-sm">
            Access pre-approved loan applications, manage disbursements,
            and track settlements — all in one platform.
          </p>
        </div>

        <div className="relative z-10 space-y-3">
          {[
            { icon: FileCheck,   text: 'Access pre-approved loan applications' },
            { icon: Banknote,    text: 'One-click disbursement workflow' },
            { icon: TrendingUp,  text: 'Track settlements and portfolio performance' },
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
              style={{ background: 'rgba(5,150,105,0.1)', border: '1px solid rgba(5,150,105,0.2)' }}>
              <Users className="w-6 h-6" style={{ color: '#059669' }} />
            </div>
            <h2 className="text-2xl font-bold mb-1"
              style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
              Vendor Portal
            </h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              NBFC & lender access
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
                background: 'linear-gradient(135deg, #064E3B 0%, #059669 100%)',
                boxShadow: '0 2px 8px rgba(5,150,105,0.3)',
              }}
              onMouseEnter={e => !loading && (e.currentTarget.style.transform = 'translateY(-1px)')}
              onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
            >
              {loading ? 'Signing in...' : 'Sign in to Vendor Portal'}
            </button>
          </form>

          <p className="text-xs text-center mt-8" style={{ color: 'var(--text-muted)' }}>
            Contact your administrator for access
          </p>
        </div>
      </div>
    </div>
  );
}

export default function VendorLoginPage() {
  return (
    <GuestGuard type="vendor">
      <VendorLoginForm />
    </GuestGuard>
  );
}