'use client';

import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';

// Keeps BOTH theme mechanisms in lock-step so the whole page themes consistently:
//   • data-theme on <html>  → drives the Finix oklch token layer (--fx-*), which
//                             is what most of the loan form is styled with.
//   • .dark class on <html> → drives the residual Tailwind `dark:` utilities
//                             still present on this page.
// Previously this toggle flipped ONLY .dark, so the token surfaces never switched
// and dark mode looked half-applied. It also persists to both localStorage keys
// (finix.theme + los-theme) so the layout head script restores the theme
// pre-paint on reload.
type Theme = 'light' | 'dark';

function applyTheme(t: Theme) {
  const el = document.documentElement;
  el.setAttribute('data-theme', t);
  el.classList.toggle('dark', t === 'dark');
  try {
    localStorage.setItem('finix.theme', t);
    localStorage.setItem('los-theme', t);
  } catch {
    /* storage may be unavailable (private mode) — theme still applies for this view */
  }
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // data-theme is authoritative (the head script sets it pre-paint); fall back
    // to the .dark class. Then re-apply so BOTH mechanisms agree even if only one
    // was set previously (which is the bug this fixes).
    const el = document.documentElement;
    const isDark = el.getAttribute('data-theme') === 'dark' || el.classList.contains('dark');
    setDark(isDark);
    applyTheme(isDark ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    applyTheme(next ? 'dark' : 'light');
  };

  return (
    <button
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="p-2 rounded-xl transition-colors"
      style={{ background: 'var(--fx-surface2)', color: 'var(--fx-text2)' }}
    >
      {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}
