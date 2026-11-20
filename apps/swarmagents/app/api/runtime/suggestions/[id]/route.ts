/**
 * Owner runs a guest suggestion.
 *
 * POST /api/runtime/suggestions/{id} -> moves the owner's pending suggestion
 * into their real run queue (via the runtime manager), so it becomes an
 * executing prompt only once the owner chooses to run it. A guest can never
 * hit this route — it requires the owner's session, and the suggestion is
 * scoped to the owner.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { getSuggestionsStore } from "@/lib/rooms/suggestions";
import { getRuntimeManager } from "@/lib/runtime/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const { id } = await ctx.params;

  const store = getSuggestionsStore();
  const suggestion = store.get(user, id);
  if (!suggestion) {
    return NextResponse.json({ error: "Suggestion not found." }, { status: 404 });
  }

  const result = getRuntimeManager().start(user, { prompt: suggestion.prompt });
  if (!result.accepted) {
    // Leave the suggestion pending so the owner can retry; do not lose it.
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Run queue is full (max ${result.limit ?? 3}). Wait for a run to finish.` },
      { status: 429 },
    );
  }

  // Only now consume the suggestion: the run is actually starting/queued.
  store.remove(user, id);

  if (result.queued) {
    return NextResponse.json(
      { runId: result.runId, queued: true, position: result.position },
      { status: 202 },
    );
  }
  return NextResponse.json({ runId: result.runId }, { status: 201 });
}
