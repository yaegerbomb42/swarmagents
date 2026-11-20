/**
 * Latest desktop screenshot for the user's VM, as PNG.
 *
 * GET /api/runtime/vm/screenshot -> image/png
 *
 * The Desktop view uses this as its offline fallback frame: when the live
 * VNC websocket is unavailable (reconnect backoff exhausted / desktop mode
 * hiccup) it fetches this route and shows the fresh frame. The capture runs
 * entirely inside the user's own VM — `scrot` grabs the current X display
 * (:1, the desktop image's XFCE) and the driver reads the file back; the
 * VNC password is never involved.
 *
 * Returns 404 when the VM is not running or the capture fails; the view
 * treats that as "no frame yet", not an error.
 */

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../lib/auth";
import { getVmManager } from "../../../../../lib/vm/manager";
import { DESKTOP_DISPLAY } from "../../../../../lib/vm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-request frame path inside the VM: never the shared /tmp file. */
const SCREENSHOT_PREFIX = "/tmp/swarm-desktop-frame-";
/** The 1600x900 desktop frame as PNG is well under 2 MB. */
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const vm = getVmManager();
  // One unique path per request: concurrent captures must never overwrite
  // each other's frame while it is being read, and no stale frame is left
  // behind in the VM.
  const screenshotPath = `${SCREENSHOT_PREFIX}${randomUUID()}.png`;
  try {
    const state = await vm.status(user);
    if (state.status !== "running") {
      return NextResponse.json({ error: "VM not running." }, { status: 404 });
    }
    // scrot writes the current X server frame; -o overwrites without asking.
    const exec = await vm.exec(
      user,
      ["scrot", "-o", screenshotPath],
      { env: { DISPLAY: DESKTOP_DISPLAY } },
    );
    if (exec.exitCode !== 0) {
      return NextResponse.json({ error: "Desktop capture failed." }, { status: 404 });
    }
    let file;
    try {
      file = await vm.readFileBytes(user, screenshotPath, MAX_SCREENSHOT_BYTES);
    } finally {
      // Delete the frame inside the VM immediately after the read, even if
      // the read failed. Best effort: a VM that just died has nothing to
      // clean up, and the frame must never break the response.
      await vm.exec(user, ["rm", "-f", "--", screenshotPath]).catch(() => undefined);
    }
    if (file.content.byteLength === 0) {
      return NextResponse.json({ error: "Empty capture." }, { status: 404 });
    }
    return new Response(new Uint8Array(file.content), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "Content-Length": String(file.content.byteLength),
      },
    });
  } catch {
    // Any failure (VM missing, unsupported driver, quota, …) degrades to the
    // "no frame" case rather than surfacing a 500.
    return NextResponse.json({ error: "No desktop frame available." }, { status: 404 });
  }
}
