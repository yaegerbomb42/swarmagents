/**
 * Ambient webhook. The path secret is the credential, not a browser session.
 *
 * POST /api/hooks/<userId>/<id>
 *   Authorization: Bearer <rule.webhookSecret>
 *   or X-Swarm-Hook-Secret: <rule.webhookSecret>
 *
 * The secret is verified before the body is read: an unauthenticated caller
 * learns nothing and spends no bytes. Unknown ids and wrong secrets answer
 * with the identical 401, so valid (userId, id) pairs cannot be enumerated.
 * The route enforces a bounded body (oversized or malformed JSON is rejected
 * before the ambient engine runs) and validates userId/id format at the
 * boundary. A JSON body is required; the payload itself is ignored by the
 * engine today (payload-trigger context is a separate task).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAmbientEngine } from "../../../../../lib/ambient/runtime";
import { ambientIdsOk } from "../../../../../lib/ambient/engine";
import { JsonBodyError, readJsonBody } from "../../../../../lib/http";
import { rateLimitCheck, rateLimitKey } from "../../../../../lib/rate-limit";

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
  try {
    const { userId, id } = await context.params;

    // Rate limiting: per hook and per IP on webhook auth attempts
    const ip = rateLimitKey(req, null);
    const hookKey = `webhook:${userId}:${id}:${ip}`;
    const rate = rateLimitCheck(`/api/hooks/${userId}/${id}`, hookKey);
    if (rate && !rate.allowed) {
      return NextResponse.json(
        { error: "Too Many Requests" },
        {
          status: 429,
          headers: {
            ...NO_STORE,
            "Retry-After": String(rate.retryAfter),
            "X-RateLimit-Limit": String(rate.limit),
            "X-RateLimit-Remaining": String(rate.remaining),
            "X-RateLimit-Reset": String(rate.reset),
          },
        },
      );
    }

    // The ids are path segments that name a store key on disk; enforce the
    // same shape the engine uses, at the boundary, before any dispatch.
    if (!ambientIdsOk(userId, id)) {
      return NextResponse.json({ error: "Invalid userId or id." }, { status: 400, headers: NO_STORE });
    }

    // Secret first: no body is read for an unauthenticated caller, and a
    // missing rule answers exactly like a wrong secret (same status, same body).
    const check = getAmbientEngine().checkWebhook(userId, id, presentedSecret(req));
    if (check === "not found" || check === "unauthorized") {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    }

    // Bounded read: a huge or malformed body never reaches the engine.
    try {
      await readJsonBody(req);
    } catch (error) {
      if (error instanceof JsonBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
      }
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
    }

    const result = await getAmbientEngine().acceptWebhook(userId, id, presentedSecret(req));
    if (
      result.error === "unauthorized" ||
      result.error === "invalid id" ||
      result.error === "not found"
    ) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    }
    if (!result.fired) {
      return NextResponse.json({ error: result.error ?? "Not fired." }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, runId: result.runId, queued: result.queued }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error." },
      { status: 500, headers: NO_STORE },
    );
  }
}
