import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets parallel builds/dev servers use separate output dirs (NEXT_DIST_DIR=.next-x). Default unchanged.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Server-only packages with native/dynamic requires stay out of the bundle.
  serverExternalPackages: ["playwright-core", "@modelcontextprotocol/sdk"],
  devIndicators: false,
  // The monorepo has its own lockfile higher up; this app is self-contained.
  outputFileTracingRoot: root,
  webpack: (config) => {
    config.resolve.alias["@"] = root;
    return config;
  },
};
export default nextConfig;
