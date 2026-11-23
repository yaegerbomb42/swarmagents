/**
 * GET  /api/agents -> the caller's agents (id, name, description, version, updatedAt)
 * POST /api/agents -> create one agent from a manifest body (validated)
 */

import type { NextRequest } from "next/server";
import { createAgentAtomic, listAgents } from "@/lib/agents/store";
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

  // Creating is for new agents only. Duplicate ID check and creation are atomic
  // inside createAgentAtomic to eliminate check-then-act race conditions.
  const result = await createAgentAtomic(user, body.value);
  if (!result.ok) {
    if (result.conflict) {
      return ok({ error: `An agent with id "${result.id}" already exists.` }, 409);
    }
    return badRequest("Agent manifest is invalid.", { errors: result.errors, warnings: result.warnings });
  }
  return ok({ agent: result.manifest, warnings: result.warnings }, 201);
}
