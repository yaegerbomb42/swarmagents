/**
 * GET  /api/agents -> the caller's agents (id, name, description, version, updatedAt)
 * POST /api/agents -> create one agent from a manifest body (validated)
 */

import type { NextRequest } from "next/server";
import { getAgent, listAgents, saveAgent } from "@/lib/agents/store";
import { agentCaller, badRequest, ok, readAgentBody, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  return ok({ agents: listAgents(user) });
}

export async function POST(req: NextRequest) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const body = await readAgentBody(req);
  if (!body.ok) return body.response;
  // Creating is for new agents only. An existing id is a conflict: updates go
  // through PUT /api/agents/[id], which records the previous version in history.
  const rawId =
    body.value && typeof body.value === "object" && !Array.isArray(body.value)
      ? (body.value as Record<string, unknown>).id
      : undefined;
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (id && getAgent(user, id)) {
    return ok({ error: `An agent with id "${id}" already exists.` }, 409);
  }
  const result = saveAgent(user, body.value);
  if (!result.ok) return badRequest("Agent manifest is invalid.", { errors: result.errors, warnings: result.warnings });
  return ok({ agent: result.manifest, warnings: result.warnings }, 201);
}
