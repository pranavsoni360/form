// lib/hooks/useAutoSave.ts — debounced auto-save for the customer apply form.
// Calls /api/autosave-session every 2s of formData inactivity.
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { autoSaveSession } from "@/lib/api/apply";
import { AUTOSAVE_DEBOUNCE_MS } from "@/lib/utils/constants";

export type AutoSaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutoSaveOptions {
  sessionToken: string | null;
  formData: Record<string, any>;
  enabled?: boolean;
  debounceMs?: number;
  onError?: (err: Error) => void;
}

export function useAutoSave({
  sessionToken,
  formData,
  enabled = true,
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  onError,
}: UseAutoSaveOptions) {
  const [status, setStatus] = useState<AutoSaveStatus>("idle");
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const latestData = useRef(formData);

  useEffect(() => {
    latestData.current = formData;
  }, [formData]);

  const save = useCallback(async () => {
    if (!sessionToken || !enabled) return;
    setStatus("saving");
    try {
      await autoSaveSession(sessionToken, latestData.current);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("error");
      onError?.(err as Error);
    }
  }, [sessionToken, enabled, onError]);

  useEffect(() => {
    if (!enabled || !sessionToken) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(save, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [formData, enabled, sessionToken, debounceMs, save]);

  // Force-save immediately — use on step change or beforeunload.
  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    return save();
  }, [save]);

  return { status, flush };
}
