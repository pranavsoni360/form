"use client";

// UserMenu — circular avatar in the AppBar that opens a dropdown.
// Contains: identity header, account settings, sign out.
// Keyboard accessible: Enter/Space opens, Arrow keys navigate items, Escape closes.
//
// NOTE: the idle-session countdown/warning (<SessionTimer>) is deliberately NOT
// rendered here. This dropdown unmounts when closed, and SessionTimer owns the
// whole idle mechanism (timer + activity listeners + warning modal), so it must
// live in the always-mounted AppBar. It is rendered in Shell.tsx's AppBar.

import * as React from "react";
import Link from "next/link";

export type UserMenuProps = {
  name: string;
  initials: string;
  role: string;
  tenant: string;
  onLogout: () => void;
};

export function UserMenu({
  name,
  initials,
  role,
  tenant,
  onLogout,
}: UserMenuProps) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const itemsRef = React.useRef<HTMLElement[]>([]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !menuRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Escape closes and returns focus to trigger.
  React.useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Arrow key navigation within menu items.
  function handleMenuKeyDown(e: React.KeyboardEvent) {
    const items = itemsRef.current.filter(Boolean);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    }
  }

  // Register focusable menu items.
  function itemRef(el: HTMLElement | null, index: number) {
    if (el) itemsRef.current[index] = el;
  }

  return (
    <div className="relative">
      {/* Avatar button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`User menu for ${name}`}
        className="grid h-8 w-8 place-items-center rounded-full text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
        style={{
          background: "var(--fx-accent-grad)",
          boxShadow: "var(--fx-accent-glow)",
          letterSpacing: "0.04em",
        }}
      >
        {initials}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={handleMenuKeyDown}
          className="fx-menu absolute right-0 top-[calc(100%+8px)] z-50 min-w-[224px] rounded-[12px] p-1"
          style={{
            background: "var(--fx-surface)",
            boxShadow: "var(--fx-elevation), inset 0 0 0 1px var(--fx-border)",
          }}
        >
          {/* Identity header */}
          <div className="px-3 py-2.5">
            <div className="text-[13px] font-medium text-fx-text">{name}</div>
            <div className="mt-0.5 text-[11px] text-fx-text3">
              {tenant} · {role}
            </div>
          </div>

          <div className="my-1 h-px" style={{ background: "var(--fx-border)" }} />

          {/* Account settings */}
          <Link
            href="/bank/admin/settings"
            role="menuitem"
            ref={(el) => itemRef(el, 0)}
            onClick={() => setOpen(false)}
            className="flex h-9 items-center rounded-[8px] px-3 text-[13px] text-fx-text2 transition-colors hover:bg-fx-surface2 hover:text-fx-text focus:bg-fx-surface2 focus:text-fx-text focus:outline-none"
          >
            Account settings
          </Link>

          <div className="my-1 h-px" style={{ background: "var(--fx-border)" }} />

          {/* Sign out */}
          <button
            type="button"
            role="menuitem"
            ref={(el) => itemRef(el, 1)}
            onClick={() => { setOpen(false); onLogout(); }}
            className="flex h-9 w-full items-center rounded-[8px] px-3 text-[13px] text-left transition-colors hover:bg-fx-surface2 focus:bg-fx-surface2 focus:outline-none"
            style={{ color: "var(--fx-red)" }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
