"use client";

// Finix theme controller (design_handoff_finix/README.md §Theme switching).
//
// The choice persists in localStorage under `finix.theme` and is restored on
// load; it falls back to the `defaultTheme` prop. The active theme is written
// to `data-theme` on <html> so the oklch token layer in globals.css
// (.finix-root) resolves. A pre-paint inline script in app/layout.tsx sets the
// same attribute to avoid a flash before hydration.
//
// DEFAULT IS LIGHT, deliberately diverging from the handoff spec's dark
// default: this app has always been light-by-default (legacy `los-theme`), and
// the Job-2 migration must not flip the theme for users who never chose dark.
// The layout head script seeds `finix.theme` from `los-theme` on first run, so
// existing dark-mode users keep dark. This default must stay in sync with that
// script's fallback — if they disagree, migrated screens flash the wrong theme
// before hydration.

import * as React from "react";

export type FinixTheme = "dark" | "light";

const STORAGE_KEY = "finix.theme";

type Ctx = { theme: FinixTheme; setTheme: (t: FinixTheme) => void; toggle: () => void };
const ThemeContext = React.createContext<Ctx | null>(null);

function readStored(): FinixTheme | null {
  if (typeof window === "undefined") return null;
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

export function FinixThemeProvider({
  children,
  defaultTheme = "light",
}: {
  children: React.ReactNode;
  defaultTheme?: FinixTheme;
}) {
  // Start from the prop so SSR and first client render agree; reconcile with
  // localStorage in an effect (the head script already painted the right one).
  const [theme, setThemeState] = React.useState<FinixTheme>(defaultTheme);

  React.useEffect(() => {
    const stored = readStored();
    if (stored) setThemeState(stored);
  }, []);

  const apply = React.useCallback((t: FinixTheme) => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", t);
    }
  }, []);

  React.useEffect(() => {
    apply(theme);
  }, [theme, apply]);

  const setTheme = React.useCallback((t: FinixTheme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* private-mode / storage disabled — the in-memory state still updates */
    }
    setThemeState(t);
  }, []);

  const toggle = React.useCallback(
    () => setTheme(theme === "dark" ? "light" : "dark"),
    [theme, setTheme],
  );

  const value = React.useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useFinixTheme(): Ctx {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useFinixTheme must be used within a FinixThemeProvider");
  return ctx;
}
