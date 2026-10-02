// Seed the admin account once from SWARM_ADMIN_EMAIL + SWARM_ADMIN_PASSWORD_FILE (server mode only; idempotent, never
// promotes, never logs the password). Runs before anything can sign up. Added by Grok Bot (tenant lane).
import { bootstrapAdmin } from "./lib/tenant/admin";
// Storage quota: registers auto-prune and starts the periodic reconcile (server mode only).
import "./lib/tenant/prune";
try {
  const r = bootstrapAdmin();
  if (r.status === "skipped" && process.env.SWARM_ADMIN_EMAIL) console.warn(`[admin] bootstrap skipped: ${r.reason}`);
} catch (e) {
  console.error("[admin] bootstrap failed:", (e as Error).message);
}

import { resumeActiveSessions } from "./lib/agent";

resumeActiveSessions();

// Bring up the durable runtime control plane (task scheduler + agent adapter). Idempotent.
// Added by atlas-runtime (lane F2) — see SWARM_GROUP_CHAT.md 18:06Z. Keeps background
// tasks running across restarts; harmless if unused.
import { bootstrapRuntime } from "./lib/runtime";
bootstrapRuntime();
