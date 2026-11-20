/**
 * Compute-target policy for the composer picker.
 *
 * Two kinds of compute exist:
 *   - "cloud" — the SwarmAgents VM pool (the existing server-side VM runtime);
 *   - a paired computer — the user's own machine, addressed as
 *     `computer:<id>`.
 *
 * Free-tier accounts default to BYOC when the cloud VM pool is full. Paid
 * accounts always default to the cloud. This module is pure: the route supplies
 * the live pool usage and the caller's computer list.
 */

import type { Computer } from "./store";

export const CLOUD_TARGET = "cloud";
export const COMPUTE_TARGET_RE = /^(cloud|computer:cmp_[a-f0-9-]{8,64})$/i;
const DEFAULT_CLOUD_POOL_CAPACITY = 5;

export interface RunCompute {
  kind: "cloud" | "computer";
  /** Set for a paired computer. */
  computerId?: string;
  /** Human-readable computer name at run time. */
  name?: string;
}

export type ComputeTarget = { kind: "cloud" } | { kind: "computer"; computerId: string };

/** Parse a stored/requested target. Returns null for anything malformed. */
export function parseComputeTarget(value: unknown): ComputeTarget | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === CLOUD_TARGET) return { kind: "cloud" };
  const match = /^computer:(cmp_[a-f0-9-]{8,64})$/i.exec(trimmed);
  if (!match) return null;
  return { kind: "computer", computerId: match[1].toLowerCase() };
}

/** Canonical string form (`cloud` / `computer:<id>`). */
export function formatComputeTarget(computerId: string): string {
  return `computer:${computerId}`;
}

/** True when the value is a well-formed compute target. */
export function isComputeTarget(value: unknown): value is string {
  return typeof value === "string" && COMPUTE_TARGET_RE.test(value.trim());
}

export interface CloudPoolStatus {
  capacity: number;
  inUse: number;
  full: boolean;
}

/** Live cloud-pool capacity. `SWARM_CLOUD_POOL_CAPACITY=0` simulates a full pool. */
export function cloudPoolStatus(inUse: number, env: NodeJS.ProcessEnv = process.env): CloudPoolStatus {
  const raw = env.SWARM_CLOUD_POOL_CAPACITY?.trim();
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  const capacity = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_CLOUD_POOL_CAPACITY;
  const used = Number.isFinite(inUse) && inUse > 0 ? Math.floor(inUse) : 0;
  return { capacity, inUse: used, full: capacity === 0 || used >= capacity };
}

/**
 * Free tier is the default. `SWARM_PAID_USERS` is a comma-separated list of
 * account ids that are exempt (there is no billing provider wired into this
 * app yet, so the plan lives in deployment config).
 */
export function isFreeTier(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // local_<email> ids can vary in casing; compare both sides case-insensitively
  // so a paid user is recognized regardless of how the plan config spells it.
  const normalized = userId.trim().toLowerCase();
  const paid = (env.SWARM_PAID_USERS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return !paid.includes(normalized);
}

/**
 * The target a fresh picker should use when nothing is remembered:
 * cloud unless this is a free-tier account, the cloud pool is full, and at
 * least one computer is online. The newest-heartbeating online computer wins.
 */
export function defaultComputeTarget(input: {
  freeTier: boolean;
  poolFull: boolean;
  computers: readonly Computer[];
}): string {
  const online = input.computers
    .filter((computer) => computer.online)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || b.createdAt - a.createdAt);
  if (input.freeTier && input.poolFull && online.length > 0) {
    return formatComputeTarget(online[0].id);
  }
  return CLOUD_TARGET;
}

/** Display label for a target, falling back to "SwarmAgents cloud". */
export function computeTargetLabel(target: unknown, computers: readonly Computer[]): string {
  const parsed = parseComputeTarget(target);
  if (!parsed || parsed.kind === "cloud") return "SwarmAgents cloud";
  return computers.find((computer) => computer.id === parsed.computerId)?.name ?? "Your computer";
}
