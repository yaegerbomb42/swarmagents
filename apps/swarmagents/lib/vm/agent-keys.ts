// Per-agent VM owner keys (lib/vm/agent-keys.ts).
//
// Pure, dependency-free key derivation: the desktop proxy (which compiles
// a narrow tree — see tsconfig.desktop-proxy.json) imports this directly,
// while lib/vm/agent-allocation.ts builds the allocator on top of it.
//
// An agent is identified by (userId, agentId). The default agent is A1
// ("a1"): its owner key IS the plain userId, so the per-user VM every
// existing run uses today is A1's VM — no migration, no orphaned
// containers. A named agent gets `agent:<agentId>:<userId>`, which the
// docker driver turns into a distinct container, volume, and owner label
// (see ownerKeyFor in docker-driver.ts: the SHA-256 fingerprint of the
// full key makes the mapping injective).

/** The agent every user gets by default: A1. Its VM is the per-user VM. */
export const DEFAULT_AGENT_ID = "a1";

/** Agent ids are single path-safe tokens: letters, digits, dot, dash, underscore. */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True when `value` is a usable agent id (no validation error). */
export function isValidAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_RE.test(value);
}

/**
 * Validate an agent id, returning it unchanged. Throws when the id is
 * missing, too long, or contains characters outside `[A-Za-z0-9._-]` —
 * an id reaches docker resource names (via the owner-key hash) and the
 * desktop-proxy query string, so it must never carry `/`, whitespace, or
 * anything else that could escape its slot.
 */
export function validateAgentId(agentId: unknown): string {
  if (typeof agentId !== "string" || agentId === "") {
    throw new Error("agentId must be a non-empty string");
  }
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `Invalid agentId "${agentId}": use 1-64 characters of [A-Za-z0-9._-] starting with an alphanumeric.`,
    );
  }
  return agentId;
}

/**
 * The VmManager owner key for an agent. The default agent (A1) maps to the
 * plain userId — its VM is the existing per-user VM. Any other agent maps
 * to `agent:<agentId>:<userId>`, which the docker driver turns into a
 * distinct container, volume, and owner label (see ownerKeyFor: the
 * SHA-256 fingerprint of the full key makes the mapping injective, so two
 * agents can never collide even when their readable slugs would).
 */
export function agentOwnerKey(userId: string, agentId: string = DEFAULT_AGENT_ID): string {
  if (agentId === DEFAULT_AGENT_ID) return userId;
  return `agent:${validateAgentId(agentId)}:${userId}`;
}

/** True when this is the default agent (A1) — its VM is the per-user VM. */
export function isDefaultAgent(agentId: string): boolean {
  return agentId === DEFAULT_AGENT_ID;
}
