import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const NO_STORE_HEADERS = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
  { key: "Pragma", value: "no-cache" },
];

const NO_STORE_ROUTES = ["/login", "/api/login", "/api/signup", "/api/me", "/api/health"];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  poweredByHeader: false,
  async headers() {
    return NO_STORE_ROUTES.map((source) => ({
      source,
      headers: NO_STORE_HEADERS,
    }));
  },
  env: {
    // Baked into the bundle at build time so /api/health always reports a
    // real builtAt even when the deploy never sets SWARM_BUILD_TIME. A deploy
    // may pin it explicitly (Dockerfile build arg or CI env); otherwise the
    // build timestamp is used. lib/health.ts reads this inlined value as its
    // fallback when the runtime env var is absent.
    SWARM_BUILD_TIME: process.env.SWARM_BUILD_TIME ?? new Date().toISOString(),
  },
};

export default nextConfig;
