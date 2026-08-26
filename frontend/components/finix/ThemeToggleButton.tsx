"use client";

// Small theme toggle for Finix pages that render OUTSIDE the app shell (e.g. the
// login screens). Must be used inside a <FinixThemeProvider>. Flips the Finix
// data-theme token layer via useFinixTheme().
import { Sun, Moon } from "lucide-react";
import { useFinixTheme } from "./theme";

export function FinixThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useFinixTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={`grid h-9 w-9 place-items-center rounded-[10px] transition-colors hover:bg-fx-surface2 ${className}`}
      style={{ background: "var(--fx-surface2)", color: "var(--fx-text2)", border: "1px solid var(--fx-border)" }}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
