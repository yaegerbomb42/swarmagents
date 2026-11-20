/**
 * Owner-facing guest suggestion queue.
 *
 * GET  /api/runtime/suggestions -> the caller's pending guest suggestions
 * (non-executing, FIFO). Only the owner can see them; a guest can never read
 * another owner's pending queue.
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "@/lib/auth";
import { getSuggestionsStore, maxQueuedFromEnv } from "@/lib/rooms/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const store = getSuggestionsStore();
  return NextResponse.json({
    suggestions: store.list(user),
    limit: maxQueuedFromEnv(),
  });
}
