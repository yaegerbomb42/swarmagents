/**
 * ask_human_desktop handoff endpoint (minimal main page).
 *
 * GET  ?runId=<id>&pending=1 -> the caller's unresolved handoffs, so a page
 *      reload still renders the inline "Take the Wheel" card and can resolve it.
 * POST {id}                   -> resolves a pending handoff (the user clicked
 *      "Hand Back to Agent"); the run resumes and the VM-side desktop-handoff
 *      server returns a post-handoff state summary to the agent as the tool
 *      result.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth); the
 * caller must own the handoff (same user as the paused run).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { getHandoffStore, type PendingHandoff } from "../../../../lib/harness/handoffs";
import { recordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 4096;

function caller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.length > 0 && user.length <= 128 ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

function publicHandoff(handoff: PendingHandoff) {
  return {
    id: handoff.id,
    runId: handoff.runId,
    reason: handoff.reason,
    description: handoff.description,
    createdAt: handoff.createdAt,
    expiresAt: handoff.expiresAt,
  };
}

export async function GET(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();
  const params = new URL(req.url).searchParams;
  const runId = params.get("runId") ?? undefined;
  const handoffs = getHandoffStore()
    .listPending({ userId: user, ...(runId ? { runId } : {}) })
    .map(publicHandoff);
  return NextResponse.json({ handoffs });
}

export async function POST(req: NextRequest) {
  const user = caller(req);
  if (!user) return unauthorized();

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
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const store = getHandoffStore();
  const handoff = store.get(id);
  if (!handoff || handoff.userId !== user) {
    return NextResponse.json({ error: "Handoff not found." }, { status: 404 });
  }
  if (handoff.status !== "pending") {
    return NextResponse.json(
      { error: `Handoff already ${handoff.status}.`, status: handoff.status },
      { status: 409 },
    );
  }

  const resolved = store.resolve(id);
  recordAudit({ user, action: "handoff.handback", target: id, result: "success" });
  return NextResponse.json({ ok: true, status: resolved?.status ?? "answered" });
}
