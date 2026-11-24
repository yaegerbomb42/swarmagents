/**
 * Desktop proxy server entry. Started from instrumentation.ts alongside the
 * Next.js standalone server. The proxy is a plain Node HTTP server on an
 * internal port (default 127.0.0.1:3778); production routes the public
 * `/desktop/` path to it (see DEPLOY.md) and the proxy serves the user's VM
 * desktop through the app's session cookie gate.
 */

import { createDesktopProxy } from "./proxy";

// Frame tap (damage-region differencing + keyframe capture) is opt-in:
// SWARM_DESKTOP_FRAME_TAP=1 enables per-session keyframe capture readable
// at GET /desktop/keyframes. Off by default — zero overhead, no frames
// held in memory.
const proxy = createDesktopProxy({
  frameTap: process.env.SWARM_DESKTOP_FRAME_TAP === "1" ? {} : undefined,
});

proxy.listen().then(() => {
  console.log(`[desktop-proxy] listening on ${proxy.host}:${proxy.port} (${proxy.server.listening ? "up" : "down"})`);
}).catch((err) => {
  console.error("[desktop-proxy] failed to start:", err);
  process.exit(1);
});

function shutdown() {
  proxy.close().finally(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
