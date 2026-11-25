import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { hostAllowed, isHarnessBearer, isLoopbackHost, requestUser, serverMode, USER_HEADER } from "./lib/auth";
import {
  rateLimitCheck,
  rateLimitKey,
  rateLimitResponse,
  shareRateLimitKey,
  type RateInfo,
} from "./lib/rate-limit";
import { cspValue, securityHeaders, NONCE_HEADER, type SecurityHeadersOptions } from "./lib/security-headers";
import { isCrossSite } from "./lib/request-policy";

const NONCE_BYTES = 16;

/** Attach the hardened headers (and rate-limit headers when present) to any response leaving middleware. */
function withSecurityHeaders(
  res: NextResponse,
  nonce: string,
  opts?: SecurityHeadersOptions,
  rate: RateInfo | null = null,
): NextResponse {
  if (rate) {
    res.headers.set("X-RateLimit-Limit", String(rate.limit));
    res.headers.set("X-RateLimit-Remaining", String(rate.remaining));
    res.headers.set("X-RateLimit-Reset", String(rate.reset));
  }
  for (const [name, value] of Object.entries(securityHeaders(nonce, opts))) {
    res.headers.set(name, value);
  }
  return res;
}

// The agent has full control of the machine it runs on, so nothing is reachable without passing lib/auth.
// Kept under this name because route handlers that bypass middleware (uploads) import it as their gate.
export { isAllowed as isLocal } from "./lib/auth";

/** Reachable signed out: the sign-in page and the endpoints it uses. */
const PUBLIC = new Set([
  "/login",
  "/about",
  "/status",
  "/api/login",
  "/api/logout",
  "/api/signup",
  "/api/me",
  "/api/health",
  // Password reset (FIX-39): the token in the emailed link is the
  // credential; both routes are oracle-free and rate-limited.
  "/reset-password",
  "/api/password-reset/request",
  "/api/password-reset/confirm",
  // Email verification (FIX-44): the token in the emailed link is the
  // credential; the confirm route is single-use and rate-limited. The
  // resend route is NOT public — it requires a session.
  "/verify-email",
  "/api/email-verification/confirm",
  // BYOC: the node has no session yet; the pairing code / bearer token is the
  // credential and both routes authenticate themselves.
  "/api/computers/pair",
]);

/**
 * Public prefixes: read-only project share links (g5). The token in the path is
 * the credential; the page renders a snapshot and can never mutate anything.
 */
const PUBLIC_PREFIXES = [
  "/share/",
  // Token-gated VM preview links (F10): the token in the path is the
  // credential, like the project share pages above.
  "/preview/share/",
  // Node control channel + one-line installer (bearer token / pairing code).
  "/api/computers/node",
  // Ambient webhooks authenticate with the per-rule secret, not a session.
  "/api/hooks/",
];

/** Liveness path the container healthcheck probes over loopback (Host: 127.0.0.1:<port>). */
const HEALTH_PATH = "/api/health";

/** State-changing methods: a cross-site request can make the browser act as the logged-in user. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Never let an untrusted X-Forwarded-Host turn the sign-in redirect into an open redirect. */
function redirectOrigin(req: NextRequest): string {
  const allowed = (process.env.SWARM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().split(":")[0])
    .filter(Boolean);
  const fallbackHost = req.headers.get("host") ?? ""; // hostAllowed(req) checked this at the top of middleware.
  const forwardedHost = (req.headers.get("x-forwarded-host") ?? "").trim();
  let host = fallbackHost;
  if (allowed.length && forwardedHost && !/[\\/@?#,]/.test(forwardedHost)) {
    try {
      const parsed = new URL(`http://${forwardedHost}`);
      if (parsed.pathname === "/" && !parsed.username && !parsed.password && allowed.includes(parsed.hostname.toLowerCase())) host = parsed.host;
    } catch {
      // Ignore malformed proxy metadata and keep the already allowlisted Host.
    }
  }
  const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "").trim().toLowerCase();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : req.nextUrl.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const dev = process.env.NODE_ENV === "development";
  // Framing policy for this request. The VM preview proxy (/preview/*) is
  // framed by the in-app Preview tab, so its responses allow same-origin
  // framing ('self' + SAMEORIGIN); every other response keeps 'none'/DENY.
  // The proxy itself re-imposes the same policy on the previewed app's
  // framing headers, so middleware and route agree.
  const headerOpts: SecurityHeadersOptions = pathname.startsWith("/preview/")
    ? { dev, frameAncestors: "'self'" }
    : { dev };
  // X-RateLimit-* headers for /api/* requests in server mode; null elsewhere.
  let rate: RateInfo | null = null;

  // Route handlers learn who is calling from this header, and a client must
  // never be able to supply it. Strip it at the very top of middleware() —
  // before the early-bypass returns below — so the LLM proxy and the approval
  // hook (which return before the auth gate) never forward a client-supplied
  // value to a route handler either. Every NextResponse.next() below forwards
  // these stripped headers; the authenticated user id is set on them further
  // down, after the user gate.
  const headers = new Headers(req.headers);
  headers.delete(USER_HEADER);

  // A rejected origin gets a bare 403 with the hardening headers, no nonce:
  // nothing renders below it, so no CSP-nonce flow is needed. The health
  // endpoint is the one exception: the Docker healthcheck reaches the app on
  // loopback (Host: 127.0.0.1:<port>), which is not in SWARM_ALLOWED_HOSTS in
  // server mode. It is already public, so allow only that path over loopback.
  const loopbackHealthProbe = pathname === HEALTH_PATH && isLoopbackHost(req);
  if (!hostAllowed(req) && !loopbackHealthProbe) {
    return withSecurityHeaders(new NextResponse("forbidden", { status: 403 }), "", headerOpts);
  }
  // One nonce per request, shared by the response CSP and the scripts Next
  // renders (it picks the nonce up from the forwarded CSP request header).
  const nonce = crypto.randomBytes(NONCE_BYTES).toString("base64");
  const user = requestUser(req);

  // Rate limit /api/* in server mode (local mode is a single trusted user on loopback).
  if (serverMode() && pathname.startsWith("/api/")) {
    const key = rateLimitKey(req, user);
    const result = rateLimitCheck(pathname, key);
    if (result) {
      rate = result;
      if (!result.allowed) return withSecurityHeaders(rateLimitResponse(result), nonce, headerOpts, result);
    }
  }

  // Public share pages (/share/<token>) and token-gated preview links
  // (/preview/share/<token>/<port>/) are unauthenticated and reachable by
  // anyone holding the link, so they are throttled per IP in every mode: a
  // scanner minting random tokens must not be able to turn one request into a
  // sweep of every account on the box (bug 19).
  if (pathname.startsWith("/share/") || pathname.startsWith("/preview/share/")) {
    const result = rateLimitCheck(pathname, shareRateLimitKey(req));
    if (result) {
      rate = result;
      if (!result.allowed) return withSecurityHeaders(rateLimitResponse(result), nonce, headerOpts, result);
    }
  }

  // The LLM translation proxy (/api/runtime/llm/...) authenticates itself with
  // a per-run HMAC token, not a session/bearer credential, so it bypasses the
  // user gate below. It still passes the host check and rate limiting above.
  if (pathname.startsWith("/api/runtime/llm/")) {
    return withSecurityHeaders(NextResponse.next({ request: { headers } }), nonce, headerOpts, rate);
  }

  // The in-VM PreToolUse approval hook is a server-to-server call from the
  // user's VM. It authenticates with the per-run HMAC token (never a browser
  // session), so it bypasses the user/session gate exactly like the LLM proxy.
  if (pathname === "/api/runtime/approvals/hook") {
    return withSecurityHeaders(NextResponse.next({ request: { headers } }), nonce, headerOpts, rate);
  }

  // Route handlers learn who is calling from this header. Always overwrite it so a client can't supply its own.
  if (user) headers.set(USER_HEADER, user.id);
  // Forward the policy (and nonce) so Next.js stamps the nonce onto its own
  // inline bootstrap scripts; the response below carries the enforcement copy.
  headers.set("Content-Security-Policy", cspValue(nonce, headerOpts));
  headers.set(NONCE_HEADER, nonce);

  // Content-Type gate for state-changing /api/* calls. A cross-site simple
  // request (a form or a text/plain fetch) can carry a body but cannot set
  // Content-Type: application/json, so a non-JSON body is refused here even
  // when no Origin/Sec-Fetch-Site header is present to trip the gate below.
  // Exempt: multipart uploads (the file-upload routes) and
  // /api/mcp/swarm-board, whose JSON-RPC clients are gated separately by the
  // Tier 1 board auth (session or harness bearer). A request with no
  // Content-Type at all is allowed through: bodyless triggers (a DELETE or a
  // POST with no body, which the UI issues without a header) carry no
  // attacker-controlled body, and a cross-site form always sets a
  // Content-Type, so it is still caught by this gate.
  if (pathname.startsWith("/api/") && STATE_CHANGING.has(req.method.toUpperCase()) && pathname !== "/api/mcp/swarm-board") {
    const contentType = req.headers.get("content-type");
    if (contentType) {
      const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json" && mediaType !== "multipart/form-data") {
        return withSecurityHeaders(
          NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 }),
          nonce,
          { dev },
          rate,
        );
      }
    }
  }

  // Cross-site gate for state-changing /api/* calls in both server and local
  // mode. Requests from another origin (including a same-site subdomain,
  // whose cookies SameSite=Lax may still send) must not mutate server-mode
  // accounts or a local user's loopback VM. Runs before the public allow-list
  // so login/signup POSTs are gated too. Harness bearer calls
  // (server-to-server; browsers cannot attach the Authorization header) are
  // exempt. The board endpoint (/api/mcp/swarm-board) is gated like every
  // other API route: its writes require a session or harness bearer, and
  // external MCP clients authenticate with SWARM_HARNESS_TOKEN.
  if (
    pathname.startsWith("/api/") &&
    STATE_CHANGING.has(req.method.toUpperCase()) &&
    !isHarnessBearer(req) &&
    isCrossSite(req)
  ) {
    return withSecurityHeaders(NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 }), nonce, headerOpts, rate);
  }

  if (PUBLIC.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return withSecurityHeaders(NextResponse.next({ request: { headers } }), nonce, headerOpts, rate);
  }
  if (!user) {
    if (!serverMode()) return withSecurityHeaders(new NextResponse("forbidden", { status: 403 }), nonce, headerOpts, rate);
    if (pathname.startsWith("/api/")) {
      return withSecurityHeaders(NextResponse.json({ error: "Sign in required." }, { status: 401 }), nonce, headerOpts, rate);
    }
    if (process.env.SWARM_ALLOW_GUEST_UI === "1" && req.method.toUpperCase() === "GET" && pathname === "/") {
      return withSecurityHeaders(NextResponse.next({ request: { headers } }), nonce, headerOpts, rate);
    }
    // Build the target from the public Host header (already allowlisted): behind the proxy req.url carries the
    // internal host and port, and middleware rejects relative Locations.
    return withSecurityHeaders(NextResponse.redirect(`${redirectOrigin(req)}/login?next=${encodeURIComponent(pathname + search)}`, 303), nonce, headerOpts, rate);
  }
  // Local mode: one canonical origin (127.0.0.1) so localStorage and the OAuth callback don't split across
  // localhost/127.0.0.1. Document navigations only; API/fetch/SSE on localhost keep working.
  const host = (req.headers.get("host") ?? "").split(":")[0];
  if (!serverMode() && host === "localhost" && req.headers.get("sec-fetch-mode") === "navigate") {
    const u = new URL(req.url);
    u.hostname = "127.0.0.1";
    return withSecurityHeaders(NextResponse.redirect(u, 308), nonce, headerOpts, rate);
  }
  return withSecurityHeaders(NextResponse.next({ request: { headers } }), nonce, headerOpts, rate);
}

// Everything except static assets. Uploads bypass middleware (it buffers bodies with a size cap) and call
// isLocal themselves. Node runtime: sessions are looked up in SQLite and hashed with node:crypto, synchronously.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon|icon.png|apple-icon.png|manifest.webmanifest|brand/|api/upload|api/runtime/vm/files/upload).*)"], runtime: "nodejs" };
