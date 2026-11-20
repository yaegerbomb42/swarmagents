/**
 * VM runtime status for the caller's VM.
 *
 * GET /api/runtime/vm/status -> {status: VmState, disk: {usedMb, quotaMb, overQuota}}
 *
 * Read-only by design: the UI polls this every 30 s, so it must never create
 * or wake a VM (that would reset the idle timer and defeat hibernation).
 * `disk.quotaMb` comes from SWARM_VM_DISK_QUOTA_MB (0 = unlimited); `usedMb`
 * is the last cached du measurement of /workspace (or 0 before the first
 * measurement) — this route never runs du itself.
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
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

  const vm = getVmManager();
  try {
    const status = await vm.status(user);
    // Cached/last-known only: measuring disk would call ensure() and wake a
    // hibernated VM on every poll.
    const disk = vm.cachedDiskUsage(user);
    // Whether this deployment runs VMs in desktop mode (the driver sets
    // `desktop` only when SWARM_VM_DESKTOP=1). The UI uses it to keep
    // the pre-desktop screen when desktop mode is off.
    const desktop = vm.driver.desktop === true;
    return NextResponse.json({ status, disk, desktop });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not query VM status.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
