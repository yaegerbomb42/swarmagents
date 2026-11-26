/**
 * The showcase replay for a public share link (core-32).
 *
 * GET /api/share/<token>/replay -> the showcased run's RFB frame bytes | 404
 *
 * The token is the only credential, exactly like the share page itself. The
 * bytes are a concatenation of RFB FramebufferUpdate messages produced by the
 * desktop proxy's frame recorder — no input events, no passwords. Every
 * request re-verifies that the share still resolves, that a showcase is
 * attached, and that the showcased run still belongs to the share's owner,
 * so a revoked link or a re-owned report stops serving immediately.
 */

import { type NextRequest } from "next/server";
import { RUN_ID_RE } from "../../../../../lib/telemetry/paths";
import { readReplayBytes, readRunReport } from "../../../../../lib/runtime/run-report";
import { getRun } from "../../../../../lib/runtime/run-store";
import { getSharedProject, resolveShareOwner } from "../../../../../lib/projects/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const project = getSharedProject(token);
  const showcase = project?.showcase;
  if (!project || !showcase || !RUN_ID_RE.test(showcase.runId)) {
    return Response.json({ error: "Share link not found." }, { status: 404 });
  }

  // Defense in depth: the share index says who owns the link; the report
  // (or the run log for older reports) must still belong to that owner.
  const owner = resolveShareOwner(token);
  const report = readRunReport(showcase.runId);
  const reportOwner = report?.userId || getRun(showcase.runId)?.summary.userId;
  if (!owner || !reportOwner || reportOwner !== owner.ownerId) {
    return Response.json({ error: "Share link not found." }, { status: 404 });
  }

  const replay = readReplayBytes(showcase.runId);
  if (!replay) return Response.json({ error: "Replay not found." }, { status: 404 });

  return new Response(Uint8Array.from(replay), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(replay.length),
    },
  });
}
