'use client';

// Invite acceptance (BAD-03). The invite email links here with ?token=…; the
// invitee sets a username + password and their bank_user account is created
// active. Public page (no session yet), gated by the token. Finix-styled to
// match the bank/admin login screens.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getInviteInfo, acceptInvite, type InviteInfo } from '@/lib/api/bank';
import { CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
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

const USERNAME_RE = /^[a-z0-9_]{3,50}$/;

export default function AcceptInvitePage() {
  return <Suspense><AcceptInviteInner /></Suspense>;
}

function AcceptInviteInner() {
  const router = useRouter();
  const token = useSearchParams().get('token') || '';

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setLoadError('This invite link is missing its token. Ask your administrator to resend it.'); setLoading(false); return; }
    let live = true;
    getInviteInfo(token)
      .then((d) => { if (live) setInfo(d); })
      .catch((e: any) => { if (live) setLoadError(e?.message || 'This invite link is invalid or has expired.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!USERNAME_RE.test(username.trim().toLowerCase())) {
      setError('Username must be 3–50 characters: lowercase letters, digits or underscore.'); return;
    }
    if (password.length < 8) { setError('Choose a password of at least 8 characters.'); return; }
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    setSubmitting(true);
    try {
      await acceptInvite(token, username.trim().toLowerCase(), password);
      setDone(true);
      setTimeout(() => router.push('/bank/login'), 2200);
    } catch (err: any) {
      setError(err?.message || 'Could not complete sign-up. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FinixThemeProvider>
      <div className="finix-root flex min-h-screen flex-col" style={{ background: 'var(--fx-bg)' }}>
        <div className="relative flex flex-1 items-center justify-center overflow-y-auto p-6 sm:p-10">
          <div className="absolute right-5 top-5 z-20"><FinixThemeToggle /></div>

          <div className="w-full max-w-md">
            <div className="mb-7 flex items-center gap-3 text-fx-text">
              <FinixLogo height={38} className="shrink-0" />
              <div className="leading-tight">
                <div className="text-[17px] font-semibold tracking-tight text-fx-text">Finix</div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-fx-text3">Bank officer portal</div>
              </div>
            </div>

            {loading ? (
              <Card><CardBody className="flex items-center gap-3 p-8 text-fx-text2">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking your invite…
              </CardBody></Card>
            ) : loadError ? (
              <Card ring="red">
                <CardBody className="p-7">
                  <h1 className="text-[20px] font-semibold text-fx-text">This invite can’t be used</h1>
                  <p className="mt-2 text-[14px] text-fx-text2">{loadError}</p>
                  <Button variant="primary" className="mt-5 h-11 w-full text-[15px]" onClick={() => router.push('/bank/login')}>
                    Go to sign in
                  </Button>
                </CardBody>
              </Card>
            ) : done ? (
              <Card>
                <CardBody className="p-7 text-center">
                  <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-[16px]"
                    style={{ background: 'var(--fx-green-tint)', color: 'var(--fx-green)' }}>
                    <CheckCircle2 className="h-7 w-7" />
                  </div>
                  <h1 className="text-[22px] font-semibold text-fx-text">You’re all set</h1>
                  <p className="mt-2 text-[14px] text-fx-text2">
                    Your account is ready. Taking you to sign in…
                  </p>
                </CardBody>
              </Card>
            ) : (
              <>
                <div className="mb-6">
                  <h1 className="text-[26px] font-semibold text-fx-text" style={{ letterSpacing: '-0.02em' }}>
                    Set up your account
                  </h1>
                  <p className="mt-1.5 text-[14px] text-fx-text2">
                    {info?.full_name ? `Welcome, ${info.full_name}. ` : ''}
                    You’ve been invited to <span className="text-fx-text">{info?.bank_name}</span>
                    {info?.role ? <> as <span className="text-fx-text">{info.role}</span></> : null}.
                  </p>
                </div>

                <Card>
                  <CardBody className="p-6 sm:p-7">
                    <form onSubmit={handleSubmit} className="space-y-5">
                      <Field label="Invited email" htmlFor="ai-email">
                        <Input id="ai-email" value={info?.email || ''} disabled readOnly className="h-11 text-[15px]" />
                      </Field>

                      <Field label="Choose a username" htmlFor="ai-username" required
                        hint="3–50 characters · lowercase letters, digits or underscore">
                        <Input
                          id="ai-username"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          autoFocus
                          autoComplete="off"
                          spellCheck={false}
                          autoCapitalize="off"
                          placeholder="e.g. sneha_deshmukh"
                          className="h-11 text-[15px]"
                        />
                      </Field>

                      <Field label="Create a password" htmlFor="ai-password" required
                        hint="At least 8 characters">
                        <div className="relative">
                          <Input
                            id="ai-password"
                            type={showPassword ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="new-password"
                            placeholder="••••••••"
                            className="h-11 pr-10 text-[15px]"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            tabIndex={-1}
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-fx-text3 transition-colors hover:text-fx-text2"
                          >
                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </Field>

                      <Field label="Confirm password" htmlFor="ai-confirm" required>
                        <Input
                          id="ai-confirm"
                          type={showPassword ? 'text' : 'password'}
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          autoComplete="new-password"
                          placeholder="••••••••"
                          className="h-11 text-[15px]"
                        />
                      </Field>

                      {error && (
                        <div className="rounded-[10px] px-3.5 py-3 text-[13px]"
                          style={{ background: 'var(--fx-red-tint)', color: 'var(--fx-red)' }} role="alert">
                          {error}
                        </div>
                      )}

                      <Button type="submit" variant="primary" disabled={submitting} className="h-11 w-full text-[15px]">
                        {submitting ? 'Creating your account…' : 'Create account'}
                      </Button>
                    </form>
                  </CardBody>
                </Card>

                <p className="mt-5 text-center text-[12px] text-fx-text3">
                  Already have an account? <button onClick={() => router.push('/bank/login')} className="underline" style={{ color: 'var(--fx-accent)' }}>Sign in</button>
                </p>
              </>
            )}
          </div>
        </div>

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
