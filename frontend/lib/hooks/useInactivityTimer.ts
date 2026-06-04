// lib/hooks/useInactivityTimer.ts
'use client';

import { useEffect, useRef, useCallback } from 'react';
import {
  INACTIVITY_WARNING_MS,
  INACTIVITY_LOGOUT_MS,
} from '@/lib/utils/constants';

const ACTIVITY_EVENTS = [
  'mousedown',
  'keypress',
  'scroll',
  'touchstart',
  'mousemove',
] as const;

interface UseInactivityTimerOptions {
  enabled?: boolean;
  warningMs?:  number;
  logoutMs?:   number;
  onWarning:   () => void;   // show warning modal / toast
  onLogout:    () => void;   // execute logout + redirect
}

export function useInactivityTimer({
  enabled     = true,
  warningMs   = INACTIVITY_WARNING_MS,
  logoutMs    = INACTIVITY_LOGOUT_MS,
  onWarning,
  onLogout,
}: UseInactivityTimerOptions) {
  const warningTimer = useRef<NodeJS.Timeout | null>(null);
  const logoutTimer  = useRef<NodeJS.Timeout | null>(null);
  const warned       = useRef(false);

  const clearTimers = useCallback(() => {
    if (warningTimer.current) clearTimeout(warningTimer.current);
    if (logoutTimer.current)  clearTimeout(logoutTimer.current);
  }, []);

  const resetTimers = useCallback(() => {
    if (!enabled) return;
    clearTimers();
    warned.current = false;

    warningTimer.current = setTimeout(() => {
      warned.current = true;
      onWarning();

      // After warning fires, start the final logout countdown
      logoutTimer.current = setTimeout(() => {
        onLogout();
      }, logoutMs - warningMs);
    }, warningMs);
  }, [enabled, clearTimers, onWarning, onLogout, warningMs, logoutMs]);

  useEffect(() => {
    if (!enabled) return;

    resetTimers();

    ACTIVITY_EVENTS.forEach(event =>
      window.addEventListener(event, resetTimers, { passive: true })
    );

    return () => {
      clearTimers();
      ACTIVITY_EVENTS.forEach(event =>
        window.removeEventListener(event, resetTimers)
      );
    };
  }, [enabled, resetTimers, clearTimers]);

  // Call this when user confirms they want to stay logged in
  const extendSession = useCallback(() => {
    resetTimers();
  }, [resetTimers]);

  return { extendSession };
}