/**
 * The recorded desktop replay for a finished run (owner-only).
 *
 * GET /api/runtime/runs/<id>/report/replay -> RFB frame bytes | 404
 *
 * The bytes are a concatenation of RFB FramebufferUpdate messages produced by
 * the desktop proxy's frame recorder — no input events, no passwords. Clients
 * decode and play them locally; the file name is never taken from the request.
 */

import { USER_HEADER } from "../../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../../lib/telemetry/paths";
import { readReplayBytes, readRunReport } from "../../../../../../../lib/runtime/run-report";
import { getRun } from "../../../../../../../lib/runtime/run-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!RUN_ID_RE.test(id)) return Response.json({ error: "invalid runId" }, { status: 400 });

  // The report gates the bytes: only its owner may read them. The run log is
  // the fallback for older reports that predate the userId field.
  const report = readRunReport(id);
  const owner = report?.userId || getRun(id)?.summary.userId;
  if (!owner || owner !== user) {
    return Response.json({ error: "Desktop replay not found." }, { status: 404 });
  }

  const replay = readReplayBytes(id);
  if (!replay) return Response.json({ error: "Desktop replay not found." }, { status: 404 });

  return new Response(Uint8Array.from(replay), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(replay.length),
    },
  });
}
