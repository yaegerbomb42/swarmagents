import { NextResponse, type NextRequest } from "next/server";

// The agent has full control of this Mac. Refuse anything that isn't a local page (blocks DNS rebinding / CSRF).
export function isLocal(req: Request) {
  const host = (req.headers.get("host") ?? "").split(":")[0];
  const origin = req.headers.get("origin");
  const local = (h: string) => h === "127.0.0.1" || h === "localhost";
  return local(host) && (!origin || local(new URL(origin).hostname));
}

export function middleware(req: NextRequest) {
  return isLocal(req) ? NextResponse.next() : new NextResponse("forbidden", { status: 403 });
}

// Uploads bypass middleware (it buffers bodies with a size cap) and check locality themselves.
export const config = { matcher: "/api/((?!upload).*)" };
