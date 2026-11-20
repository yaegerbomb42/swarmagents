/**
 * Ephemeral vault tokens. HMAC over {user, run, expiry, secret ids}.
 * The payload never contains a credential.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sv1";
const SECRET_ENV = "SWARM_SESSION_SECRET";
const DEFAULT_TTL_SEC = 12 * 60 * 60;
const MAX_REVOKED = 10_000;

const revoked = new Map<string, number>();

export function vaultTokenTtlSec(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SWARM_RUN_TOKEN_TTL_SEC?.trim();
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_TTL_SEC;
}

function secret(env: Record<string, string | undefined>): string {
  const value = env[SECRET_ENV];
  if (!value) throw new Error(`${SECRET_ENV} is required to mint vault tokens.`);
  return value;
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

interface Payload {
  u: string;
  r: string;
  e: number;
  s: string[];
}

export function signVaultToken(
  userId: string,
  runId: string,
  secretIds: string[],
  options: { now?: number; ttlSec?: number; env?: Record<string, string | undefined> } = {},
): string {
  const env = options.env ?? process.env;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const payload: Payload = {
    u: userId,
    r: runId,
    e: now + (options.ttlSec ?? vaultTokenTtlSec(env)),
    s: [...secretIds],
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", secret(env)).update(`${PREFIX}:${body}`).digest("hex");
  return `${PREFIX}.${body}.${mac}`;
}

export function verifyVaultToken(
  token: string,
  options: { now?: number; env?: Record<string, string | undefined> } = {},
): { userId: string; runId: string; expiresAt: number; secretIds: string[] } | null {
  const env = options.env ?? process.env;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const parts = String(token).split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, mac] = parts;
  let expected: string;
  try {
    expected = createHmac("sha256", secret(env)).update(`${PREFIX}:${body}`).digest("hex");
  } catch {
    return null;
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const raw = b64urlDecode(body);
  if (!raw) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(raw.toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.r !== "string" || typeof payload.e !== "number") {
    return null;
  }
  if (!Array.isArray(payload.s) || payload.s.some((id) => typeof id !== "string")) return null;
  if (!Number.isFinite(payload.e) || payload.e <= now) return null;
  if (revoked.has(payload.r)) return null;
  return { userId: payload.u, runId: payload.r, expiresAt: payload.e, secretIds: payload.s };
}

export function revokeVaultToken(runId: string): void {
  if (!revoked.has(runId)) {
    revoked.set(runId, Date.now());
    if (revoked.size > MAX_REVOKED) {
      const oldest = revoked.keys().next().value;
      if (oldest !== undefined) revoked.delete(oldest);
    }
  }
}

export function clearRevokedVaultTokens(): void {
  revoked.clear();
}
