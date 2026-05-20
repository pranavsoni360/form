/**
 * Sentry browser SDK init.
 * No-op if NEXT_PUBLIC_SENTRY_DSN is unset — safe for local dev.
 *
 * PII scrub mirrors backend so frontend + backend events look consistent
 * in the Sentry dashboard.
 */
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/sentry-scrub";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NEXT_PUBLIC_LOS_ENV || "development",
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
    // Session replay disabled for now — re-enable selectively later.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
    beforeBreadcrumb(crumb) {
      // Drop console.log noise; keep navigation, fetch, ui interactions.
      if (crumb.category === "console" && crumb.level !== "error") return null;
      return crumb;
    },
  });
}
