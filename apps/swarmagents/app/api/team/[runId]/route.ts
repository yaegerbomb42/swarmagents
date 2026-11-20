import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { getTeamManager } from "@/lib/team/manager";
import { TEAM_RUN_ID_RE } from "@/lib/team/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One team run snapshot. The live stream is /api/runtime/stream/<runId>. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { runId } = await ctx.params;
  if (!TEAM_RUN_ID_RE.test(runId)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  const run = getTeamManager().getById(user, runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  return NextResponse.json({ run });
}