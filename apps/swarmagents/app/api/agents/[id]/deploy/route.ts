/**
 * POST /api/agents/{id}/deploy { harness?: "swarm" }
 *   -> 200 { runId, queued, harness, report }
 *   -> 400 { error, missing } when the agent is not compatible with the harness
 */

import type { NextRequest } from "next/server";
import { getAgent } from "@/lib/agents/store";
import { compatibilityReport } from "@/lib/agents/compatibility";
import { harnessAdapters } from "@/lib/agents/adapters/swarm";
import { agentCaller, badRequest, notFound, ok, readAgentBody, routeId, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  const manifest = getAgent(user, id);
  if (!manifest) return notFound();
  const body = await readAgentBody(req);
  if (!body.ok) return body.response;
  const requested =
    body.value && typeof body.value === "object" && typeof (body.value as { harness?: unknown }).harness === "string"
      ? (body.value as { harness: string }).harness
      : "swarm";
  const adapter = harnessAdapters().find((entry) => entry.id === requested);
  if (!adapter) return badRequest(`Unknown harness "${requested}".`, { harnesses: harnessAdapters().map((entry) => entry.id) });

  const report = compatibilityReport(manifest, { userId: user });
  const result = await adapter.deploy(user, manifest);
  if (!result.ok) {
    return badRequest(result.error, { missing: result.missing ?? report.missing, report });
  }
  return ok({ runId: result.runId, queued: result.queued, harness: adapter.id, report });
}
