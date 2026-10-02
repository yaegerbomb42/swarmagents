// Access control, shared by middleware (Node runtime) and route handlers that bypass it.
//
// Local mode (default, a laptop): no accounts. Requests must come from 127.0.0.1/localhost pages, and everything
// runs as the single user "local".
// Server mode (SWARM_MODE=server, a deployment): every request needs a signed-in account (lib/users.ts), via the
// httpOnly session cookie set by /login or an `Authorization: Bearer <session token>` header. Locality grants
// nothing: behind a reverse proxy every request looks local. SWARM_ALLOWED_HOSTS (comma list), when set,
// restricts which Host names are answered at all.
//
// The owner token (SWARM_AUTH_TOKEN_SHA256, or SWARM_AUTH_TOKEN locally) now has one job: it is the invite code
// that creates the first, admin account. Keep only the digest on a server: the agent can read this process's env.

import { createHash, timingSafeEqual } from "node:crypto";
import { runAs } from "./store";
import { SandboxUnavailableError } from "./sandbox";
import { userForToken, type User } from "./users";
import { storageBlock, storageFullResponse } from "./tenant/storage";

export const AUTH_COOKIE = "swarm_auth";
/** Set by middleware on every forwarded request (any client-sent value is overwritten): the signed-in user's id. */
export const USER_HEADER = "x-swarm-user";
export const LOCAL_USER: User = { id: "local", username: "local", isAdmin: true, createdAt: 0 };

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function ownerDigest(): Buffer | null {
  const hex = (process.env.SWARM_AUTH_TOKEN_SHA256 ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  const raw = process.env.SWARM_AUTH_TOKEN ?? "";
  return raw ? sha256(raw) : null;
}

export const serverMode = () => process.env.SWARM_MODE === "server";

/** Is this the owner token? Compares digests: constant-time and independent of the token's length. */
export function checkOwnerToken(candidate: string) {
  const want = ownerDigest();
  return !!want && candidate.length > 0 && timingSafeEqual(sha256(candidate), want);
}

const allowedHosts = () =>
  (process.env.SWARM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/** Host header (without port) is on the allowlist, or no allowlist is configured. */
export function hostAllowed(req: Request) {
  const list = allowedHosts();
  if (!list.length) return true;
  return list.includes((req.headers.get("host") ?? "").split(":")[0].toLowerCase());
}

/**
 * Client IP for rate limiting. Each trusted proxy appends the address it saw, so with N hops (SWARM_TRUSTED_PROXY_HOPS,
 * default 1) the real client is the Nth entry from the right; anything further left is client-supplied and forgeable.
 */
export function clientIp(req: Request) {
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const hops = Math.max(1, Math.floor(Number(process.env.SWARM_TRUSTED_PROXY_HOPS ?? 1)) || 1);
  return xff.length >= hops ? xff[xff.length - hops] : (req.headers.get("x-real-ip") ?? "local");
}

function cookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/** The session token a request carries (cookie, else bearer). */
export function sessionToken(req: Request) {
  return cookie(req, AUTH_COOKIE) || (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

const localHost = (h: string) => h === "127.0.0.1" || h === "localhost";

/** Local mode: the request targets this machine and, if it came from a page, that page is local too (blocks DNS rebinding / CSRF). */
export function isLocalRequest(req: Request) {
  const host = (req.headers.get("host") ?? "").split(":")[0];
  const origin = req.headers.get("origin");
  return localHost(host) && (!origin || localHost(new URL(origin).hostname));
}

/** A browser-sent Origin must match the host it is talking to. Requests without one (curl, SSE GETs) rely on the session. */
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Who is making this request, or null if nobody is allowed to. The single gate every request passes through. */
export function requestUser(req: Request): User | null {
  if (!hostAllowed(req)) return null;
  if (!serverMode()) return isLocalRequest(req) ? LOCAL_USER : null;
  if (!sameOrigin(req)) return null;
  return userForToken(sessionToken(req));
}

export const isAllowed = (req: Request) => requestUser(req) !== null;

/** Cookie for a fresh login session. Secure on servers, and whenever the client reached us over https. */
export function sessionCookie(req: Request, token: string, maxAgeSec = 60 * 60 * 24 * 30) {
  const secure = serverMode() || (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
  // Lax, not Strict: the redirect back from an OAuth provider is a cross-site navigation, and a Strict cookie
  // would make that callback look signed out. Cross-site POSTs still get no cookie, and sameOrigin() blocks them.
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

// Failed logins and sign-ups are limited per client IP and per account (deploy lane, 21:58 CT; replaces the global
// 60/min cap, which let one attacker lock every user out of signing in):
//  - per IP: 10 failures in 5 minutes blocks that IP's logins/sign-ups until the window drains;
//  - per account (lower-cased username/email): 10 failures in 15 minutes blocks logins to THAT account only, so a
//    botnet spread over many IPs still can't guess one password, and nobody else is affected.
// A successful login clears only that account's counter, never the IP's, so an attacker can't reset their IP budget
// by signing in to an account of their own between guesses. Every failure also costs 500 ms.
const IP_MAX = 10, IP_WINDOW = 5 * 60_000;
const ACCT_MAX = 10, ACCT_WINDOW = 15 * 60_000;
const ipFails = new Map<string, number[]>();
const acctFails = new Map<string, number[]>();
const acctKey = (account?: string) => (account ?? "").trim().toLowerCase().slice(0, 320);

function recentCount(map: Map<string, number[]>, key: string, window: number, now: number) {
  const list = (map.get(key) ?? []).filter((t) => now - t < window);
  if (list.length) map.set(key, list);
  else map.delete(key);
  return list.length;
}

function bump(map: Map<string, number[]>, key: string, window: number, now: number) {
  if (map.size > 50_000) map.clear();
  map.set(key, [...(map.get(key) ?? []).filter((t) => now - t < window), now]);
}

/** True when this client IP, or (for logins) this account, has too many recent failures. */
export function throttled(req: Request, account?: string) {
  const now = Date.now();
  if (recentCount(ipFails, clientIp(req), IP_WINDOW, now) >= IP_MAX) return true;
  const k = acctKey(account);
  return !!k && recentCount(acctFails, k, ACCT_WINDOW, now) >= ACCT_MAX;
}

export async function noteFailure(req: Request, account?: string) {
  const now = Date.now();
  bump(ipFails, clientIp(req), IP_WINDOW, now);
  const k = acctKey(account);
  if (k) bump(acctFails, k, ACCT_WINDOW, now);
  await new Promise((r) => setTimeout(r, 500));
}

/** After a successful login: forget that account's failures (the IP's stay until they age out). */
export const clearFailures = (_req: Request, account?: string) => {
  const k = acctKey(account);
  if (k) acctFails.delete(k);
};

/**
 * Wrap a route handler so it runs as the signed-in user: every store path it touches resolves to that user's
 * data. It re-resolves the session itself (no trust in forwarded headers), so it also guards routes that bypass
 * middleware. Usage: `export const GET = scoped(async (req, ctx) => { ... })`.
 */
export function scoped<A extends unknown[]>(handler: (req: Request, ...rest: A) => Response | Promise<Response>) {
  return async (req: Request, ...rest: A): Promise<Response> => {
    const user = requestUser(req);
    if (!user) return Response.json({ error: "Sign in required." }, { status: serverMode() ? 401 : 403 });
    try {
      // Storage hard stop: at 100% of the account's quota, refuse new writes with a 507 and a clear message.
      // Reads, deletes, sign-out and the storage page itself stay open so the user can always free space.
      if (writeGated(req)) {
        const full = storageBlock(0, {}, user.id);
        if (full) return storageFullResponse(full);
      }
      return await runAs(user.id, () => handler(req, ...rest));
    } catch (e) {
      // A multi-user server without its sandbox refuses tool work; say so instead of a bare 500.
      if (e instanceof SandboxUnavailableError) return Response.json({ error: e.message }, { status: 503 });
      throw e;
    }
  };
}

/** Requests that add data, so the storage hard stop applies to them. */
function writeGated(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS", "DELETE"].includes(req.method)) return false;
  const p = new URL(req.url).pathname;
  return !/^\/api\/(storage|login|logout|signup|admin)(\/|$)/.test(p) && !/\/(stop|cancel|deny|reject)$/.test(p);
}
