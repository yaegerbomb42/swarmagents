/**
 * Session-gated VM preview proxy (F10).
 *
 * /preview/<port>/[...path] — the owner's live app, framed in the in-app
 * Preview tab. Every HTTP method is forwarded; see lib/preview/serve.ts
 * for the auth, port-allowlist, and forwarding rules. WebSocket upgrades
 * are not supported by Next.js route handlers, so a Vite HMR socket that
 * connects under this mount is accepted by the desktop proxy instead
 * (lib/desktop-proxy/proxy.ts; nginx routes preview upgrades there) —
 * the app itself loads and works either way.
 */

import type { NextRequest } from "next/server";
import { serveSessionPreview } from "../../../../lib/preview/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { port: string; path?: string[] };

async function handle(req: NextRequest, context: { params: Promise<Params> }) {
  return serveSessionPreview(req, await context.params);
}

export async function GET(req: NextRequest, context: { params: Promise<Params> }) {
  return handle(req, context);
}

export async function POST(req: NextRequest, context: { params: Promise<Params> }) {
  return handle(req, context);
}

export async function PUT(req: NextRequest, context: { params: Promise<Params> }) {
  return handle(req, context);
}

export async function PATCH(req: NextRequest, context: { params: Promise<Params> }) {
  return handle(req, context);
}

export async function DELETE(req: NextRequest, context: { params: Promise<Params> }) {
  return handle(req, context);
}

export async function HEAD(req: NextRequest, context: { params: Promise<Params> }) {
  return handle(req, context);
}

export async function OPTIONS(req: NextRequest, context: { params: Promise<Params> }) {
  return handle(req, context);
}
