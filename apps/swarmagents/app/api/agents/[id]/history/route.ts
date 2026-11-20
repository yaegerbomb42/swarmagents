/** GET /api/agents/{id}/history -> previous versions, newest first. */

import type { NextRequest } from "next/server";
import { getAgent, getAgentHistory } from "@/lib/agents/store";
import { agentCaller, notFound, ok, routeId, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  if (!getAgent(user, id)) return notFound();
  const history = getAgentHistory(user, id).map((entry, index) => ({
    versionIndex: index,
    savedAt: entry.savedAt,
    name: entry.manifest.name,
    systemPromptLength: entry.manifest.identity?.systemPrompt?.length ?? 0,
    models: entry.manifest.models,
  }));
  return ok({ history });
}
