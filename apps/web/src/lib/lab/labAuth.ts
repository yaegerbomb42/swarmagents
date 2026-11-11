/**
 * Server-side identity resolution for the Lab roles API.
 *
 * Firebase ID tokens (RS256 JWTs) are verified locally against Google's
 * published public keys (JWKS) — no firebase-admin dependency or service
 * account credentials needed. Verified identities get their ownerId derived
 * from the token's `sub` claim; client-supplied ownerId/ownerName values
 * are never trusted.
 *
 * Anonymous requests (no bearer token) are pinned to the shared local owner
 * `usr-local` so the landing-page demo and offline dev flows keep working
 * without letting callers impersonate other owners. Publishing a role to
 * the global library requires a verified identity.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Buffer } from 'node:buffer';
import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwks/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SECONDS = 300; // matches the official admin SDK tolerance
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

const ANON_OWNER_ID = 'usr-local';
const ANON_OWNER_NAME = 'Anonymous';

export interface LabIdentity {
  ownerId: string;
  ownerName: string;
  email: string | null;
  anonymous: boolean;
}

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
  name: string | null;
}

export type LabIdentityResult =
  | { ok: true; identity: LabIdentity }
  | { ok: false; response: NextResponse };

let jwksCache: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

function firebaseProjectId(): string | null {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || null;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
}

async function loadJwks(force = false): Promise<Map<string, KeyObject>> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(FIREBASE_JWKS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`jwks_fetch_failed_${res.status}`);
  const data = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, KeyObject>();
  for (const jwk of data.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // skip malformed keys — a partial key set is better than none
    }
  }
  if (keys.size === 0) throw new Error('jwks_empty');
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

function verifySignature(signingInput: string, signatureB64url: string, key: KeyObject): boolean {
  try {
    const signature = Buffer.from(signatureB64url, 'base64url');
    return createVerify('RSA-SHA256').update(signingInput).verify(key, signature);
  } catch {
    return false;
  }
}

/**
 * Verify a Firebase ID token (RS256) and return the trusted identity claims,
 * or null when the token is malformed, forged, expired, or scoped to a
 * different Firebase project.
 */
export async function verifyFirebaseIdToken(token: string): Promise<VerifiedFirebaseUser | null> {
  const pid = firebaseProjectId();
  if (!pid) return null; // cannot verify without a project id — fail closed

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(headerSeg) as { alg?: unknown; kid?: unknown };
    claims = decodeSegment(payloadSeg);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  const authTime = Number(claims.auth_time);

  if (!Number.isFinite(exp) || exp < now - CLOCK_SKEW_SECONDS) return null;
  if (Number.isFinite(iat) && iat > now + CLOCK_SKEW_SECONDS) return null;
  if (Number.isFinite(authTime) && authTime > now + CLOCK_SKEW_SECONDS) return null;

  const expectedIssuer = `https://securetoken.google.com/${pid}`;
  if (claims.iss !== expectedIssuer || claims.aud !== pid) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;

  const signingInput = `${headerSeg}.${payloadSeg}`;

  let keys: Map<string, KeyObject>;
  try {
    keys = await loadJwks();
  } catch {
    return null;
  }

  const key = keys.get(header.kid);
  if (!key || !verifySignature(signingInput, sigSeg, key)) {
    // Unknown or rotated kid (or stale key set) — force one JWKS refresh and retry.
    try {
      keys = await loadJwks(true);
    } catch {
      return null;
    }
    const refreshed = keys.get(header.kid);
    if (!refreshed || !verifySignature(signingInput, sigSeg, refreshed)) return null;
  }

  return {
    uid: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null,
  };
}

function anonymousIdentity(): LabIdentity {
  return { ownerId: ANON_OWNER_ID, ownerName: ANON_OWNER_NAME, email: null, anonymous: true };
}

/**
 * Resolve the caller's identity for a lab API request:
 * - No Authorization header -> anonymous (pinned to the shared local owner).
 * - Bearer token -> verified Firebase identity (ownerId = token `sub`).
 * - Invalid token -> `{ ok: false, response }` carrying a 401 for the route.
 */
export async function resolveLabIdentity(request: NextRequest): Promise<LabIdentityResult> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: true, identity: anonymousIdentity() };
  }
  const token = authHeader.slice(7).trim();
  if (!token) return { ok: true, identity: anonymousIdentity() };

  const user = await verifyFirebaseIdToken(token);
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'invalid_or_expired_token', code: 'auth_invalid' },
        { status: 401 }
      ),
    };
  }

  return {
    ok: true,
    identity: {
      ownerId: user.uid,
      ownerName: user.name || user.email?.split('@')[0] || 'Swarm User',
      email: user.email,
      anonymous: false,
    },
  };
}

// ── Per-identity rate limiting for role synthesis ──────────────────────────

/** Max role-synthesis POSTs per 60s window for a verified user. */
export const ROLE_SYNTHESIS_VERIFIED_LIMIT = Number(
  process.env.LAB_ROLE_CREATE_VERIFIED_LIMIT || 10
);

/** Max role-synthesis POSTs per 60s window per anonymous IP. */
export const ROLE_SYNTHESIS_ANON_LIMIT = Number(
  process.env.LAB_ROLE_CREATE_ANON_LIMIT || 3
);

/** Best-effort client IP, extracted from proxy headers. */
export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('x-real-ip') || 'unknown';
}

/**
 * Per-identity rate-limit config for role synthesis (the expensive LLM path):
 * - Verified users are keyed by their Firebase uid — never shared.
 * - Anonymous callers share the pinned 'usr-local' owner, so they are keyed by
 *   client IP instead, otherwise all anonymous traffic would drain one bucket.
 */
export function roleCreateRateLimit(
  identity: LabIdentity,
  ip: string | null | undefined
): { key: string; limit: number } {
  if (!identity.anonymous) {
    return {
      key: `lab:roles:create:uid:${identity.ownerId}`,
      limit: ROLE_SYNTHESIS_VERIFIED_LIMIT,
    };
  }
  return {
    key: `lab:roles:create:ip:${ip || 'unknown'}`,
    limit: ROLE_SYNTHESIS_ANON_LIMIT,
  };
}

/** Reset in-memory state — for tests only */
export function _resetLabAuthForTests(): void {
  jwksCache = null;
}

