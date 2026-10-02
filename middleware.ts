import { NextResponse, type NextRequest } from "next/server";
import { hostAllowed, requestUser, serverMode, USER_HEADER } from "./lib/auth";

// The agent has full control of the machine it runs on, so nothing is reachable without passing lib/auth.
// Kept under this name because route handlers that bypass middleware (uploads) import it as their gate.
export { isAllowed as isLocal } from "./lib/auth";

/** Reachable signed out: the sign-in page and the endpoints it uses. */
const PUBLIC = new Set(["/login", "/api/login", "/api/signup", "/api/me"]);

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
  if (!hostAllowed(req)) return new NextResponse("forbidden", { status: 403 });
  const user = requestUser(req);
  // Route handlers learn who is calling from this header. Always overwrite it so a client can't supply its own.
  const headers = new Headers(req.headers);
  headers.delete(USER_HEADER);
  if (user) headers.set(USER_HEADER, user.id);
  if (PUBLIC.has(pathname)) return NextResponse.next({ request: { headers } });
  if (!user) {
    if (!serverMode()) return new NextResponse("forbidden", { status: 403 });
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    // Build the target from the public Host header (already allowlisted): behind the proxy req.url carries the
    // internal host and port, and middleware rejects relative Locations.
    return NextResponse.redirect(`${redirectOrigin(req)}/login?next=${encodeURIComponent(pathname + search)}`, 303);
  }
  // Local mode: one canonical origin (127.0.0.1) so localStorage and the OAuth callback don't split across
  // localhost/127.0.0.1. Document navigations only; API/fetch/SSE on localhost keep working.
  const host = (req.headers.get("host") ?? "").split(":")[0];
  if (!serverMode() && host === "localhost" && req.headers.get("sec-fetch-mode") === "navigate") {
    const u = new URL(req.url);
    u.hostname = "127.0.0.1";
    return NextResponse.redirect(u, 308);
  }
  return NextResponse.next({ request: { headers } });
}

// Everything except static assets. Uploads bypass middleware (it buffers bodies with a size cap) and call
// isLocal themselves. Node runtime: sessions are looked up in SQLite and hashed with node:crypto, synchronously.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon|icon.png|apple-icon.png|manifest.webmanifest|brand/|api/upload).*)"], runtime: "nodejs" };
