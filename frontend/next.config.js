/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  images: {
    domains: ['supabase.co'],
  },
  webpack: (config, { isServer }) => {
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

module.exports = nextConfig;
