import { NextResponse, type NextRequest } from "next/server";

// The agent has full control of this Mac. Refuse anything that isn't a local page (blocks DNS rebinding / CSRF).
export function isLocal(req: Request) {
  const host = (req.headers.get("host") ?? "").split(":")[0];
  const origin = req.headers.get("origin");
  const local = (h: string) => h === "127.0.0.1" || h === "localhost";
  return local(host) && (!origin || local(new URL(origin).hostname));
}

export function middleware(req: NextRequest) {
  if (!isLocal(req)) return new NextResponse("forbidden", { status: 403 });
  // One canonical local origin (127.0.0.1): localStorage, and the OAuth
  // callback landing, must not split across localhost/127.0.0.1.
  // Redirect document navigations only — API/fetch/SSE/curl on localhost keep working.
  const host = (req.headers.get("host") ?? "").split(":")[0];
  if (host === "localhost" && req.headers.get("sec-fetch-mode") === "navigate") {
    const u = new URL(req.url);
    u.hostname = "127.0.0.1";
    return NextResponse.redirect(u, 308);
  }
  return NextResponse.next();
}

// Uploads bypass middleware (it buffers bodies with a size cap) and check locality themselves.
// "/" is matched so the canonical-host redirect (and the local guard) also cover page loads.
export const config = { matcher: ["/", "/api/((?!upload).*)"] };
