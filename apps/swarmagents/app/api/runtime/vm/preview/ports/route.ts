/**
 * VM preview ports (F10).
 *
 * GET  /api/runtime/vm/preview/ports -> {running, ports, detectedAt, cached}
 * POST /api/runtime/vm/preview/ports -> same, with a forced fresh probe
 *
 * Read-only list of the TCP ports a process inside the caller's VM is
 * listening on (see lib/preview/ports). Detection never wakes a hibernated
 * VM: when the VM is not running, `running` is false and `ports` is empty.
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { getVmManager } from "../../../../../../lib/vm/manager";
import { invalidatePreviewPorts, listeningPorts } from "../../../../../../lib/preview/ports";

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
    const result = await listeningPorts(getVmManager(), user);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not detect preview ports.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  try {
    // A forced refresh bypasses the TTL cache; the entry is dropped first
    // so a stale cache can never survive a failed re-probe.
    invalidatePreviewPorts(user);
    const result = await listeningPorts(getVmManager(), user, { forceRefresh: true });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not detect preview ports.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
