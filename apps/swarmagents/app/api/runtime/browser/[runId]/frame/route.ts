/**
 * Latest browser frame for a run, as JPEG.
 *
 * GET /api/runtime/browser/[runId]/frame -> image/jpeg
 *
 * The UI watches the run's SSE stream for `browser.frame` events (metadata
 * only: frameId, size) and fetches this route for the actual pixels. Frames
 * are kept in memory on the server (`lib/browser/manager.ts`) and are not
 * persisted, so a server restart clears them (event stream replay still works
 * — the UI simply shows no frame until the agent navigates again).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../lib/telemetry/paths";
import { getRuntimeManager } from "../../../../../../lib/runtime/manager";
import { getBrowserManager } from "../../../../../../lib/browser/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { runId } = await ctx.params;
  if (!RUN_ID_RE.test(runId)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  if (!getRuntimeManager().ownsRun(user, runId)) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const frame = await getBrowserManager().getFrame(runId);
  if (!frame) {
    return NextResponse.json({ error: "No frame captured yet." }, { status: 404 });
  }

  const bytes = Uint8Array.from(frame.jpeg);
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
