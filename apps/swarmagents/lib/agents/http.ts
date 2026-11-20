/**
 * Shared HTTP helpers for the Agent Studio routes.
 *
 * Same contract as the rest of the app: identity comes from the
 * middleware-set `x-swarm-user` header, bodies are capped, and every reply is
 * uncacheable (agent manifests are per-account configuration).
 */

import { NextResponse, type NextRequest } from "next/server";
import { USER_HEADER } from "../auth";

export const AGENT_BODY_LIMIT = 64 * 1024;

export const NO_STORE = { "cache-control": "no-store" } as const;

export function agentCaller(req: NextRequest): string | null {
  const user = req.headers.get(USER_HEADER);
  return user && user.trim().length > 0 && user.length <= 128 ? user : null;
}

export function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

export function badRequest(message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status: 400, headers: NO_STORE });
}

export function notFound(message = "Agent not found.") {
  return NextResponse.json({ error: message }, { status: 404, headers: NO_STORE });
}

export function serverError(message: string) {
  return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
}

export function ok(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export type JsonRead =
  | { ok: true; value: unknown }
  | { ok: false; response: NextResponse };

/** Read a bounded JSON body. Never throws. */
export async function readAgentBody(req: NextRequest, limit = AGENT_BODY_LIMIT): Promise<JsonRead> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: badRequest("Could not read the request body.") };
  }
  if (text.length > limit) {
    return { ok: false, response: NextResponse.json({ error: "Request body too large." }, { status: 413, headers: NO_STORE }) };
  }
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: badRequest("Invalid JSON body.") };
  }
}

/** Next 15 hands route params as a promise; accept both shapes. */
export async function routeId(context: { params: Promise<{ id: string }> }): Promise<string> {
  const params = await Promise.resolve(context.params);
  return typeof params?.id === "string" ? params.id : "";
}
