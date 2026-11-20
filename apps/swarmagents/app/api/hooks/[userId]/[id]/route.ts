/**
 * Ambient webhook. The path secret is the credential, not a browser session.
 *
 * POST /api/hooks/<userId>/<id>
 *   Authorization: Bearer <rule.webhookSecret>
 *   or X-Swarm-Hook-Secret: <rule.webhookSecret>
 *
 * The route enforces a bounded body (oversized or malformed JSON is rejected
 * before the ambient engine runs) and validates userId/id format at the
 * boundary. A JSON body is required; the payload itself is ignored by the
 * engine today (payload-trigger context is a separate task).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAmbientEngine } from "../../../../../lib/ambient/runtime";
import { ambientIdsOk } from "../../../../../lib/ambient/engine";
import { JsonBodyError, readJsonBody } from "../../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The reply drives a run: a cached response would silently swallow a trigger. */
const NO_STORE = { "cache-control": "no-store" } as const;

function presentedSecret(req: NextRequest): string {
  const header = req.headers.get("x-swarm-hook-secret")?.trim();
  if (header) return header;
  const auth = req.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await context.params;

  // The ids are path segments that name a store key on disk; enforce the
  // same shape the engine uses, at the boundary, before any dispatch.
  if (!ambientIdsOk(userId, id)) {
    return NextResponse.json({ error: "Invalid userId or id." }, { status: 400 });
  }

  // Bounded read: a huge or malformed body never reaches the engine.
  try {
    await readJsonBody(req);
  } catch (error) {
    if (error instanceof JsonBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const result = await getAmbientEngine().acceptWebhook(userId, id, presentedSecret(req));
  if (result.error === "unauthorized" || result.error === "invalid id") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }
  if (result.error === "not found") {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  }
  if (!result.fired) {
    return NextResponse.json({ error: result.error ?? "Not fired." }, { status: 409, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, runId: result.runId, queued: result.queued }, { headers: NO_STORE });
}
