/**
 * One paired computer: rename and revoke. Owner-only; another account's id
 * resolves to 404.
 *
 * PATCH  { name } -> { computer }
 * DELETE          -> { ok: true } (removes the token hash; every later node
 *                    call with the old token fails immediately)
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import {
  ComputersError,
  isComputerId,
  renameComputer,
  revokeComputer,
} from "../../../../lib/computers";
import { recordAudit } from "../../../../lib/audit";
import { getRemoteRunManager } from "../../../../lib/computers/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
const MAX_BODY_SIZE = 8 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

function notFound() {
  return NextResponse.json({ error: "Computer not found." }, { status: 404, headers: NO_STORE });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  if (!isComputerId(id)) return notFound();

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400, headers: NO_STORE });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }

  try {
    const computer = renameComputer(user, id, (body as Record<string, unknown>).name);
    if (!computer) return notFound();
    return NextResponse.json({ computer }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof ComputersError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Could not rename the computer." }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  if (!isComputerId(id)) return notFound();
  if (!revokeComputer(user, id)) return notFound();
  recordAudit({ user, action: "computer.revoke", target: id, result: "success" });
  // A revoked machine can never run again: fail its live jobs now instead of
  // leaving them paused forever.
  getRemoteRunManager().cancelComputerRuns(user, id);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
