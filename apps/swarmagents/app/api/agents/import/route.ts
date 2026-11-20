/** POST /api/agents/import -> validate, strip secrets, store. Unknown skills become warnings. */

import type { NextRequest } from "next/server";
import { importAgent } from "@/lib/agents/store";
import { agentCaller, badRequest, ok, readAgentBody, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const body = await readAgentBody(req);
  if (!body.ok) return body.response;
  const result = importAgent(user, body.value);
  if (!result.ok) return badRequest("The imported agent is invalid.", { errors: result.errors });
  return ok({ agent: result.manifest, warnings: result.warnings }, 201);
}
