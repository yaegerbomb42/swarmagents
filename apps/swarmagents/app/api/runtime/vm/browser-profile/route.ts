/**
 * Persistent VM browser profile for the caller's VM.
 *
 * GET /api/runtime/vm/browser-profile -> { exists, sizeMb }
 * DELETE /api/runtime/vm/browser-profile -> { exists: false, sizeMb: 0 }
 *
 * The profile lives at /workspace/.swarm/browser-profile inside the VM
 * (the desktop Chromium and the headed Playwright MCP server share it),
 * on the /workspace named volume, so authenticated browser sessions
 * survive hibernation and container recreation.
 *
 * Only existence + total size are ever returned: the profile holds cookies
 * and session tokens, which must never leave the VM. Isolation is by
 * construction — VmManager exec/stat run inside the caller's own container,
 * and the profile path is a fixed constant (no user input reaches any
 * command). Auth comes from the middleware-set x-swarm-user header (see
 * lib/auth), mirroring the sibling vm routes.
 *
 * GET may ensure (wake) a hibernated VM — measuring requires a live
 * container. It is fetched on demand (browser view / Settings), not polled.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { getVmManager } from "../../../../../lib/vm/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  try {
    const status = await getVmManager().browserProfileStatus(user);
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not query browser profile.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

  try {
    const status = await getVmManager().clearBrowserProfile(user);
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not clear browser profile.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
