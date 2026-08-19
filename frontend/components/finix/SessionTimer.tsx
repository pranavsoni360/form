"use client";

// Idle-session countdown + warning modal for the bank staff and admin portals.
//
// WHY THIS EXISTS: `lib/hooks/useInactivityTimer.ts` was written for the public
// loan form and NO staff screen imported it, so until now a signed-in officer or
// bank admin was never logged out for being idle — the control existed on paper
// only. This component both enforces the timeout and, per the requirement,
// displays the remaining time continuously rather than only warning at the end.
//
// WHY ITS OWN TIMER instead of reusing useInactivityTimer: that hook is
// setTimeout-based and exposes no remaining time, so it cannot drive a visible
// countdown. This ticks once a second against a wall-clock deadline, which also
// makes it correct after the tab is backgrounded — a setTimeout chain in a
// throttled tab drifts badly, and drifting the wrong way here means a session
// that outlives its own timeout.
//
// The deadline is stored in a ref and compared to Date.now() on every tick, so
// the countdown is derived from real elapsed time, never from accumulated ticks.

import * as React from "react";
import { cn } from "@/lib/utils";
import { Modal, OverlayHeader } from "./Overlay";
import { Button } from "./Button";

/**
 * 15 minutes idle, warn at 14.
 *
 * Deliberately NOT the 4/5-minute constants in lib/utils/constants.ts: those
 * govern the public loan form, whose session is a short-lived OTP-verified
 * window. A back-office dashboard is worked in all day, and a 5-minute cut-off
 * would sign an officer out while they read a single application file.
 */
export const STAFF_IDLE_LOGOUT_MS = 15 * 60 * 1000;
export const STAFF_IDLE_WARNING_MS = 14 * 60 * 1000;

const ACTIVITY_EVENTS = ["mousedown", "keydown", "scroll", "touchstart", "mousemove"] as const;

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SessionTimer({
  onLogout,
  logoutMs = STAFF_IDLE_LOGOUT_MS,
  warningMs = STAFF_IDLE_WARNING_MS,
  /** Called when the user chooses to stay signed in — refresh server-side state here. */
  onExtend,
  className,
}: {
  onLogout: () => void;
  logoutMs?: number;
  warningMs?: number;
  onExtend?: () => void;
  className?: string;
}) {
  const deadline = React.useRef<number>(Date.now() + logoutMs);
  const [remaining, setRemaining] = React.useState(logoutMs);
  // Latched so the modal does not reappear on every tick once dismissed-by-activity
  // is impossible; it closes only via Stay signed in (which resets the deadline).
  const [warned, setWarned] = React.useState(false);
  const firedRef = React.useRef(false);

  const reset = React.useCallback(() => {
    deadline.current = Date.now() + logoutMs;
    setRemaining(logoutMs);
    setWarned(false);
  }, [logoutMs]);

  // Activity resets the deadline — but NOT while the warning is up. Once warned,
  // an incidental mousemove must not silently extend the session: the user has
  // to make the choice explicitly, which is the point of the modal.
  React.useEffect(() => {
    if (warned) return;
    const onActivity = () => {
      deadline.current = Date.now() + logoutMs;
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
  }, [warned, logoutMs]);

  React.useEffect(() => {
    const id = setInterval(() => {
      const left = deadline.current - Date.now();
      setRemaining(left);
      if (left <= 0) {
        if (!firedRef.current) {
          firedRef.current = true;
          onLogout();
        }
        return;
      }
      if (left <= logoutMs - warningMs) setWarned(true);
    }, 1000);
    return () => clearInterval(id);
  }, [logoutMs, warningMs, onLogout]);

  const stay = () => {
    reset();
    firedRef.current = false;
    onExtend?.();
  };

  // Under a minute reads amber, under 15s red — a countdown nobody notices is
  // not a warning.
  const urgent = remaining <= 15_000;
  const soon = remaining <= 60_000;

  return (
    <>
      <span
        className={cn("inline-flex items-center gap-1.5 text-[11px]", className)}
        title="Time until you are signed out for inactivity. Any activity resets it."
      >
        <span className="fx-mono text-fx-text3" aria-hidden>
          ◷
        </span>
        <span
          className="fx-mono"
          style={{ color: urgent ? "var(--fx-red)" : soon ? "var(--fx-amber)" : "var(--fx-text3)" }}
          // Announce only the last minute; a per-second live region for 15
          // minutes would be unusable with a screen reader.
          aria-live={soon ? "polite" : "off"}
        >
          {mmss(remaining)}
        </span>
      </span>

      <Modal open={warned && remaining > 0} onClose={stay} width={420}>
        <OverlayHeader
          title="Still there?"
          subtitle="You will be signed out for inactivity to protect this session."
          onClose={stay}
        />
        <div className="p-5">
          <div
            className="rounded-[14px] p-4 text-center"
            style={{ background: "var(--fx-amber-tint)" }}
          >
            <div className="fx-mono text-[26px] leading-none" style={{ color: "var(--fx-amber)" }}>
              {mmss(remaining)}
            </div>
            <p className="mt-1.5 text-[12px] text-fx-text2">until automatic sign-out</p>
          </div>
          <p className="mt-3 text-[11px] text-fx-text3">
            Anything you have not saved will be lost. Signing back in takes a moment.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-fx-border p-4">
          <Button variant="quiet" onClick={onLogout}>Sign out now</Button>
          <Button variant="primary" onClick={stay}>Stay signed in</Button>
        </div>
      </Modal>
    </>
  );
}
