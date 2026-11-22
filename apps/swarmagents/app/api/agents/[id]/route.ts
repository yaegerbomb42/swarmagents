/**
 * GET    /api/agents/{id} -> one manifest
 * PUT    /api/agents/{id} -> replace it (the previous version is kept in history)
 * DELETE /api/agents/{id} -> remove it and its history
 */

import type { NextRequest } from "next/server";
import { deleteAgent, getAgent, updateAgentAtomic } from "@/lib/agents/store";
import { agentCaller, badRequest, notFound, ok, readAgentBody, routeId, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = (await routeId(ctx)).trim();
  const manifest = getAgent(user, id);
  if (!manifest) return notFound();
  return ok({ agent: manifest });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = (await routeId(ctx)).trim();
  const body = await readAgentBody(req);
  if (!body.ok) return body.response;
  const input = body.value && typeof body.value === "object" ? { ...(body.value as Record<string, unknown>) } : body.value;
  if (input && typeof input === "object" && typeof (input as Record<string, unknown>).id === "string") {
    const bodyId = ((input as Record<string, unknown>).id as string).trim();
    if (bodyId !== id) {
      return badRequest("The manifest id must match the agent id in the path.");
    }
  }

  // Atomic existence check & save inside updateAgentAtomic
  const result = await updateAgentAtomic(user, id, input);
  if (!result.ok) {
    if ("notFound" in result && result.notFound) return notFound();
    const errors = "errors" in result ? result.errors : [];
    const warnings = "warnings" in result ? result.warnings : [];
    return badRequest("Agent manifest is invalid.", { errors, warnings });
  }
  return ok({ agent: result.manifest, warnings: result.warnings });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = (await routeId(ctx)).trim();
  if (!deleteAgent(user, id)) return notFound();
  return ok({ ok: true, id });
}
