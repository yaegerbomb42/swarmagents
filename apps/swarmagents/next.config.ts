import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  poweredByHeader: false,
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
