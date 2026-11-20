/** POST /api/agents/{id}/restore { versionIndex } -> restore a previous version as current. */

import type { NextRequest } from "next/server";
import { getAgent, restoreAgentVersion } from "@/lib/agents/store";
import { agentCaller, badRequest, notFound, ok, readAgentBody, routeId, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  if (!getAgent(user, id)) return notFound();
  const body = await readAgentBody(req);
  if (!body.ok) return body.response;
  const raw = body.value && typeof body.value === "object" ? (body.value as { versionIndex?: unknown }).versionIndex : undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return badRequest("versionIndex must be a non-negative integer.");
  }
  const restored = restoreAgentVersion(user, id, raw);
  if (!restored.ok) return notFound(`Version not found.`);
  return ok({ agent: restored.manifest });
}
