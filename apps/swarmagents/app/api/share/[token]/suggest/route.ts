/**
 * Guest prompt suggestion endpoint (token-gated).
 *
 * POST /api/share/{token}/suggest  {prompt} -> adds a non-executing suggestion
 * to the owner's FIFO pending queue, bounded by SWARM_MAX_QUEUED and
 * rate-limited per owner. Suggestions never start a run by themselves — only
 * the owner can run one from their own dashboard.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveRoom } from "@/lib/rooms/room";
import { getSuggestionsStore, MAX_SUGGESTION_LEN } from "@/lib/rooms/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 64 * 1024;

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const room = resolveRoom(token);
  if (!room) {
    return NextResponse.json({ error: "Share link not found." }, { status: 404 });
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "Could not read request body." }, { status: 400 });
  }
  if (text.length > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const rawPrompt = (body as Record<string, unknown>).prompt;
  if (typeof rawPrompt !== "string") {
    return NextResponse.json({ error: "prompt is required." }, { status: 400 });
  }
  const prompt = rawPrompt.trim();
  if (!prompt || prompt.length > MAX_SUGGESTION_LEN) {
    return NextResponse.json({ error: "prompt must be non-empty." }, { status: 400 });
  }

  const result = getSuggestionsStore().add(room.ownerId, prompt);
  if (!result.accepted) {
    if (result.limit !== undefined) {
      return NextResponse.json({ error: result.error, limit: result.limit }, { status: 429 });
    }
    if (result.error === "Too many suggestions. Please wait.") {
      return NextResponse.json({ error: result.error }, { status: 429 });
    }
    return NextResponse.json({ error: result.error ?? "Could not add suggestion." }, { status: 400 });
  }

  return NextResponse.json({ accepted: true, suggestion: result.suggestion }, { status: 201 });
}
