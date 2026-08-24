"use client";

// Notification bell for the BANK portal (bank admin + branch). Uses the bank
// token and the bank-scoped endpoints, so the server returns only the caller's
// bank/branch security alerts. Mirrors the platform bell in the ops TopBar.

import * as React from "react";
import { Bell, AlertTriangle, CheckCircle2 } from "lucide-react";
import { API_URL } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";

type SecNotif = { id: number; severity: string; title: string; event_type: string; created_at: string };

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

export function BankNotificationBell({ auditHref = "/bank/audit" }: { auditHref?: string }) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<SecNotif[]>([]);
  const [count, setCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const fetchNotifs = React.useCallback(async () => {
    setLoading(true);
    try {
      const token = getAccessToken("bank");
      const res = await fetch(`${API_URL}/api/bank/notifications?limit=15`, {
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

  React.useEffect(() => {
    fetchNotifs();
    const t = setInterval(fetchNotifs, 30000);
    return () => clearInterval(t);
  }, [fetchNotifs]);

  const acknowledge = async (id: number) => {
    try {
      const token = getAccessToken("bank");
      const res = await fetch(`${API_URL}/api/bank/audit/security/${id}/ack`, {
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
    <div ref={ref} className="relative">
      <button
        onClick={() => { const n = !open; setOpen(n); if (n) fetchNotifs(); }}
        aria-label="Security notifications"
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-xl border border-fx-surface2 bg-fx-surface2 text-fx-text3 transition-colors hover:bg-fx-surface"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white ring-2 ring-fx-surface">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-fx-surface2 bg-fx-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-fx-surface2 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-fx-text3" />
              <span className="text-sm font-semibold text-fx-text">Security alerts</span>
              {count > 0 && <span className="rounded-full bg-red-600/10 px-1.5 py-0.5 text-[10px] font-bold text-red-600">{count}</span>}
            </div>
            <a href={auditHref} className="text-[10px] font-medium text-fx-accent hover:underline">View all →</a>
          </div>

          <div className="max-h-[400px] divide-y divide-fx-surface2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-10 text-xs text-fx-text3">Loading…</div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-fx-text3">
                <CheckCircle2 className="h-8 w-8 opacity-30" />
                <p className="text-xs">No unread security alerts</p>
              </div>
            ) : (
              items.map((item) => (
                <div key={item.id} className="flex items-start gap-3 px-4 py-3 hover:bg-fx-surface2">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-fx-surface2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEV_BADGE[item.severity] || "bg-fx-surface2"}`}>
                        {item.severity}
                      </span>
                      <span className="text-[10px] text-fx-text3">{agoISO(item.created_at)}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-fx-text line-clamp-2">{item.title}</p>
                    <button onClick={() => acknowledge(item.id)} className="mt-1 text-[10px] font-medium text-fx-accent hover:underline">
                      Mark as read
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
