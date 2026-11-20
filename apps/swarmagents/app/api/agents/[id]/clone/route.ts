/** POST /api/agents/{id}/clone { newId? } -> a copy of the agent. */

import type { NextRequest } from "next/server";
import { cloneAgent } from "@/lib/agents/store";
import { agentCaller, badRequest, notFound, ok, readAgentBody, routeId, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  const body = await readAgentBody(req);
  if (!body.ok) return body.response;
  const newId =
    body.value && typeof body.value === "object" && typeof (body.value as { newId?: unknown }).newId === "string"
      ? ((body.value as { newId: string }).newId)
      : undefined;
  const result = cloneAgent(user, id, newId);
  if (!result.ok) return result.error === "agent not found" ? notFound() : badRequest(result.error);
  return ok({ agent: result.manifest }, 201);
}
