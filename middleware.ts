import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, hostAllowed, isAllowed, misconfigured } from "./lib/auth";

// The agent has full control of the machine it runs on, so nothing is reachable without passing lib/auth.
// Kept under this name because route handlers that bypass middleware (uploads) import it as their gate.
export const isLocal = isAllowed;

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (misconfigured()) return new NextResponse("Server mode requires SWARM_AUTH_TOKEN; refusing to serve.", { status: 503 });
  if (!hostAllowed(req)) return new NextResponse("forbidden", { status: 403 });
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();
  if (!isAllowed(req)) {
    if (!authEnabled()) return new NextResponse("forbidden", { status: 403 });
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    // Relative Location: behind the proxy req.url carries the internal host and port.
    return new NextResponse(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(pathname + search)}` } });
  }
  // Local mode: one canonical origin (127.0.0.1) so localStorage and the OAuth callback don't split across
  // localhost/127.0.0.1. Document navigations only; API/fetch/SSE on localhost keep working.
  const host = (req.headers.get("host") ?? "").split(":")[0];
  if (!authEnabled() && host === "localhost" && req.headers.get("sec-fetch-mode") === "navigate") {
    const u = new URL(req.url);
    u.hostname = "127.0.0.1";
    return NextResponse.redirect(u, 308);
  }
  return NextResponse.next();
}

// Everything except static assets. Uploads bypass middleware (it buffers bodies with a size cap) and call
// isLocal themselves.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon|api/upload).*)"] };
