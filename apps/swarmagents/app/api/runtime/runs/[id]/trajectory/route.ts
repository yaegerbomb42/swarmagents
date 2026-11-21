/** Download the caller's opt-in replayable run record. */

import { NextResponse, type NextRequest } from "next/server";
import { isValidRunId, reportCaller } from "../../../../../../lib/runtime/report-route-auth";
import { readRunTrajectory } from "../../../../../../lib/runtime/trajectory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = reportCaller(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const { id } = await ctx.params;
  if (!isValidRunId(id)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  const record = readRunTrajectory(id);
  if (!record || record.userId !== user) return NextResponse.json({ error: "Run trajectory not found." }, { status: 404 });

  return new NextResponse(record.contents, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${id}.jsonl"`,
      "cache-control": "no-store",
    },
  });
}
