'use client';

// Admin (Operations Console) login — Finix design, unified with /bank/login.
// Same theme-aware split-hero + card layout, fonts, spacing and components as the
// bank login; only the copy, feature list and the email/password fields differ.
// Theme-aware via FinixThemeProvider (light/dark toggle top-right).

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { adminLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { Radio, BarChart3, Shield, Settings, Eye, EyeOff } from 'lucide-react';
import {
  FinixThemeProvider,
  Button,
  Card,
  CardBody,
  Field,
  Input,
} from '@/components/finix';
import { FinixThemeToggle } from '@/components/finix/ThemeToggleButton';
import { FinixLogo } from '@/components/shared/FinixLogo';

const FEATURES = [
  { icon: Radio,     text: 'Live call monitor — SSE-powered real-time feed' },
  { icon: BarChart3, text: 'Lead funnel analytics across all banks' },
  { icon: Shield,    text: 'Role-gated access · multi-bank scope control' },
  { icon: Settings,  text: 'Batch upload · phone pool · worker queue' },
];

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
    <FinixThemeProvider>
      <div className="finix-root flex h-screen flex-col overflow-hidden">
        {/* The two-column split fills all height above the shared footer strip. */}
        <div className="flex min-h-0 flex-1">

          {/* ── LEFT PANEL — marketing, hidden below lg ── */}
          <div
            className="relative hidden w-[46%] select-none flex-col overflow-hidden p-10 lg:flex"
            style={{ background: 'var(--fx-surface)' }}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.5]"
              style={{
                backgroundImage: 'radial-gradient(circle, var(--fx-border) 1px, transparent 1px)',
                backgroundSize: '28px 28px',
              }}
            />

            <div className="relative z-10 flex items-center gap-3 text-fx-text">
              <FinixLogo height={40} className="shrink-0" />
              <div className="leading-tight">
                <div className="text-[17px] font-semibold tracking-tight text-fx-text">Finix</div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-fx-text3">Operations console</div>
              </div>
            </div>

            {/* Hero centred in the space left between the brand row and the footer. */}
            <div className="relative z-10 flex flex-1 flex-col justify-center py-8">
              <div className="mb-4 text-[12px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--fx-accent)' }}>
                Internal · Authorized access only
              </div>
              <h1 className="mb-4 text-[38px] lg:text-[44px] font-semibold leading-[1.06] text-fx-text" style={{ letterSpacing: '-0.03em' }}>
                Manage lending<br />operations<br />
                <span style={{ color: 'var(--fx-accent)' }}>in real time.</span>
              </h1>
              <p className="mb-8 max-w-md text-[15px] leading-relaxed text-fx-text2">
                Unified view of live calls, worker health, lead funnels, and multi-bank workflows — all in one dashboard.
              </p>
              <div className="space-y-3.5">
                {FEATURES.map(({ icon: Icon, text }) => (
                  <div key={text} className="flex items-center gap-3.5">
                    <span
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px]"
                      style={{ background: 'var(--fx-surface2)', color: 'var(--fx-accent)' }}
                      aria-hidden
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <p className="text-[15px] text-fx-text2">{text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── RIGHT PANEL — the form ── */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="absolute right-5 top-5 z-20"><FinixThemeToggle /></div>

            <div className="flex flex-1 items-center justify-center overflow-y-auto p-6 sm:p-10">
              <div className="relative z-10 w-full max-w-md">
                {/* Mobile logo */}
                <div className="mb-8 flex items-center gap-3 text-fx-text lg:hidden">
                  <FinixLogo height={32} className="shrink-0" />
                  <span className="text-[17px] font-semibold text-fx-text">Finix</span>
                </div>

                <div className="mb-6">
                  <div
                    className="mb-5 grid h-14 w-14 place-items-center rounded-[16px] text-white"
                    style={{ background: 'var(--fx-accent-grad)', boxShadow: 'var(--fx-accent-glow)' }}
                    aria-hidden
                  >
                    <Shield className="h-6 w-6" />
                  </div>
                  <h1 className="text-[30px] font-semibold text-fx-text" style={{ letterSpacing: '-0.02em' }}>
                    Operations console
                  </h1>
                  <p className="mt-1.5 text-[15px] text-fx-text2">Sign in with your admin credentials</p>
                </div>

                <Card>
                  <CardBody className="p-6 sm:p-7">
                    <form onSubmit={handleLogin} className="space-y-5">
                      <Field label="Email address" htmlFor="admin-email" required>
                        <Input
                          id="admin-email"
                          type="email"
                          value={email}
                          onChange={e => setEmail(e.target.value)}
                          required
                          autoFocus
                          autoComplete="off"
                          placeholder="admin@finix.in"
                          className="h-11 text-[15px]"
                        />
                      </Field>

                      <Field label="Password" htmlFor="admin-password" required>
                        <div className="relative">
                          <Input
                            id="admin-password"
                            type={showPassword ? 'text' : 'password'}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                            autoComplete="off"
                            placeholder="••••••••"
                            className="h-11 pr-10 text-[15px]"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(v => !v)}
                            tabIndex={-1}
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-fx-text3 transition-colors hover:text-fx-text2"
                          >
                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </Field>

                      {error && (
                        <div
                          className="rounded-[10px] px-3.5 py-3 text-[13px]"
                          style={{ background: 'var(--fx-red-tint)', color: 'var(--fx-red)' }}
                          role="alert"
                        >
                          {error}
                        </div>
                      )}

                      <Button type="submit" variant="primary" disabled={loading} className="h-11 w-full text-[15px]">
                        {loading ? 'Signing in…' : 'Sign in to console'}
                      </Button>
                    </form>
                  </CardBody>
                </Card>

                <p className="mt-5 text-center text-[12px] text-fx-text3">
                  Authorized personnel only
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── SHARED FOOTER STRIP — full width, always visible ── */}
        <footer
          className="shrink-0 px-6 py-3.5 text-center text-[11px] text-fx-text3"
          style={{ borderTop: '1px solid var(--fx-border)', background: 'var(--fx-surface)' }}
        >
          © 2026 Finix · Virtual Galaxy Infotech Limited
        </footer>
      </div>
    </FinixThemeProvider>
  );
}
