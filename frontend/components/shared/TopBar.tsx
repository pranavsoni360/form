"use client";

import { usePathname, useRouter } from "next/navigation";
import { Bell, ChevronRight, Eye, EyeOff, KeyRound, LogOut, Moon, Sun, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { getAccessToken, logout } from "@/lib/auth";
import { API_URL } from "@/lib/api";
import { ConnectionDot } from "./ConnectionDot";

/**
 * VirtualVaani-style top bar.
 *
 * Left:  breadcrumb path derived from the pathname (Admin › Dashboard)
 * Right: SSE connection dot · theme toggle · notification bell · user avatar pill
 */

/* ─── Change password modal ──────────────────────────────────────────────── */

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [showCurrent, setShowCurrent] = React.useState(false);
  const [showNext, setShowNext] = React.useState(false);
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [success, setSuccess] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (next.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (next !== confirm) { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      const token = getAccessToken("admin");
      const res = await fetch(`${API_URL}/api/auth/admin-change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail || "Failed to change password."); return; }
      setSuccess(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-foreground">Change Password</h2>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {success ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-success/10 text-success ring-1 ring-success/20">
                <KeyRound className="h-5 w-5" />
              </span>
              <p className="text-sm font-semibold text-foreground">Password updated!</p>
              <p className="text-xs text-muted-foreground">Your password has been changed successfully.</p>
              <button
                onClick={onClose}
                className="mt-1 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary/90"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <PasswordField
                label="Current password"
                value={current}
                onChange={setCurrent}
                show={showCurrent}
                onToggleShow={() => setShowCurrent((v) => !v)}
                autoComplete="current-password"
              />
              <PasswordField
                label="New password"
                value={next}
                onChange={setNext}
                show={showNext}
                onToggleShow={() => setShowNext((v) => !v)}
                autoComplete="new-password"
                hint="At least 8 characters"
              />
              <PasswordField
                label="Confirm new password"
                value={confirm}
                onChange={setConfirm}
                show={showConfirm}
                onToggleShow={() => setShowConfirm((v) => !v)}
                autoComplete="new-password"
              />
              {error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-border px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-60"
                >
                  {loading ? "Saving…" : "Update password"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function PasswordField({
  label, value, onChange, show, onToggleShow, autoComplete, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          type="button"
          onClick={onToggleShow}
          tabIndex={-1}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </label>
  );
}

/* ─── User pill ──────────────────────────────────────────────────────────── */

function UserPill() {
  const router = useRouter();
  const [name, setName] = React.useState("Admin");
  const [email, setEmail] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [showChangePw, setShowChangePw] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    try {
      const u = localStorage.getItem("los_admin_user");
      if (u) {
        const parsed = JSON.parse(u);
        const display = parsed?.username || parsed?.email?.split("@")[0] || "Admin";
        setName(display.charAt(0).toUpperCase() + display.slice(1));
        setEmail(parsed?.email || "");
      }
    } catch {}
  }, []);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleLogout = async () => {
    setOpen(false);
    await logout("admin");
    router.replace("/admin/login");
  };

  const initials = name.slice(0, 2).toUpperCase();

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-2 py-1.5 pr-3 transition-colors hover:bg-muted"
          aria-haspopup="true"
          aria-expanded={open}
        >
          <span
            className="grid h-7 w-7 place-items-center rounded-lg text-xs font-bold text-white ring-1 ring-blue-300/30"
            style={{ background: "linear-gradient(135deg, #1A1A2E 0%, #2563EB 100%)" }}
          >
            {initials}
          </span>
          <span className="text-xs font-semibold hidden sm:block">{name}</span>
        </button>

        {open && (
          <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-border bg-card shadow-lg ring-1 ring-black/5">
            {/* User info header */}
            <div className="px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2.5">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold text-white"
                  style={{ background: "linear-gradient(135deg, #1A1A2E 0%, #2563EB 100%)" }}
                >
                  {initials}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">{name}</p>
                  {email && (
                    <p className="text-[10px] text-muted-foreground truncate">{email}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-1.5 space-y-0.5">
              <button
                onClick={() => { setOpen(false); setShowChangePw(true); }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                Change password
              </button>
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
              >
                <LogOut className="h-3.5 w-3.5" />
                Log out
              </button>
            </div>
          </div>
        )}
      </div>

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </>
  );
}

export function TopBar({ title }: { title?: string }) {
  const pathname = usePathname();
  const crumbs = derivedCrumbs(pathname || "/ops");

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border bg-card/80 px-8 backdrop-blur-md">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.href + i}>
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span
              className={cn(
                i === crumbs.length - 1
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground"
              )}
            >
              {c.label}
            </span>
          </React.Fragment>
        ))}
        {title && (
          <span className="ml-3 hidden border-l border-border pl-3 text-xs text-muted-foreground lg:inline">
            {title}
          </span>
        )}
      </nav>

      {/* Right actions */}
      <div className="ml-auto flex items-center gap-2">
        <ConnectionDot className="mr-1 hidden lg:inline-flex" />

        <ThemeToggle />

        <button
          aria-label="Notifications"
          className="relative grid h-9 w-9 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Bell className="h-4 w-4" />
          <span
            className="absolute right-2 top-2 grid h-2 w-2 place-items-center rounded-full bg-destructive ring-2 ring-card"
            aria-hidden
          />
        </button>

        {/* User avatar pill */}
        <UserPill />
      </div>
    </header>
  );
}


/* ─── Breadcrumb helper ───────────────────────────────────────────────────── */

function derivedCrumbs(pathname: string): { href: string; label: string }[] {
  const parts = pathname.split("/").filter(Boolean);
  // /ops → ["ops"] → "Admin › Dashboard"
  // /ops/live → ["ops","live"] → "Admin › Live Calls"
  if (parts[0] === "ops") {
    const root = { href: "/ops", label: "Admin" };
    if (parts.length === 1) return [root, { href: "/ops", label: "Dashboard" }];
    const last = parts[parts.length - 1];
    return [root, { href: pathname, label: prettify(last) }];
  }
  // Fallback for any other route — Title Case each segment
  let acc = "";
  return parts.map((p) => {
    acc += "/" + p;
    return { href: acc, label: prettify(p) };
  });
}

function prettify(s: string): string {
  return s
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ─── Theme toggle ────────────────────────────────────────────────────────── */

function ThemeToggle() {
  const [isDark, setIsDark] = React.useState(false);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !isDark;
    setIsDark(next);
    try {
      if (next) {
        document.documentElement.classList.add("dark");
        localStorage.setItem("los-theme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        localStorage.setItem("los-theme", "light");
      }
    } catch {
      /* localStorage unavailable — toggle still works for the session */
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="grid h-9 w-9 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
