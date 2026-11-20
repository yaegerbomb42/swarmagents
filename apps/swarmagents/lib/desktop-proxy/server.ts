/**
 * Desktop proxy server entry. Started from instrumentation.ts alongside the
 * Next.js standalone server. The proxy is a plain Node HTTP server on an
 * internal port (default 127.0.0.1:3778); production routes the public
 * `/desktop/` path to it (see DEPLOY.md) and the proxy serves the user's VM
 * desktop through the app's session cookie gate.
 */

import { createDesktopProxy } from "./proxy";

const proxy = createDesktopProxy();

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
