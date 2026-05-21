// lib/hooks/useInactivityTimer.ts — fire onWarning after `warningMs` idle, then
// onLogout after `logoutMs` total idle. Listens for mouse / key / scroll /
// touch activity to reset the timers.
"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  INACTIVITY_WARNING_MS,
  INACTIVITY_LOGOUT_MS,
} from "@/lib/utils/constants";

const ACTIVITY_EVENTS = [
  "mousedown",
  "keypress",
  "scroll",
  "touchstart",
  "mousemove",
] as const;

interface UseInactivityTimerOptions {
  enabled?: boolean;
  warningMs?: number;
  logoutMs?: number;
  onWarning: () => void;
  onLogout: () => void;
}

export function useInactivityTimer({
  enabled = true,
  warningMs = INACTIVITY_WARNING_MS,
  logoutMs = INACTIVITY_LOGOUT_MS,
  onWarning,
  onLogout,
}: UseInactivityTimerOptions) {
  const warningTimer = useRef<NodeJS.Timeout | null>(null);
  const logoutTimer = useRef<NodeJS.Timeout | null>(null);
  const warned = useRef(false);

  const clearTimers = useCallback(() => {
    if (warningTimer.current) clearTimeout(warningTimer.current);
    if (logoutTimer.current) clearTimeout(logoutTimer.current);
  }, []);

  const resetTimers = useCallback(() => {
    if (!enabled) return;
    clearTimers();
    warned.current = false;

    warningTimer.current = setTimeout(() => {
      warned.current = true;
      onWarning();
      logoutTimer.current = setTimeout(() => {
        onLogout();
      }, logoutMs - warningMs);
    }, warningMs);
  }, [enabled, clearTimers, onWarning, onLogout, warningMs, logoutMs]);

  useEffect(() => {
    if (!enabled) return;
    resetTimers();
    ACTIVITY_EVENTS.forEach((event) =>
      window.addEventListener(event, resetTimers, { passive: true }),
    );
    return () => {
      clearTimers();
      ACTIVITY_EVENTS.forEach((event) =>
        window.removeEventListener(event, resetTimers),
      );
    };
  }, [enabled, resetTimers, clearTimers]);

  // Call when user dismisses the warning ("Stay logged in" button).
  const extendSession = useCallback(() => {
    resetTimers();
  }, [resetTimers]);

  return { extendSession };
}
