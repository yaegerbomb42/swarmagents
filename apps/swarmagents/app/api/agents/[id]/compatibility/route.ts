/** GET /api/agents/{id}/compatibility -> what this harness can and cannot run. No deploy. */

import type { NextRequest } from "next/server";
import { getAgent } from "@/lib/agents/store";
import { compatibilityReport } from "@/lib/agents/compatibility";
import { swarmAdapter } from "@/lib/agents/adapters/swarm";
import { agentCaller, notFound, ok, routeId, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  const manifest = getAgent(user, id);
  if (!manifest) return notFound();
  return ok({
    harness: swarmAdapter.id,
    capabilities: swarmAdapter.capabilities(),
    report: compatibilityReport(manifest, { userId: user }),
  });
}
