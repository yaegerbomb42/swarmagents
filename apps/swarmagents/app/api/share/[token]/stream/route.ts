/**
 * Guest live-room SSE stream (token-gated, read-only).
 *
 * GET /api/share/{token}/stream -> Server-Sent Events for the owner's current
 * run. The share token is the only credential; the run is resolved from the
 * owner's account, so a guest can never address a run they were not granted.
 * Guests subscribe read-only — the bus never feeds control events over this
 * path.
 */

import type { NextRequest } from "next/server";
import { resolveRoom } from "@/lib/rooms/room";
import { sseResponse } from "@/lib/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const room = resolveRoom(token);
  if (!room) {
    return Response.json({ error: "Share link not found." }, { status: 404 });
  }
  if (!room.run) {
    return Response.json({ error: "No live run for this share." }, { status: 404 });
  }

  const lastEventId = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("from");
  const parsed = lastEventId ? Number(lastEventId) : 0;
  const fromSeq = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  return new Response(sseResponse(room.run.runId, fromSeq, req.signal), { headers: SSE_HEADERS });
}
