/**
 * POST /api/providers/[id]/models — the saved provider's live model ids.
 *
 * Calls the provider's model-list endpoint server-side (OpenAI-compatible
 * /v1/models, Anthropic /models, Gemini /v1beta/models, Ollama /api/tags)
 * with the stored key, using the provider's configured auth style. Results
 * are cached per user for 10 minutes (send `force: true` to bypass) and fail
 * open: a failed refresh serves the last good list, then the saved
 * availableModels, with `source`/`stale` saying so. Only a live fetch is
 * persisted as availableModels.
 *
 * The response carries model ids only; key material never leaves the
 * process, and base URLs are SSRF-checked before any request is made.
 */

import { NextResponse, type NextRequest } from "next/server";
import { canonicalProviderId, catalogEntry } from "@/lib/providers/catalog";
import { discoverModelsWithCache, ModelListCache } from "@/lib/providers/model-cache";
import { persistDiscoveredModels } from "@/lib/providers/discovery-persist";
import { providerOwner } from "@/lib/providers/owner";
import { routerProviders } from "@/lib/providers/store";
import { resolveOllamaBaseUrl } from "@/lib/providers/settings";
import { assertResolvableProviderBaseUrl } from "@/lib/providers/url-safety";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
/** Model ids go stale slowly; a 10-minute cache keeps the picker snappy. */
const MODELS_CACHE_TTL_MS = 10 * 60_000;
const modelsCache = new ModelListCache(MODELS_CACHE_TTL_MS);

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const params = await Promise.resolve(ctx.params);
  const id = canonicalProviderId(typeof params?.id === "string" ? params.id : "");
  const saved = routerProviders(owner).find((c) => c.id === id);
  if (!saved) {
    return NextResponse.json({ error: "Provider not found." }, { status: 404, headers: NO_STORE });
  }
  const apiKey = saved.apiStyle === "ollama" ? "" : (saved.keys?.[0] ?? "");
  // Ollama has no key; the /api/tags endpoint is unauthenticated.
  if (saved.apiStyle !== "ollama" && !apiKey) {
    return NextResponse.json(
      { error: "No API key stored for this provider; add a key first." },
      { status: 400, headers: NO_STORE },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // An empty body is the common case; only malformed JSON matters, and the
    // only field we read is a boolean flag, which defaults to false.
  }

  const baseUrl =
    saved.apiStyle === "ollama" ? resolveOllamaBaseUrl(owner, saved.baseUrl) : saved.baseUrl ?? "";
  if (!baseUrl) {
    return NextResponse.json({ error: "A base URL is required." }, { status: 400, headers: NO_STORE });
  }
  const safe = await assertResolvableProviderBaseUrl(baseUrl);
  if (!safe.ok) {
    return NextResponse.json({ error: safe.error }, { status: 400, headers: NO_STORE });
  }

  const config = { ...saved, baseUrl };
  try {
    const result = await discoverModelsWithCache(config, apiKey, {
      owner,
      force: body.force === true,
      cache: modelsCache,
      fallbackModels: saved.availableModels ?? catalogEntry(saved.id)?.models?.popular,
    });
    const persisted =
      saved &&
      result.source === "live"
        ? await persistDiscoveredModels(owner, saved, result)
        : false;
    const modelEntries = result.models.map((m) => {
      const entry: Record<string, unknown> = { id: m.id };
      if (m.capabilities) entry.capabilities = m.capabilities;
      return entry;
    });

    return NextResponse.json(
      {
        ok: true,
        models: modelEntries,
        endpoint: result.endpoint,
        source: result.source,
        stale: result.stale,
        fetchedAt: result.fetchedAt,
        persisted,
        ...(result.warning ? { warning: result.warning.slice(0, 500) } : {}),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502, headers: NO_STORE });
  }
}
