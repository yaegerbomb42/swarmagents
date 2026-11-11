import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  transpilePackages: ['three', '@react-three/fiber', '@react-three/drei', '@react-three/rapier'],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  webpack: (config, { isServer }) => {
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });
    config.resolve = config.resolve || {};
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      path: false,
    };
    return config;
  },
  async redirects() {
    return [
      { source: "/landing", destination: "/", permanent: true },
      { source: "/pitch", destination: "/", permanent: true },
      { source: "/models", destination: "/", permanent: true },
      { source: "/onboarding", destination: "/decomp", permanent: false },
      { source: "/dashboard", destination: "/decomp", permanent: true },
      { source: "/dashboard/:path*", destination: "/decomp", permanent: true },
      { source: "/zero", destination: "/decomp", permanent: true },
      { source: "/workstation", destination: "/decomp", permanent: true },
      { source: "/quantum", destination: "/decomp", permanent: true },
      { source: "/decomposition", destination: "/decomp", permanent: true },
      { source: "/decomposition/:projectId", destination: "/decomp", permanent: true },
      { source: "/decompose", destination: "/decomp", permanent: true },
      { source: "/decomp/orchestrator", destination: "/decomp", permanent: true },
      { source: "/studio", destination: "/decomp/fleet", permanent: true },
      { source: "/system", destination: "/decomp/system", permanent: true },
      { source: "/dataset", destination: "/datasets", permanent: true },
      { source: "/thanks", destination: "/datasets/thanks", permanent: false },
    ];
  },
  async rewrites() {
    // NOTE: /api/engine/* is handled by the catch-all route handler
    // at app/api/engine/[...path]/route.ts which proxies to ENGINE_URL.
    // ENGINE_URL defaults to http://localhost:8000 (decomposition_server.py).
    // Set ENGINE_URL env var to point to a remote engine in production.
    return [];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  sourcemaps: { disable: true },
});
