'use client';

// Bank login — Finix design migration (Job 2).
//
// SECURITY-CRITICAL, DO NOT REFACTOR: the masked-value password handling below
// (MASK / pwRef / snapSelection / handlePasswordInput / the showPassword effect
// / the post-submit wipe) is copied VERBATIM from the legacy page. The real
// password is never written into the input's DOM value — the field holds only
// bullet characters while hidden, and the true value lives solely in pwRef. Any
// "simplification" here would leak the plaintext into the DOM, so the mechanism
// is presentation-independent by design and stays exactly as it was.
//
// NO FEATURE LOSS otherwise:
//  - bankLogin -> setAccessToken/setCurrentUser, then role-based redirect
//    (bank_admin -> /bank/admin/users, everyone else -> /bank/dashboard).
//  - Error surface for bad credentials.
//  - Show/hide password toggle (tabIndex -1, aria-label both ways).
//  - "Forgot password?" modal telling the user to contact their administrator.
//  - Left marketing panel with the three feature lines, hidden below lg.
//  - autoComplete/spellCheck/autoCorrect/autoCapitalize off on both inputs, and
//    autoFocus on username.
//
// This page renders OUTSIDE BankUserShell (no session yet, no sidebar), so it
// mounts .finix-root itself via FinixThemeProvider.

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { bankLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import {
  FinixThemeProvider,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Modal,
  OverlayHeader,
} from '@/components/finix';
import { FinixLogoMark } from '@/components/shared/FinixLogo';

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} width={420}>
      <OverlayHeader
        title="Forgot password"
        subtitle="Password resets are handled by your administrator."
        onClose={onClose}
      />
      <div className="space-y-3 p-5">
        <p className="text-[13px] text-fx-text2">
          To reset your password, please contact your system administrator.
        </p>
        <div
          className="rounded-[10px] px-4 py-3 text-[12px]"
          style={{ background: 'var(--fx-accent-tint)', color: 'var(--fx-accent)' }}
        >
          Your administrator can reset your password from the admin portal.
        </div>
      </div>
      <div className="flex justify-end border-t border-fx-border p-4">
        <Button variant="primary" onClick={onClose}>Got it</Button>
      </div>
    </Modal>
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
      // Bank admins land in the admin portal; officers/supervisors on the queue.
      router.push(response.user?.role === 'bank_admin' ? '/bank/admin/users' : '/bank/dashboard');
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
    <FinixThemeProvider>
      <div className="finix-root flex min-h-screen">

        {/* ── LEFT PANEL — marketing, hidden below lg ── */}
        <div
          className="relative hidden w-[46%] select-none flex-col justify-between overflow-hidden p-12 lg:flex"
          style={{ background: 'var(--fx-surface)' }}
        >
          {/* Dot texture, same idiom as the legacy panel. */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.5]"
            style={{
              backgroundImage: 'radial-gradient(circle, var(--fx-border) 1px, transparent 1px)',
              backgroundSize: '28px 28px',
            }}
          />

          <div className="relative z-10 flex items-center gap-3">
            <FinixLogoMark size={32} shieldColor="#1B2A4A" className="shrink-0" />
            <div className="leading-tight">
              <div className="text-[13px] font-medium text-fx-text">Finix</div>
              <div className="text-[11px] text-fx-text3">Bank officer portal</div>
            </div>
          </div>

          <div className="relative z-10">
            <h1
              className="mb-4 text-[34px] font-medium leading-[1.15] text-fx-text"
              style={{ letterSpacing: '-0.02em' }}
            >
              Review and approve<br />loan applications<br />
              <span style={{ color: 'var(--fx-accent)' }}>efficiently.</span>
            </h1>
            <p className="mb-9 max-w-md text-[13px] leading-relaxed text-fx-text2">
              AI-assisted review pipeline with complete applicant profiles, document
              verification, and one-click approval workflows.
            </p>
            <div className="space-y-3">
              {[
                { glyph: '▤', text: 'View complete applicant profiles and documents' },
                { glyph: '✓', text: 'Officer and supervisor approval workflow' },
                { glyph: '◷', text: 'Real-time status updates and notifications' },
              ].map(({ glyph, text }) => (
                <div key={text} className="flex items-center gap-3">
                  <span
                    className="fx-mono grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] text-[12px] text-fx-text3"
                    style={{ background: 'var(--fx-surface2)' }}
                    aria-hidden
                  >
                    {glyph}
                  </span>
                  <p className="text-[13px] text-fx-text2">{text}</p>
                </div>
              ))}
            </div>
          </div>

          <p className="relative z-10 text-[11px] text-fx-text3">
            © 2026 Finix · Virtual Galaxy Infotech Limited · Authorized bank personnel only
          </p>
        </div>

        {/* ── RIGHT PANEL — the form ── */}
        <div className="relative flex flex-1 items-center justify-center p-8 lg:p-16">
          <div className="relative z-10 w-full max-w-sm">
            <div className="mb-6">
              <div
                className="mb-5 grid h-12 w-12 place-items-center rounded-[12px] text-[18px] text-white"
                style={{ background: 'var(--fx-accent-grad)', boxShadow: 'var(--fx-accent-glow)' }}
                aria-hidden
              >
                <span className="fx-mono">▤</span>
              </div>
              <h1 className="text-[22px] font-medium text-fx-text" style={{ letterSpacing: '-0.015em' }}>
                Bank portal
              </h1>
              <p className="mt-1 text-[12px] text-fx-text2">Sign in with your bank credentials</p>
            </div>

            <Card>
              <CardBody>
                <form onSubmit={handleLogin} className="space-y-4">
                  <Field label="Username" htmlFor="bank-username" required>
                    <Input
                      id="bank-username"
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      required
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="off"
                      placeholder="Enter your username"
                      className="h-[34px]"
                    />
                  </Field>

                  <div className="space-y-1.5">
                    <Field label="Password" htmlFor="bank-password" required>
                      <div className="relative">
                        {/*
                          UNCONTROLLED BY DESIGN — see the security note at the top.
                          No `value` prop: the DOM value is bullets while hidden and
                          the real password lives only in pwRef.
                        */}
                        <Input
                          id="bank-password"
                          type={showPassword ? 'text' : 'password'}
                          ref={pwInputRef}
                          defaultValue=""
                          required
                          autoComplete="off"
                          spellCheck={false}
                          autoCorrect="off"
                          autoCapitalize="off"
                          onKeyDown={e => snapSelection(e.key)}
                          onPaste={() => snapSelection()}
                          onCut={() => snapSelection()}
                          onChange={handlePasswordInput}
                          placeholder="••••••••"
                          className="h-[34px] pr-9"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(v => !v)}
                          tabIndex={-1}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="fx-mono absolute right-2.5 top-1/2 -translate-y-1/2 text-[13px] text-fx-text3 transition-colors hover:text-fx-text2"
                        >
                          {showPassword ? '◎' : '◉'}
                        </button>
                      </div>
                    </Field>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => setShowForgot(true)}
                        className="text-[11px] transition-colors hover:underline"
                        style={{ color: 'var(--fx-accent)' }}
                      >
                        Forgot password?
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div
                      className="rounded-[10px] px-3 py-2.5 text-[12px]"
                      style={{ background: 'var(--fx-red-tint)', color: 'var(--fx-red)' }}
                      role="alert"
                    >
                      {error}
                    </div>
                  )}

                  <Button
                    type="submit"
                    variant="primary"
                    disabled={loading}
                    className="h-[34px] w-full"
                  >
                    {loading ? 'Signing in…' : 'Sign in to bank portal'}
                  </Button>
                </form>
              </CardBody>
            </Card>

            <p className="mt-5 text-center text-[11px] text-fx-text3">
              Contact your administrator if you need access
            </p>
          </div>
        </div>

        {showForgot && <ForgotPasswordModal onClose={() => setShowForgot(false)} />}
      </div>
    </FinixThemeProvider>
  );
}
