// Access control, shared by middleware (Node runtime) and route handlers that bypass it.
//
// With SWARM_AUTH_TOKEN unset the app is local-only: requests must come from 127.0.0.1/localhost pages.
// With it set (any deployment), every request needs the token, via the httpOnly cookie set by /login or an
// `Authorization: Bearer` header. Locality grants nothing then: behind a reverse proxy every request looks local.
// On a server, set SWARM_AUTH_TOKEN_SHA256 (hex sha256 of the token) instead of the token itself: the agent runs
// as the same user and can read this process's environment, so the plaintext must never be on the server.
// SWARM_MODE=server fails closed: without a token nothing is served. SWARM_ALLOWED_HOSTS (comma list), when
// set, restricts which Host names are answered at all.

import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "swarm_auth";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Digest of the access token, or null when sign-in is not configured. */
function expected(): Buffer | null {
  const hex = (process.env.SWARM_AUTH_TOKEN_SHA256 ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  const raw = process.env.SWARM_AUTH_TOKEN ?? "";
  return raw ? sha256(raw) : null;
}

export const authEnabled = () => expected() !== null;
export const serverMode = () => process.env.SWARM_MODE === "server";
/** Server mode with no token configured: refuse everything rather than fall back to open. */
export const misconfigured = () => serverMode() && !authEnabled();

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

/** Client IP for rate limiting. Behind nginx plus a proxy manager the real client is second from the right in X-Forwarded-For. */
export function clientIp(req: Request) {
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length >= 2 ? xff[xff.length - 2] : (xff[0] ?? req.headers.get("x-real-ip") ?? "local");
}

/** Compares digests, so the check is constant-time and never depends on the token's length. */
export function checkToken(candidate: string) {
  const want = expected();
  return !!want && candidate.length > 0 && timingSafeEqual(sha256(candidate), want);
}

function cookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

const localHost = (h: string) => h === "127.0.0.1" || h === "localhost";

/** Local mode: the request targets this machine and, if it came from a page, that page is local too (blocks DNS rebinding / CSRF). */
export function isLocalRequest(req: Request) {
  const host = (req.headers.get("host") ?? "").split(":")[0];
  const origin = req.headers.get("origin");
  return localHost(host) && (!origin || localHost(new URL(origin).hostname));
}

/** A browser-sent Origin must match the host it is talking to. Requests without one (curl, SSE GETs) rely on the token. */
function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isAuthorized(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return checkToken(bearer) || checkToken(cookie(req, AUTH_COOKIE));
}

/** The single gate every request passes through. */
export function isAllowed(req: Request) {
  if (misconfigured() || !hostAllowed(req)) return false;
  return authEnabled() ? isAuthorized(req) && sameOrigin(req) : isLocalRequest(req);
}
