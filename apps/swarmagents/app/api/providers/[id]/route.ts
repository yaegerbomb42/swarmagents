/**
 * Provider mutations: remove a provider, or add/remove/rotate one of its
 * keys by index.
 *
 * The responses never carry key material — only a key count and last-4
 * masks — so a client can show which key it is about to rotate without ever
 * seeing the key itself.
 *
 * Auth comes from the middleware (every non-public /api/* route is gated).
 */

import { NextResponse } from "next/server";
import { canonicalProviderId } from "@/lib/providers/catalog";
import { runKeyMutation, runProviderRemoval } from "@/lib/providers/mutations";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { providerRow } from "@/lib/providers/rows";
import { routerProviders, savedProviderIds } from "@/lib/providers/store";
import { providerOwner } from "@/lib/providers/owner";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const NO_STORE = { "cache-control": "no-store" } as const;
/** Bounded body size for provider key mutations; rejects oversized payloads with 413. */
const MAX_PROVIDER_BODY_BYTES = 16 * 1024;

/**
 * Every provider response is per-user configuration: never let a cache in
 * front of the origin (or a service worker) keep a copy, on success or error.
 */
function json(body: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(body, { ...init, headers: NO_STORE });
}

function unauthorized() {
  return json({ error: "Sign in required." }, { status: 401 });
}

async function routeId(ctx: RouteContext): Promise<string> {
  const params = await Promise.resolve(ctx.params);
  const raw = typeof params?.id === "string" ? params.id : "";
  return canonicalProviderId(raw);
}

/** A single provider: key count and last-4 masks, never key material. */
export async function GET(request: Request, ctx: RouteContext) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const id = await routeId(ctx);
  const config = routerProviders(owner).find((p) => p.id === id);
  if (!config) {
    return json({ error: "Provider not found." }, { status: 404 });
  }
  const saved = savedProviderIds(owner).includes(id);
  return json({ provider: providerRow(config, { saved }) });
}

/**
 * Add, remove or rotate a single key of a provider, addressed by slot index.
 *
 * Body: {action:"add-key", apiKey} | {action:"remove-key", index}
 *      | {action:"rotate-key", index, apiKey}
 */
export async function PATCH(request: Request, ctx: RouteContext) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const id = await routeId(ctx);
  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_PROVIDER_BODY_BYTES);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { status, body: payload } = runKeyMutation(owner, id, body);
  return json(payload, { status });
}

/** Remove a saved provider (and its keys) from the caller's providers. */
export async function DELETE(request: Request, ctx: RouteContext) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const id = await routeId(ctx);
  const { status, body } = runProviderRemoval(owner, id);
  return json(body, { status });
}
