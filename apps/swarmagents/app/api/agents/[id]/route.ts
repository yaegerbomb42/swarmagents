/**
 * GET    /api/agents/{id} -> one manifest
 * PUT    /api/agents/{id} -> replace it (the previous version is kept in history)
 * DELETE /api/agents/{id} -> remove it and its history
 */

import type { NextRequest } from "next/server";
import { deleteAgent, getAgent, saveAgent } from "@/lib/agents/store";
import { agentCaller, badRequest, notFound, ok, readAgentBody, routeId, unauthorized } from "@/lib/agents/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  const manifest = getAgent(user, id);
  if (!manifest) return notFound();
  return ok({ agent: manifest });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  if (!getAgent(user, id)) return notFound();
  const body = await readAgentBody(req);
  if (!body.ok) return body.response;
  const input = body.value && typeof body.value === "object" ? { ...(body.value as Record<string, unknown>) } : body.value;
  if (input && typeof input === "object" && (input as Record<string, unknown>).id !== id) {
    return badRequest("The manifest id must match the agent id in the path.");
  }
  const result = saveAgent(user, input);
  if (!result.ok) return badRequest("Agent manifest is invalid.", { errors: result.errors, warnings: result.warnings });
  return ok({ agent: result.manifest, warnings: result.warnings });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = agentCaller(req);
  if (!user) return unauthorized();
  const id = await routeId(ctx);
  if (!deleteAgent(user, id)) return notFound();
  return ok({ ok: true, id });
}
