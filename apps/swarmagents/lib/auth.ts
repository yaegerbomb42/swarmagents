// Server-side auth gate for the SwarmAgents middleware and route handlers that
// bypass it (uploads). Local mode trusts the machine's own loopback interface;
// server mode requires a signed session cookie or a bearer token matching the
// SWARM_HARNESS_TOKEN env var. Every route — including /api/mcp/swarm-board —
// is gated in server mode; nothing is public except the login/signup/health
// surface listed in middleware.ts.
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionEpoch } from "./users";

/** Request shape we rely on — NextRequest and plain Request both satisfy it. */
export interface AuthRequestLike {
  headers: { get(name: string): string | null };
  cookies?: { get(name: string): { readonly value: string } | undefined };
}

export interface AuthUser {
  id: string;
  email?: string;
}

/** Route handlers learn who is calling from this header (set by middleware). */
export const USER_HEADER = "x-swarm-user";

/** Header that marks a per-user or otherwise dynamic reply as uncacheable. */
export const NO_STORE = { "cache-control": "no-store" } as const;

export const MAX_USER_ID_LENGTH = 128;

/**
 * Standardized extraction and validation of the authenticated caller identity
 * from the middleware-set `x-swarm-user` header.
 *
 * Ensures the value is a trimmed, non-empty string of length <= 128.
 */
export function routeCaller(req: AuthRequestLike | Request): string | null {
  const user = req.headers.get(USER_HEADER);
  if (!user) return null;
  const trimmed = user.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_USER_ID_LENGTH) return null;
  return trimmed;
}

/**
 * Standardized 401 Unauthorized response for unauthenticated route calls,
 * carrying Cache-Control: no-store.
 */
export function unauthorizedResponse(message = "Sign in required."): NextResponse {
  return NextResponse.json({ error: message }, { status: 401, headers: NO_STORE });
}

/** Signed session cookie name. */
export const SESSION_COOKIE = "swarm_session";

/**
 * Cookie attributes for the session cookie: HttpOnly (never readable by
 * scripts), Secure (only sent over HTTPS; set SWARM_COOKIE_SECURE=0 to accept
 * plain HTTP in non-TLS deployments), SameSite=Lax (sent on same-site
 * navigations but not cross-site subresource/fetch — the login API is called
 * same-site), scoped to the whole site, expiring after sessionMaxAgeSec().
 */
export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  const secure = process.env.SWARM_COOKIE_SECURE !== "0" && process.env.SWARM_COOKIE_SECURE !== "false";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: sessionMaxAgeSec(),
  };
}

/**
 * Cookie attributes to clear the session cookie: HttpOnly, Secure, SameSite=Lax,
 * scoped to the whole site, with maxAge: 0.
 */
export function clearSessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: 0;
} {
  return {
    ...sessionCookieOptions(),
    maxAge: 0,
  };
}

/** Re-exported so server code can validate a `next` param without knowing where it lives. */
export { safeNextPath } from "./safe-next";

/** Default session lifetime: 7 days, in seconds. */
export const DEFAULT_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * Max session age in seconds, from SWARM_SESSION_MAX_AGE_SEC (default 7 days).
 * A missing, non-numeric, or non-positive value falls back to the default
 * rather than silently disabling expiry or locking everyone out.
 */
export function sessionMaxAgeSec(): number {
  const raw = process.env.SWARM_SESSION_MAX_AGE_SEC;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_SESSION_MAX_AGE_SEC;
}

/** Id of the single-user local operator identity (no sign-in; loopback trust). */
export const LOCAL_USER_ID = "local";

const LOCAL_USER: AuthUser = { id: LOCAL_USER_ID, email: "local@swarmagents.local" };
const HARNESS_USER: AuthUser = { id: "harness", email: "harness@swarmagents.local" };

/** Server mode: multi-user deployment where requests must authenticate. */
export function serverMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SWARM_SERVER_MODE;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Whether self-signup (POST /api/signup) accepts new accounts — the single
 * source of truth for the signup gate. The login page renders its "Create
 * account" toggle from this predicate and the signup route enforces it, so
 * the two can never disagree. (They used to: the page keyed only on
 * NODE_ENV, so a server-mode, non-production deployment — staging, a test
 * server, a demo box — offered "Create account" while every attempt 403'd
 * with "Sign-up is disabled on this server.")
 *
 * The rule: open in local (non-server) mode outside production — loopback
 * only, and creating the first local account is the intended local flow —
 * and open anywhere when SWARM_ALLOW_SIGNUP is "1"/"true". Closed in
 * server mode (every environment) and in production unless explicitly
 * enabled: a reachable server-mode box must not mint accounts (each one
 * gets a VM) just because NODE_ENV was left unset.
 */
export function signupAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const allow = (env.SWARM_ALLOW_SIGNUP ?? "").toLowerCase();
  if (allow === "1" || allow === "true") return true;
  return !serverMode(env) && env.NODE_ENV !== "production";
}

/** Minimum SWARM_SESSION_SECRET length (characters) enforced at boot in server mode. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Startup guard for server mode (Tier 1 blocker #1): in server mode the
 * session cookie is the only thing standing between the network and full
 * access to runs, VMs, provider keys, and the board, and a missing secret
 * otherwise only fails at login time (500). Return an actionable error when
 * server mode is on and SWARM_SESSION_SECRET is missing or blank; null
 * otherwise. Local mode is unaffected — it trusts loopback and needs no
 * session secret at all.
 *
 * Tier 2 #18: a present-but-weak secret is also a boot error. The secret is
 * the HMAC key for every session cookie, so it must be at least 32
 * characters and not a single repeated character — a short or uniform
 * string (e.g. "test-secret", "aaaa…") fails boot with an actionable
 * message. This check runs only here (startup) and only in server mode:
 * signing/verifying itself accepts any secret, so unit tests that mint
 * cookies with short fixture secrets keep working.
 */
export function serverModeSecretError(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.SWARM_SERVER_MODE;
  if (!(v === "1" || v === "true" || v === "yes")) return null;
  const secret = env.SWARM_SESSION_SECRET?.trim();
  if (!secret) {
    return (
      "Server-mode startup error: SWARM_SERVER_MODE is set but SWARM_SESSION_SECRET is missing or empty. " +
      "Server mode has no authentication without it, so the app refuses to boot. " +
      "Set SWARM_SESSION_SECRET to 32+ random bytes (e.g. `openssl rand -hex 32`). " +
      "See DEPLOY.md and apps/swarmagents/.env.example."
    );
  }
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    return (
      `Server-mode startup error: SWARM_SESSION_SECRET is too short (${secret.length} characters, minimum ${MIN_SESSION_SECRET_LENGTH}). ` +
      "A short session secret makes session cookies forgeable, so the app refuses to boot. " +
      "Set SWARM_SESSION_SECRET to 32+ random bytes (e.g. `openssl rand -hex 32`). " +
      "See DEPLOY.md and apps/swarmagents/.env.example."
    );
  }
  if (/^(.)\1+$/.test(secret)) {
    return (
      "Server-mode startup error: SWARM_SESSION_SECRET is a single repeated character and has no entropy. " +
      "Set SWARM_SESSION_SECRET to 32+ random bytes (e.g. `openssl rand -hex 32`). " +
      "See DEPLOY.md and apps/swarmagents/.env.example."
    );
  }
  return null;
}

/** Throw the server-mode session-secret startup error, if one applies. */
export function assertServerModeSecret(env: NodeJS.ProcessEnv = process.env): void {
  const message = serverModeSecretError(env);
  if (message) throw new Error(message);
}

/** Hostname from the request's Host header, or null when the header is malformed. */
export function requestHostname(req: AuthRequestLike): string | null {
  const host = (req.headers.get("host") ?? "").trim().toLowerCase();
  // A genuinely absent Host header keeps the empty-string loopback convention.
  if (host === "") return "";
  // IPv6 literal: [::1] or [::1]:port — brackets are kept in the result.
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return null;
    const literal = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest === "") return literal;
    if (!rest.startsWith(":") || !isValidPort(rest.slice(1))) return null;
    return literal;
  }
  // More than one colon outside IPv6 brackets means no valid port either.
  if (host.indexOf(":") !== host.lastIndexOf(":")) return null;
  const colon = host.indexOf(":");
  if (colon !== -1 && !isValidPort(host.slice(colon + 1))) return null;
  const stripped = stripTrailingDots(colon === -1 ? host : host.slice(0, colon));
  // A name that strips down to nothing (e.g. "...") is malformed, not empty.
  return stripped === "" ? null : stripped;
}

/** Ports are ASCII digits, 1–65535. Anything else is malformed. */
function isValidPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/** Trailing DNS dots carry no hostname information; "example.com." is "example.com". */
function stripTrailingDots(host: string): string {
  let s = host;
  while (s.endsWith(".") && s.length > 0) s = s.slice(0, -1);
  return s;
}

/** True when the request targets the machine itself (in-container healthcheck, local dev). */
export function isLoopbackHost(req: AuthRequestLike): boolean {
  const host = requestHostname(req);
  if (host === null) return false;
  return host === "" || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Hosts explicitly configured for VM-to-app callback traffic in local mode. */
function configuredVmCallbackHosts(): string[] {
  const hosts: string[] = [];
  for (const raw of [process.env.SWARM_VM_APPROVAL_BASE_URL, process.env.SWARM_VM_LLM_BASE_URL]) {
    if (!raw?.trim()) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") hosts.push(url.hostname.toLowerCase());
    } catch {
      // The runtime surfaces malformed callback URLs when a run starts.
    }
  }
  return hosts;
}

/** Host gate. Local mode trusts loopback plus explicit VM callback origins; server mode consults SWARM_ALLOWED_HOSTS. */
export function hostAllowed(req: AuthRequestLike): boolean {
  const host = requestHostname(req);
  if (host === null) return false;
  if (!serverMode()) return isLoopbackHost(req) || configuredVmCallbackHosts().includes(host);
  // Server mode, allowlist unset: deny by default. An unset list used to
  // mean allow-all, so any Host header (including an attacker's) was
  // accepted; a deployment that wants to serve must name its hosts in
  // SWARM_ALLOWED_HOSTS. The only exception is the loopback health probe,
  // which middleware.ts exempts for /api/health before calling this.
  const allowed = (process.env.SWARM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(host);
}

/** HMAC-SHA256 signature for the session cookie, keyed by SWARM_SESSION_SECRET. */
function sessionSecret(): string {
  return process.env.SWARM_SESSION_SECRET ?? "";
}

/**
 * Sign a session cookie value for `userId`. Used by the login route and tests.
 *
 * Throws when SWARM_SESSION_SECRET is unset or blank: signing with an empty
 * key yields a valid-looking MAC shared by every deployment that boots without
 * a secret, so we refuse rather than mint one. Server mode already refuses to
 * boot in that state (assertServerModeSecret), so this only fires for callers
 * outside the startup guards — a loud failure, never an empty-key signature.
 * Verification (verifySession) never throws; it returns null.
 *
 * Format: `v3.<userId>.<issuedAtMs>.<mac>` where issuedAtMs is the Unix time
 * in milliseconds and the MAC covers `v3:<userId>:<issuedAtMs>` (domain-
 * separated from v2 and the legacy format, so a token minted in one format can
 * never be mistaken for another). Millisecond precision is required: a v2
 * seconds-precision session minted just after "sign out everywhere" inside the
 * same second was rejected by the millisecond revocation epoch.
 *
 * `issuedAt` defaults to now in milliseconds. Legacy callers (tests/tools)
 * that pass seconds are still accepted: values below 1e12 are seconds and are
 * scaled up, so their existing fixtures keep working. v2 tokens are still
 * verified during rollout so active sessions are not dropped.
 */
export function signSession(
  userId: string,
  issuedAt: number = Date.now(),
): string {
  const secret = process.env.SWARM_SESSION_SECRET ?? "";
  if (!secret.trim()) {
    throw new Error("SWARM_SESSION_SECRET is not set: refusing to sign a session cookie with an empty key");
  }
  const issuedAtMs = issuedAt < 1e12 ? issuedAt * 1000 : Math.floor(issuedAt);
  const signingInput = `v3:${userId}:${issuedAtMs}`;
  const mac = createHmac("sha256", secret).update(signingInput).digest("hex");
  return `v3.${userId}.${issuedAtMs}.${mac}`;
}

/** A verified session token: the user id plus the issued-at in milliseconds. */
interface VerifiedSession {
  userId: string;
  issuedAtMs: number;
}

/** Split a signed token into components for a given prefix. */
function parseSessionToken(token: string, prefix: string): { userId: string; issuedAtRaw: string; mac: string } | null {
  if (!token.startsWith(prefix)) return null;
  const parts = token.slice(prefix.length).split(".");
  if (parts.length < 3) return null;
  const mac = parts[parts.length - 1];
  const issuedAtRaw = parts[parts.length - 2];
  const userId = parts.slice(0, parts.length - 2).join(".");
  if (!userId || !/^\d+$/.test(issuedAtRaw)) return null;
  return { userId, issuedAtRaw, mac };
}

function macMatches(secret: string, signingInput: string, mac: string): boolean {
  const expected = createHmac("sha256", secret).update(signingInput).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a signed token. v3 carries milliseconds; v2 carries seconds and is
 * normalized to milliseconds.
 */
function verifySignedSession(token: string, secret: string): VerifiedSession | null {
  const prefix = token.startsWith("v3.") ? "v3." : token.startsWith("v2.") ? "v2." : null;
  if (!prefix) return null; // legacy cookies + unknown prefixes are rejected

  const parts = parseSessionToken(token, prefix);
  if (!parts) return null;
  const domain = prefix.slice(0, 2);
  const signingInput = `${domain}:${parts.userId}:${parts.issuedAtRaw}`;
  if (!macMatches(secret, signingInput, parts.mac)) return null;

  const issuedAtMs = Number(parts.issuedAtRaw) * (domain === "v2" ? 1000 : 1);
  const now = Date.now();
  if (issuedAtMs > now) return null; // issued in the future: not trustworthy
  if ((now - issuedAtMs) / 1000 > sessionMaxAgeSec()) return null; // expired
  return { userId: parts.userId, issuedAtMs };
}

/**
 * Returns the verified user id from a signed session cookie, or null. The
 * per-user revocation epoch is enforced here too: direct callers (WebSocket /
 * SSE upgrades, proxy routes) must reject "sign out everywhere" just as
 * requestUser does.
 */
export function verifySession(token: string): string | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const verified = verifySignedSession(token, secret);
  if (!verified || !sessionAllowedByEpoch(verified.userId, verified.issuedAtMs)) return null;
  return verified.userId;
}

function harnessTokenValid(token: string): boolean {
  const expected = process.env.SWARM_HARNESS_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the request carries a valid harness bearer token (server-to-server, never a browser). */
export function isHarnessBearer(req: AuthRequestLike): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  return harnessTokenValid(auth.slice(7).trim());
}

/**
 * A session is valid only if it was issued at or after the user's current
 * session epoch (see lib/users). Local accounts carry a revocable epoch; any
 * other identity has no epoch to enforce and is unaffected. Both the epoch
 * and the verified issued-at are Unix milliseconds, so a session minted in
 * the same second as a revocation — but before it — is rejected, while a
 * session minted just after it is accepted immediately (no same-second
 * lockout). v2 tokens are normalized to milliseconds by verifySignedSession.
 */
function sessionAllowedByEpoch(userId: string, issuedAtMs: number): boolean {
  if (!userId.startsWith("local_")) return true;
  const email = userId.slice("local_".length);
  return issuedAtMs > getSessionEpoch(email);
}

/**
 * Resolve the caller. Local mode: the machine's own agent is always trusted.
 * Server mode: valid harness bearer token, or a signed session cookie (v3 or
 * v2) that has not been revoked (via the per-user session epoch).
 */
export function requestUser(req: AuthRequestLike): AuthUser | null {
  if (!serverMode()) return LOCAL_USER;

  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (harnessTokenValid(token)) return HARNESS_USER;
  }

  const cookie = req.cookies?.get(SESSION_COOKIE)?.value;
  if (cookie) {
    const secret = sessionSecret();
    if (secret) {
      const verified = verifySignedSession(cookie, secret);
      if (verified && sessionAllowedByEpoch(verified.userId, verified.issuedAtMs)) {
        const userId = verified.userId;
        // Local accounts sign in as `local_<email>`; show the real address, not `<id>@swarmagents.local`.
        const email = userId.startsWith("local_") && userId.includes("@") ? userId.slice(6) : `${userId}@swarmagents.local`;
        return { id: userId, email };
      }
    }
  }

  return null;
}

/**
 * Gate for route handlers that bypass middleware (uploads). The host allowlist
 * (loopback in local mode, SWARM_ALLOWED_HOSTS in server mode) applies in every
 * mode, so a request aimed at the app from a non-allowlisted Host is refused
 * even in local mode; server mode additionally requires an authenticated caller.
 */
export function isAllowed(req: AuthRequestLike): boolean {
  if (!hostAllowed(req)) return false;
  return !serverMode() || requestUser(req) !== null;
}

