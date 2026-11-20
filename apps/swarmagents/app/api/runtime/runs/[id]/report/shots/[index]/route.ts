/**
 * One screenshot from a run's report (owner-only).
 *
 * GET /api/runtime/runs/<id>/report/shots/<index> -> image bytes | 404
 *
 * The index refers to the shot's position in the report's `shots` array (the
 * same index the replay slideshow uses). Serving by index keeps the stored
 * file names opaque to clients.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../../../lib/auth";
import { RUN_ID_RE } from "../../../../../../../../lib/telemetry/paths";
import { getRun } from "../../../../../../../../lib/runtime/run-store";
import { readRunReport, readShotBytes } from "../../../../../../../../lib/runtime/run-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { id, index } = await ctx.params;
  if (!RUN_ID_RE.test(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  if (!/^\d+$/.test(index)) {
    return NextResponse.json({ error: "invalid shot index" }, { status: 400 });
  }
  const shotIndex = Number(index);

  const report = readRunReport(id);
  if (!report) return NextResponse.json({ error: "Run report not found." }, { status: 404 });
  const owner = report.userId || getRun(id)?.summary.userId;
  if (!owner || owner !== user) {
    return NextResponse.json({ error: "Run report not found." }, { status: 404 });
  }

  const shot = readShotBytes(id, shotIndex);
  if (!shot) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });

  return new Response(Uint8Array.from(shot.bytes), {
    headers: {
      "Content-Type": shot.mime,
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(shot.bytes.length),
    },
  });
}
