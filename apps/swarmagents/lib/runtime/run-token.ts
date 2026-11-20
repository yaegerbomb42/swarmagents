/**
 * Short-lived per-run LLM proxy tokens.
 *
 * The agent inside a user's VM authenticates to the server-side LLM
 * translation endpoint with a token minted for exactly one run. The token is
 * an HMAC-SHA256 signature over `{userId, runId, expiresAt}` keyed by
 * SWARM_SESSION_SECRET (the same secret that signs session cookies). The real
 * provider key never enters the VM — the token is the only credential the VM
 * ever sees.
 *
 * Expiry is enforced three ways, in increasing strictness:
 *   1. `expiresAt` inside the token (a backstop for crashed processes that
 *      can no longer revoke anything), default TTL SWARM_RUN_TOKEN_TTL_SEC.
 *   2. Explicit revocation: RuntimeManager revokes a run's token when the run
 *      finalizes, so a token dies exactly when its run does.
 *   3. The route additionally checks the run is still the user's active run.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "rt1";
const SECRET_ENV = "SWARM_SESSION_SECRET";
const DEFAULT_TTL_SEC = 12 * 60 * 60;
const MAX_REVOKED = 10_000;

/** Token TTL in seconds from SWARM_RUN_TOKEN_TTL_SEC (default 12h). */
export function runTokenTtlSec(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SWARM_RUN_TOKEN_TTL_SEC?.trim();
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_TTL_SEC;
}

function secret(env: Record<string, string | undefined>): string {
  const value = env[SECRET_ENV];
  if (!value) {
    throw new Error(`${SECRET_ENV} is required to mint run tokens.`);
  }
  return value;
}

/** base64url without padding (safe in URLs and headers). */
function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

interface RunTokenPayload {
  u: string;
  r: string;
  e: number;
}

export interface RunTokenOptions {
  /** Injectable clock (epoch seconds). Defaults to Date.now()/1000. */
  now?: number;
  /** Token TTL in seconds. Defaults to runTokenTtlSec(). */
  ttlSec?: number;
  /** Environment source for the secret. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Mint a per-run token for `userId`'s run `runId`. The token is scoped to
 * exactly that user + run and expires with the run (revocation + TTL).
 */
export function signRunToken(userId: string, runId: string, options: RunTokenOptions = {}): string {
  const env = options.env ?? process.env;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSec ?? runTokenTtlSec(env);
  const payload: RunTokenPayload = { u: userId, r: runId, e: now + ttl };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", secret(env)).update(`${PREFIX}:${body}`).digest("hex");
  return `${PREFIX}.${body}.${mac}`;
}

/**
 * Verify a run token. Returns the signed userId/runId/expiresAt when the
 * token is genuine, unexpired, not revoked and (when given) scoped to the
 * expected userId/runId; null otherwise.
 */
export function verifyRunToken(
  token: string,
  options: { now?: number; userId?: string; runId?: string; env?: Record<string, string | undefined> } = {},
): { userId: string; runId: string; expiresAt: number } | null {
  const env = options.env ?? process.env;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const parts = String(token).split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, mac] = parts;

  const expected = createHmac("sha256", secret(env)).update(`${PREFIX}:${body}`).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const raw = b64urlDecode(body);
  if (!raw) return null;
  let payload: RunTokenPayload;
  try {
    payload = JSON.parse(raw.toString("utf8")) as RunTokenPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.r !== "string" || typeof payload.e !== "number") {
    return null;
  }
  if (!Number.isFinite(payload.e) || payload.e <= now) return null;
  if (isRunTokenRevoked(payload.r)) return null;
  if (options.userId !== undefined && payload.u !== options.userId) return null;
  if (options.runId !== undefined && payload.r !== options.runId) return null;

  return { userId: payload.u, runId: payload.r, expiresAt: payload.e };
}

/** Revoked run ids (runId -> epoch ms of revocation). Bounded. */
const revoked = new Map<string, number>();

/** Revoke a run's token. Called when the run finalizes (finish/error/cancel). */
export function revokeRunToken(runId: string): void {
  if (!revoked.has(runId)) {
    revoked.set(runId, Date.now());
    if (revoked.size > MAX_REVOKED) {
      const oldest = revoked.keys().next().value;
      if (oldest !== undefined) revoked.delete(oldest);
    }
  }
}

/** True when a run's token has been revoked. */
export function isRunTokenRevoked(runId: string): boolean {
  return revoked.has(runId);
}

/** Test hook: clear revocation state. */
export function clearRevokedRunTokens(): void {
  revoked.clear();
}
