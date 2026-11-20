/**
 * Take over one team lane. The lane stops taking new work and waits for the
 * user in its own folder under /workspace/team/<runId>/<agentId>/.
 *
 * POST { agentId } → { ok, run }
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { getTeamManager } from "@/lib/team/manager";
import { TEAM_RUN_ID_RE } from "@/lib/team/types";
import { JsonBodyError, readJsonBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { runId } = await ctx.params;
  if (!TEAM_RUN_ID_RE.test(runId)) return NextResponse.json({ error: "invalid runId" }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const agentId =
    typeof body === "object" && body !== null && typeof (body as { agentId?: unknown }).agentId === "string"
      ? ((body as { agentId: string }).agentId).trim()
      : "";
  if (!agentId) return NextResponse.json({ error: "agentId is required." }, { status: 400 });

  const run = getTeamManager().takeOver(user, runId, agentId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  return NextResponse.json({ ok: true, run });
}