/**
 * Guest live-room state (token-gated).
 *
 * GET /api/share/{token} -> the owner's live-room state: whether there is a
 * run to spectate right now, and the guest suggestion queue capacity. Guests
 * authenticate purely with the share token; no owner identity is ever
 * exposed, and the endpoint never reveals the owner's id/email.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveRoom } from "@/lib/rooms/room";
import { getSuggestionsStore, maxQueuedFromEnv } from "@/lib/rooms/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const room = resolveRoom(token);
  if (!room) {
    return NextResponse.json({ error: "Share link not found." }, { status: 404 });
  }

  const suggestions = getSuggestionsStore();
  const run = room.run;

  return NextResponse.json({
    live: run !== null,
    projectId: room.projectId,
    run: run
      ? {
          runId: run.runId,
          status: run.status,
          prompt: run.prompt,
          ...(run.position !== undefined ? { position: run.position } : {}),
        }
      : null,
    suggestions: {
      count: suggestions.count(room.ownerId),
      limit: maxQueuedFromEnv(),
    },
  });
}
