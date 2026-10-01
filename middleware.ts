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
    // Build the target from the public Host header (already allowlisted): behind the proxy req.url carries the
    // internal host and port, and middleware rejects relative Locations.
    const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return NextResponse.redirect(`${proto}://${host}/login?next=${encodeURIComponent(pathname + search)}`, 303);
  }
  // Local mode: the localhost→127.0.0.1 canonicalization is client-side (lib/canonical.ts in page.tsx).
  // A server redirect was tried and reverted: Next normalizes middleware redirect Locations to the
  // request host, producing a same-URL 308 that loops browsers forever. Do not re-add it here.
  return NextResponse.next();
}

// Everything except static assets. Uploads bypass middleware (it buffers bodies with a size cap) and call
// isLocal themselves.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon|api/upload).*)"] };
