/**
 * BYOC hub server entry.
 *
 * Runs the node-facing websocket server as its own process (the same shape
 * as the desktop proxy, lib/desktop-proxy/server.ts). The app normally
 * starts the hub in-process from instrumentation.ts; this entry exists for
 * deployments that run it separately and for local development:
 *
 *   SWARM_BYOC_PORT=3779 npx tsx lib/byoc/server.ts
 */

import { ByocHub } from "./hub";
import { BYOC_DEFAULT_PORT } from "../../packages/swarm-node/src/protocol";

const hub = new ByocHub({
  port: Number(process.env.SWARM_BYOC_PORT ?? BYOC_DEFAULT_PORT),
  host: process.env.SWARM_BYOC_HOST ?? "127.0.0.1",
});

hub.listen().then(() => {
  console.log(`[byoc-hub] listening on ${hub.host}:${hub.port}`);
}).catch((err) => {
  console.error("[byoc-hub] failed to start:", err);
  process.exit(1);
});

function shutdown() {
  hub.close().finally(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
