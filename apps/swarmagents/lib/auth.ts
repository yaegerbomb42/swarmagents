// Server-side auth gate for the SwarmAgents middleware and route handlers that
// bypass it (uploads). Local mode trusts the machine's own loopback interface;
// server mode requires a signed session cookie or a bearer token matching the
// SWARM_HARNESS_TOKEN env var. Every route — including /api/mcp/swarm-board —
// is gated in server mode; nothing is public except the login/signup/health
// surface listed in middleware.ts.
import { createHmac, timingSafeEqual } from "node:crypto";
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

const LOCAL_USER: AuthUser = { id: "local", email: "local@swarmagents.local" };
const HARNESS_USER: AuthUser = { id: "harness", email: "harness@swarmagents.local" };

/** Server mode: multi-user deployment where requests must authenticate. */
export function serverMode(): boolean {
  const v = process.env.SWARM_SERVER_MODE;
  return v === "1" || v === "true" || v === "yes";
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
 * Format: `v2.<userId>.<issuedAtSec>.<mac>` where issuedAtSec is the Unix
 * time (seconds) the session was issued and the MAC covers
 * `v2:<userId>:<issuedAtSec>` (domain-separated from the legacy format so a
 * legacy token can never be mistaken for a v2 token). `issuedAtSec` defaults
 * to now; callers (tests) may pass an explicit value to mint an old session.
 */
export function signSession(userId: string, issuedAtSec: number = Math.floor(Date.now() / 1000)): string {
  const secret = process.env.SWARM_SESSION_SECRET ?? "";
  if (!secret.trim()) {
    throw new Error("SWARM_SESSION_SECRET is not set: refusing to sign a session cookie with an empty key");
  }
  const issuedAt = Math.floor(issuedAtSec);
  const signingInput = `v2:${userId}:${issuedAt}`;
  const mac = createHmac("sha256", secret).update(signingInput).digest("hex");
  return `v2.${userId}.${issuedAt}.${mac}`;
}

/** A verified v2 session token: the user id plus the issued-at timestamp. */
interface VerifiedSession {
  userId: string;
  issuedAt: number;
}

/**
 * Verify a v2 session token (`v2.<userId>.<issuedAtSec>.<mac>`).
 * Returns the verified session if valid, null otherwise. The legacy session
 * format (`<userId>.<mac>` with no issued-at) is deliberately NOT accepted:
 * legacy cookies cannot expire and were removed as a security fix — see the
 * task history.
 */
function verifyV2Session(token: string, secret: string): VerifiedSession | null {
  if (!token.startsWith("v2.")) return null;
  const macSep = token.lastIndexOf(".");
  if (macSep <= 3) return null;
  const payload = token.slice(0, macSep); // "v2.<userId>.<issuedAtSec>"
  const mac = token.slice(macSep + 1);
  const iatSep = payload.lastIndexOf(".");
  if (iatSep <= 3) return null;
  const issuedAtRaw = payload.slice(iatSep + 1);
  if (!/^\d+$/.test(issuedAtRaw)) return null;
  const userId = payload.slice(3, iatSep);
  if (!userId) return null;
  const issuedAt = Number(issuedAtRaw);
  const expected = createHmac("sha256", secret).update(`v2:${userId}:${issuedAt}`).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now) return null; // issued in the future: not trustworthy
  if (now - issuedAt > sessionMaxAgeSec()) return null; // expired
  return { userId, issuedAt };
}

/** Returns the verified user id from a signed v2 session cookie, or null. */
export function verifySession(token: string): string | null {
  const secret = sessionSecret();
  if (!secret) return null;
  return verifyV2Session(token, secret)?.userId ?? null;
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
 * other identity has no epoch to enforce and is unaffected. The epoch is in
 * Unix milliseconds while issuedAt is in seconds, so the comparison is
 * issuedAt * 1000 >= epoch: a session minted in the same second as a
 * revocation — but before it — is rejected, which a second-resolution
 * comparison could not do.
 */
function sessionAllowedByEpoch(userId: string, issuedAt: number): boolean {
  if (!userId.startsWith("local_")) return true;
  const email = userId.slice("local_".length);
  return issuedAt * 1000 >= getSessionEpoch(email);
}

/**
 * Resolve the caller. Local mode: the machine's own agent is always trusted.
 * Server mode: valid harness bearer token, or a signed v2 session cookie that
 * has not been revoked (via the per-user session epoch).
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
      const verified = verifyV2Session(cookie, secret);
      if (verified && sessionAllowedByEpoch(verified.userId, verified.issuedAt)) {
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
