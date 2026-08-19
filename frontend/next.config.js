/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  images: {
    domains: ['supabase.co'],
  },
  // ── Security headers (plan §16) ───────────────────────────────────────────
  // Applied to every response. HSTS/X-Frame-Options/nosniff/Referrer-Policy are
  // safe and unconditional. The CSP allows what the app actually uses: same-origin
  // API+SSE, Next.js inline hydration scripts/styles, the pincode lookup and Sentry.
  async headers() {
    const csp = [
      "default-src 'self'",
      // Next.js injects inline hydration scripts; keep 'unsafe-eval' so no Next/
      // library runtime feature is blocked (tightened later with nonces if adopted).
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.postalpincode.in https://sentry.io https://*.sentry.io https://*.ingest.sentry.io",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
  // Production source maps stay on the server so Sentry can symbolicate
  // stack traces, but `hideSourceMaps: true` below strips the public .map.js
  // references from client bundles (avoids leaking source to end users).
  productionBrowserSourceMaps: false,
  webpack: (config) => {
    // Suppress noisy warnings that come from @sentry/nextjs pulling in
    // OpenTelemetry, which uses dynamic require()s that webpack can't
    // statically analyze. These are runtime-fine; the warnings are
    // purely cosmetic. Known + tracked upstream by Sentry.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { module: /node_modules\/@opentelemetry\/instrumentation/ },
      { module: /node_modules\/require-in-the-middle/ },
    ];
    return config;
  },
};

// ─── Sentry wrapping ──────────────────────────────────────────────────────
// withSentryConfig uploads source maps to Sentry on build, auto-instruments
// API routes, and tunnels Sentry events through `/monitoring` to bypass
// ad-blockers. Becomes a no-op if `SENTRY_AUTH_TOKEN` is unset — base build
// still works, just no source-map upload (errors show minified traces).
//
// Required env at build time:
//   SENTRY_AUTH_TOKEN     — only needed for source-map upload (production)
//   SENTRY_ORG            — your Sentry org slug
//   SENTRY_PROJECT        — your Sentry frontend project slug
// Required env at runtime:
//   NEXT_PUBLIC_SENTRY_DSN — public DSN for browser SDK
//   NEXT_PUBLIC_LOS_ENV   — environment tag ("production", "staging", "dev")
let exportedConfig = nextConfig;
try {
  // Lazy-require so a missing @sentry/nextjs doesn't crash the build during
  // development. In practice it IS installed (package.json), but defensive.
  const { withSentryConfig } = require('@sentry/nextjs');

  exportedConfig = withSentryConfig(nextConfig, {
    // Build-time options
    org: process.env.SENTRY_ORG,           // e.g. "los-org"
    project: process.env.SENTRY_PROJECT,   // e.g. "los-frontend"
    authToken: process.env.SENTRY_AUTH_TOKEN, // needed for source-map upload

    // Print only errors during build; full output during local debugging
    silent: !process.env.CI,

    // Upload a larger set of source maps for prettier stack traces.
    widenClientFileUpload: true,

    // Route browser Sentry requests through /monitoring so ad-blockers don't
    // drop them. Server-side proxy automatically forwards to Sentry's ingest.
    tunnelRoute: '/monitoring',

    // Hide .map.js references from the browser bundle so users can't pull the
    // un-minified source. Maps still go to Sentry for symbolication.
    hideSourceMaps: true,

    // Disable Sentry's own logger inside the SDK to avoid console noise.
    disableLogger: true,

    // Auto-instrument Vercel Cron / Next.js Route Handlers.
    automaticVercelMonitors: true,
  });
} catch (err) {
  // Missing @sentry/nextjs at install time, or auth token errors — fall
  // back to the un-wrapped config so the app still builds and runs.
  console.warn('[next.config] Sentry wrap skipped:', err.message);
}

module.exports = exportedConfig;
