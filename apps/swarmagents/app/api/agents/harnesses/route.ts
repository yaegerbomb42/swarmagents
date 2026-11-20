/** GET /api/agents/harnesses -> available harness adapters and their capabilities. */

import type { NextRequest } from "next/server";
import { harnessAdapters } from "@/lib/agents/adapters/swarm";
import { agentCaller, ok, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const harnesses = harnessAdapters().map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    capabilities: adapter.capabilities(),
  }));
  return ok({ harnesses });
}
