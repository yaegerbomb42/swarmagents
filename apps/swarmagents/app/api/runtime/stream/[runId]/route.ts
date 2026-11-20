import type { NextRequest } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { getRuntimeManager } from "@/lib/runtime/manager";
import { getRemoteRunManager } from "@/lib/computers/remote";
import { sseResponse } from "@/lib/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const user = req.headers.get(USER_HEADER);
  if (!user || user.length > 128) return Response.json({ error: "Sign in required." }, { status: 401 });

  const { runId } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return Response.json({ error: "invalid runId" }, { status: 400 });
  if (!getRuntimeManager().ownsRun(user, runId) && !getRemoteRunManager().ownsRun(user, runId)) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  const lastEventId = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("from");
  const parsed = lastEventId ? Number(lastEventId) : 0;
  const fromSeq = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  return new Response(sseResponse(runId, fromSeq, req.signal), { headers: SSE_HEADERS });
}
