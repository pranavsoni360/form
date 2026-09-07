"use client";

import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, Bell, CheckCircle2, Eye, EyeOff, Info, KeyRound, LogOut, Moon, Sun, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { getAccessToken, logout } from "@/lib/auth";
import { API_URL } from "@/lib/api";
import { ConnectionDot } from "./ConnectionDot";
import { MobileNav } from "./MobileNav";

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

/* ─── Security notification center ───────────────────────────────────────── */

type SecNotif = { id: number; severity: string; title: string; event_type: string; created_at: string; bank_id: string | null };

function agoISO(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const SEV_BADGE: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  info: "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300",
};

function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<SecNotif[]>([]);
  const [count, setCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const fetchNotifs = React.useCallback(async () => {
    setLoading(true);
    try {
      const token = getAccessToken("admin");
      const res = await fetch(`${API_URL}/api/admin/notifications?limit=15`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
        setCount(data.count || 0);
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  // Poll the unread count every 30s so the badge stays live.
  React.useEffect(() => {
    fetchNotifs();
    const t = setInterval(fetchNotifs, 30000);
    return () => clearInterval(t);
  }, [fetchNotifs]);

  const acknowledge = async (id: number) => {
    try {
      const token = getAccessToken("admin");
      const res = await fetch(`${API_URL}/api/admin/audit/security/${id}/ack`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) { setItems((p) => p.filter((i) => i.id !== id)); setCount((c) => Math.max(0, c - 1)); }
    } catch {}
  };

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative hidden sm:block">
      <button
        onClick={() => { const n = !open; setOpen(n); if (n) fetchNotifs(); }}
        aria-label="Security notifications"
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-[10px] transition-colors"
        style={{ border: "1px solid var(--fx-border)", background: "var(--fx-surface2)", color: "var(--fx-text2)" }}
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-destructive px-1 text-[9px] font-bold text-white ring-2 ring-card">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-[14px] shadow-xl overflow-hidden" style={{ border: "1px solid var(--fx-border)", background: "var(--fx-surface)" }}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">Security alerts</span>
              {count > 0 && <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-bold text-destructive">{count}</span>}
            </div>
            <a href="/ops/audit" className="text-[10px] font-medium text-primary hover:underline">View all →</a>
          </div>

          <div className="max-h-[400px] overflow-y-auto divide-y divide-border">
            {loading ? (
              <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">Loading…</div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 opacity-30" />
                <p className="text-xs">No unread security alerts</p>
              </div>
            ) : (
              items.map((item) => (
                <div key={item.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-muted">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEV_BADGE[item.severity] || "bg-muted"}`}>
                        {item.severity}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{agoISO(item.created_at)}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-foreground line-clamp-2">{item.title}</p>
                    <button onClick={() => acknowledge(item.id)} className="mt-1 text-[10px] font-medium text-primary hover:underline">
                      Mark as read
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-border px-4 py-2.5 text-center">
            <a href="/ops/audit" className="text-xs font-medium text-primary hover:underline">Open Audit &amp; Security →</a>
          </div>
        </div>
      )}
    </div>
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
          className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 pr-3 transition-colors"
          style={{ border: "1px solid var(--fx-border)", background: "var(--fx-surface2)", color: "var(--fx-text)" }}
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
          <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-[14px] shadow-lg" style={{ border: "1px solid var(--fx-border)", background: "var(--fx-surface)" }}>
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

function useTodayLabel() {
  const [label, setLabel] = React.useState("");
  React.useEffect(() => {
    const d = new Date();
    const day = d.getDate();
    const month = d.toLocaleDateString("en-GB", { month: "short" });
    const year = d.getFullYear();
    setLabel(`Today, ${day} ${month} ${year}`);
  }, []);
  return label;
}

export function TopBar() {
  const pathname = usePathname();
  const crumbs = derivedCrumbs(pathname || "/ops");
  const todayLabel = useTodayLabel();

  return (
    <header
      className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 px-3 sm:gap-4 sm:px-5"
      style={{ borderBottom: "1px solid var(--fx-border)", background: "var(--fx-surface)" }}
    >
      {/* Mobile hamburger */}
      <MobileNav />

      {/* Date pill */}
      {todayLabel && (
        <div
          className="hidden lg:flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-[12px] flex-shrink-0"
          style={{ border: "1px solid var(--fx-border)", color: "var(--fx-text2)" }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0" style={{ color: "var(--fx-text3)" }}>
            <rect x="1" y="2" width="14" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M1 6h14" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 1v2M11 1v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {todayLabel}
        </div>
      )}

      {/* Breadcrumb — "VGIL / ops / page" */}
      <nav className="flex min-w-0 items-center gap-1.5" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.href + i}>
            {i > 0 && (
              <span className="text-[12px] select-none" style={{ color: "var(--fx-border-strong)" }}>/</span>
            )}
            <span
              className="text-[13px]"
              style={{ color: i === crumbs.length - 1 ? "var(--fx-text)" : "var(--fx-text2)", fontWeight: i === crumbs.length - 1 ? 600 : 400 }}
            >
              {c.label}
            </span>
          </React.Fragment>
        ))}
      </nav>

      {/* Right actions */}
      <div className="ml-auto flex items-center gap-1.5">
        <ConnectionDot className="mr-1 hidden lg:inline-flex" />
        <NotificationBell />
        <UserPill />
      </div>
    </header>
  );
}


/* ─── Breadcrumb helper ───────────────────────────────────────────────────── */

function derivedCrumbs(pathname: string): { href: string; label: string }[] {
  const parts = pathname.split("/").filter(Boolean);
  // /ops → "VGIL / ops / dashboard"
  // /ops/calls → "VGIL / ops / all calls"
  const org = { href: "/ops", label: "VGIL" };
  const ops = { href: "/ops", label: "ops" };
  if (parts[0] === "ops") {
    if (parts.length === 1) return [org, ops, { href: "/ops", label: "dashboard" }];
    const last = parts[parts.length - 1];
    return [org, ops, { href: pathname, label: last.replace(/-/g, " ") }];
  }
  if (parts[0] === "admin") {
    const admin = { href: "/admin/dashboard", label: "admin" };
    if (parts.length === 1) return [org, admin];
    const last = parts[parts.length - 1];
    return [org, admin, { href: pathname, label: last.replace(/-/g, " ") }];
  }
  let acc = "";
  return [org, ...parts.map((p) => {
    acc += "/" + p;
    return { href: acc, label: p.replace(/-/g, " ") };
  })];
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
