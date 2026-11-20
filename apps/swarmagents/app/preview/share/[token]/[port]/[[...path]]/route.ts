/**
 * Token-gated VM preview proxy (F10).
 *
 * /preview/share/<token>/<port>/[...path] — the shareable preview URL: a
 * client holding the link can interact with the live app the agent built,
 * with no port-forwarding and no deploy. The token is the only credential
 * (same model as /share/<token>); the port must match the token and still
 * be listening in the owner's VM. See lib/preview/serve.ts for the full
 * rules. WebSocket upgrades are not supported by Next.js route handlers,
 * so a socket that connects under this mount is accepted by the desktop
 * proxy instead (lib/desktop-proxy/proxy.ts; nginx routes preview
 * upgrades there).
 */

import type { NextRequest } from "next/server";
import { serveSharedPreview } from "../../../../../../lib/preview/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { token: string; port: string; path?: string[] };

async function handle(req: NextRequest, context: { params: Promise<Params> }) {
  return serveSharedPreview(req, await context.params);
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
