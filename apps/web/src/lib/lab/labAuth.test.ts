import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { NextRequest } from 'next/server';

import {
  verifyFirebaseIdToken,
  resolveLabIdentity,
  clientIp,
  roleCreateRateLimit,
  ROLE_SYNTHESIS_VERIFIED_LIMIT,
  ROLE_SYNTHESIS_ANON_LIMIT,
  _resetLabAuthForTests,
} from './labAuth';

const PROJECT_ID = 'test-project';

// ── RSA test keypair standing in for Google's signing keys ──────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_JWK = {
  ...(publicKey.export({ format: 'jwk' }) as Record<string, string>),
  kid: 'test-key-1',
  alg: 'RS256',
  use: 'sig',
};

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

interface TokenOptions {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  sign?: boolean;
}

function validClaims(now = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'uid-123',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    iat: now - 60,
    exp: now + 3600,
    auth_time: now - 60,
    user_id: 'uid-123',
  };
}

function makeToken({ header, claims, sign = true }: TokenOptions): string {
  const headerSeg = b64url(header ?? { alg: 'RS256', kid: 'test-key-1' });
  const payloadSeg = b64url(claims ?? validClaims());
  const signingInput = `${headerSeg}.${payloadSeg}`;
  if (!sign) return `${signingInput}.${Buffer.from('not-a-real-sig').toString('base64url')}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${sig.toString('base64url')}`;
}

function requestWithAuth(headerValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (headerValue !== undefined) headers.authorization = headerValue;
  return new Request('http://localhost/api/lab/roles', { headers }) as unknown as NextRequest;
}

describe('labAuth', () => {
  const originalProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  beforeEach(() => {
    _resetLabAuthForTests();
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = PROJECT_ID;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ keys: [TEST_JWK] }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    if (originalProjectId === undefined) {
      delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    } else {
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = originalProjectId;
    }
  });

  it('verifies a properly signed Firebase ID token and returns its claims', async () => {
    const user = await verifyFirebaseIdToken(makeToken({}));
    expect(user).toEqual({ uid: 'uid-123', email: 'ada@example.com', name: 'Ada Lovelace' });
  });

  it('rejects tokens signed by a different key (forged signatures)', async () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const headerSeg = b64url({ alg: 'RS256', kid: 'test-key-1' });
    const payloadSeg = b64url(validClaims());
    const signingInput = `${headerSeg}.${payloadSeg}`;
    const badSig = createSign('RSA-SHA256').update(signingInput).sign(otherKey);
    const token = `${signingInput}.${badSig.toString('base64url')}`;

    expect(await verifyFirebaseIdToken(token)).toBeNull();
  });

  it('rejects expired tokens and tokens issued in the future', async () => {
    const now = Math.floor(Date.now() / 1000);

    const expired = validClaims(now);
    expired.exp = now - 3600; // well past the clock-skew tolerance
    expect(await verifyFirebaseIdToken(makeToken({ claims: expired }))).toBeNull();

    const futureIssued = validClaims(now);
    futureIssued.iat = now + 3600;
    expect(await verifyFirebaseIdToken(makeToken({ claims: futureIssued }))).toBeNull();
  });

  it('rejects tokens with a mismatched issuer or audience', async () => {
    const wrongIss = validClaims();
    wrongIss.iss = 'https://securetoken.google.com/other-project';
    const wrongAud = validClaims();
    wrongAud.aud = 'other-project';
    expect(await verifyFirebaseIdToken(makeToken({ claims: wrongIss }))).toBeNull();
    expect(await verifyFirebaseIdToken(makeToken({ claims: wrongAud }))).toBeNull();
  });

  it('rejects unsigned / wrong-alg / malformed tokens', async () => {
    expect(
      await verifyFirebaseIdToken(
        makeToken({ header: { alg: 'none', kid: 'test-key-1' }, sign: false })
      )
    ).toBeNull();
    expect(
      await verifyFirebaseIdToken(
        makeToken({ header: { alg: 'RS256', kid: 'test-key-1' }, sign: false })
      )
    ).toBeNull();
    expect(await verifyFirebaseIdToken('not-a-jwt')).toBeNull();
    expect(await verifyFirebaseIdToken('a.b.c')).toBeNull();
  });

  it('rejects tokens without a subject', async () => {
    const claims = validClaims();
    delete claims.sub;
    expect(await verifyFirebaseIdToken(makeToken({ claims }))).toBeNull();
  });

  it('fails closed when the project id is not configured', async () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    expect(await verifyFirebaseIdToken(makeToken({}))).toBeNull();
  });

  it('fails closed when the JWKS endpoint is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    );
    expect(await verifyFirebaseIdToken(makeToken({}))).toBeNull();
  });

  describe('resolveLabIdentity', () => {
    it('pins anonymous callers to the shared local owner', async () => {
      const noHeader = await resolveLabIdentity(requestWithAuth());
      expect(noHeader.ok).toBe(true);
      if (noHeader.ok) {
        expect(noHeader.identity).toEqual({
          ownerId: 'usr-local',
          ownerName: 'Anonymous',
          email: null,
          anonymous: true,
        });
      }

      const emptyBearer = await resolveLabIdentity(requestWithAuth('Bearer '));
      expect(emptyBearer.ok).toBe(true);
      if (emptyBearer.ok) expect(emptyBearer.identity.anonymous).toBe(true);
    });

    it('derives the identity from a verified bearer token', async () => {
      const result = await resolveLabIdentity(requestWithAuth(`Bearer ${makeToken({})}`));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.identity.ownerId).toBe('uid-123');
        expect(result.identity.ownerName).toBe('Ada Lovelace');
        expect(result.identity.email).toBe('ada@example.com');
        expect(result.identity.anonymous).toBe(false);
      }
    });

    it('returns a 401 response for invalid bearer tokens', async () => {
      const result = await resolveLabIdentity(
        requestWithAuth(`Bearer ${makeToken({ sign: false })}`)
      );
      expect(result.ok).toBe(false);
      if (result.ok !== true) {
        expect(result.response.status).toBe(401);
        const body = await result.response.json();
        expect(body.code).toBe('auth_invalid');
      }
    });

    it('derives ownerName from the email local-part when display name is absent', async () => {
      const claims = validClaims();
      delete claims.name;
      const result = await resolveLabIdentity(requestWithAuth(`Bearer ${makeToken({ claims })}`));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.identity.ownerName).toBe('ada');
    });
  });

  describe('clientIp', () => {
    it('extracts the first x-forwarded-for entry', () => {
      const req = new Request('http://localhost/api/lab/roles', {
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      }) as unknown as NextRequest;
      expect(clientIp(req)).toBe('1.2.3.4');
    });

    it('falls back to x-real-ip and then to unknown', () => {
      const real = new Request('http://localhost/api/lab/roles', {
        headers: { 'x-real-ip': '9.9.9.9' },
      }) as unknown as NextRequest;
      expect(clientIp(real)).toBe('9.9.9.9');

      const none = new Request('http://localhost/api/lab/roles') as unknown as NextRequest;
      expect(clientIp(none)).toBe('unknown');
    });
  });

  describe('roleCreateRateLimit', () => {
    it('keys verified users by uid with the verified limit', () => {
      const cfg = roleCreateRateLimit(
        { ownerId: 'uid-1', ownerName: 'Ada', email: 'ada@example.com', anonymous: false },
        '1.2.3.4'
      );
      expect(cfg.key).toBe('lab:roles:create:uid:uid-1');
      expect(cfg.limit).toBe(ROLE_SYNTHESIS_VERIFIED_LIMIT);
    });

    it('keys anonymous users by client IP with the anonymous limit', () => {
      const anon = { ownerId: 'usr-local', ownerName: 'Anonymous', email: null, anonymous: true };
      const cfg = roleCreateRateLimit(anon, '1.2.3.4');
      expect(cfg.key).toBe('lab:roles:create:ip:1.2.3.4');
      expect(cfg.limit).toBe(ROLE_SYNTHESIS_ANON_LIMIT);
    });

    it('uses the unknown-IP key for anonymous callers without an IP', () => {
      const anon = { ownerId: 'usr-local', ownerName: 'Anonymous', email: null, anonymous: true };
      const cfg = roleCreateRateLimit(anon, null);
      expect(cfg.key).toBe('lab:roles:create:ip:unknown');
    });
  });
});
