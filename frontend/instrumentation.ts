/**
 * Next.js 14 instrumentation hook.
 *
 * Required by @sentry/nextjs 8.x to wire the server + edge Sentry configs
 * into Next.js's runtime registration. Without this file, only the client
 * config auto-loads — SSR + Edge errors would be silently dropped.
 *
 * Pattern from https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Captures errors thrown from React Server Components + Route Handlers and
 * forwards them to Sentry. Without this, server-side React errors don't
 * surface in the Sentry dashboard.
 */
export async function onRequestError(
  err: unknown,
  request: {
    path: string;
    method: string;
    headers: { [key: string]: string };
  },
  context: {
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "render" | "route" | "action" | "middleware";
    renderSource:
      | "react-server-components"
      | "react-server-components-payload"
      | "server-rendering";
    revalidateReason: "on-demand" | "stale" | undefined;
    renderType: "dynamic" | "dynamic-resume";
  },
) {
  // Guarded — only fires if Sentry was actually initialized (DSN set).
  const Sentry = await import("@sentry/nextjs");
  if (typeof Sentry.captureRequestError === "function") {
    Sentry.captureRequestError(err, request, context);
  } else {
    Sentry.captureException(err);
  }
}
