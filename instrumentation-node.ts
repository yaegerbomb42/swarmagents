import { resumeActiveSessions } from "./lib/agent";

resumeActiveSessions();

// Bring up the durable runtime control plane (task scheduler + agent adapter). Idempotent.
// Added by atlas-runtime (lane F2) — see SWARM_GROUP_CHAT.md 18:06Z. Keeps background
// tasks running across restarts; harmless if unused.
import { bootstrapRuntime } from "./lib/runtime";
bootstrapRuntime();
