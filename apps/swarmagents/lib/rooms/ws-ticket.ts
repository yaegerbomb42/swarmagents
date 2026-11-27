/**
 * Short-lived, single-use WebSocket tickets for public share rooms.
 *
 * Guests on `/share/[token]` exchange the long-lived share token via
 * `POST /api/share/[token]/ws-ticket` for a 20-second single-use ticket, so
 * the long-lived share token never appears in WebSocket upgrade URLs or proxy
 * access logs.
 *
 * Tickets are HMAC-SHA256 signed JSON payloads (`<b64url>.<sig>`) containing
 * the resolved `ownerId`, a random `jti`, and an expiry timestamp. The
 * desktop proxy verifies the signature, checks expiry, and records `jti` in a
 * bounded in-memory replay map so reused tickets are rejected.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const WS_TICKET_TTL_MS = 20_000;
const DOMAIN_PREFIX = "swarm-ws-ticket-v1:";

let cachedFallbackSecret: string | null = null;

function defaultDataDir(): string {
  return process.env.SWARM_HOME?.trim() || path.join(os.homedir(), ".swarmagents");
}

/**
 * Resolve the HMAC signing key for WS tickets. Uses SWARM_SESSION_SECRET when
 * configured (shared across Next.js and desktop-proxy in server mode); falls
 * back to a persistent 0600 secret file in SWARM_HOME for local/dev mode.
 */
export function resolveWsTicketSecret(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const envSecret = process.env.SWARM_SESSION_SECRET?.trim();
  if (envSecret && envSecret.length > 0) return envSecret;
  if (cachedFallbackSecret) return cachedFallbackSecret;

  const secretPath = path.join(defaultDataDir(), ".ws-ticket.secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) {
      cachedFallbackSecret = existing;
      return existing;
    }
  } catch {
    // Not created yet.
  }

  const generated = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    cachedFallbackSecret = generated;
    return generated;
  } catch {
    try {
      const raced = fs.readFileSync(secretPath, "utf8").trim();
      if (raced.length >= 32) {
        cachedFallbackSecret = raced;
        return raced;
      }
    } catch {
      // Unwritable directory (e.g. sandboxed test); keep process-local secret.
    }
    cachedFallbackSecret = generated;
    return generated;
  }
}

function signPayload(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${DOMAIN_PREFIX}${payloadB64}`).digest();
}

export interface IssuedWsTicket {
  ticket: string;
  expiresAt: number;
}

export function issueWsTicket(
  ownerId: string,
  now: number = Date.now(),
  secret?: string,
): IssuedWsTicket {
  const expiresAt = now + WS_TICKET_TTL_MS;
  const payload = {
    o: ownerId,
    j: randomBytes(16).toString("hex"),
    exp: expiresAt,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigB64 = signPayload(payloadB64, resolveWsTicketSecret(secret)).toString("base64url");
  return { ticket: `${payloadB64}.${sigB64}`, expiresAt };
}

export function verifyAndConsumeWsTicket(
  ticket: string,
  consumed: Map<string, number>,
  now: number = Date.now(),
  secret?: string,
): { ownerId: string } | null {
  // Prune expired JTIs so the replay map stays bounded.
  for (const [jti, exp] of consumed) {
    if (exp <= now) consumed.delete(jti);
  }

  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1 || ticket.indexOf(".", dot + 1) !== -1) {
    return null;
  }
  const payloadB64 = ticket.slice(0, dot);
  const sigB64 = ticket.slice(dot + 1);

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  const expectedSig = signPayload(payloadB64, resolveWsTicketSecret(secret));
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { o, j, exp } = parsed as Record<string, unknown>;
  if (
    typeof o !== "string" ||
    o.length === 0 ||
    typeof j !== "string" ||
    j.length === 0 ||
    typeof exp !== "number" ||
    !Number.isFinite(exp)
  ) {
    return null;
  }

  if (now > exp) return null;
  if (consumed.has(j)) return null;

  consumed.set(j, exp);
  return { ownerId: o };
}
