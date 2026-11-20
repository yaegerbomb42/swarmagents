/**
 * POST /api/providers/discover — list models from a provider.
 *
 * Works for a saved provider (id only) or an unsaved draft in the settings
 * drawer. Ollama performs /api/tags plus /api/show per model, returning
 * capabilities. Discovery results for a saved provider are persisted as
 * availableModels plus per-model capability overrides when `save` is not false.
 *
 * Keys are read server-side and never returned; URLs are SSRF-checked before
 * any request leaves the process.
 */

import { NextResponse, type NextRequest } from "next/server";
import { canonicalProviderId, providerKindForCatalog } from "@/lib/providers/catalog";
import { discoverProviderModels } from "@/lib/providers/discovery";
import { providerOwner } from "@/lib/providers/owner";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import {
  ProviderMutationError,
  routerProviders,
  updateProviderSettings,
} from "@/lib/providers/store";
import { resolveOllamaBaseUrl } from "@/lib/providers/settings";
import { assertResolvableProviderBaseUrl } from "@/lib/providers/url-safety";
import { isApiStyle, isAuthScheme } from "@/lib/providers/types";
import type { ApiStyle, ProviderAuth, ProviderConfig } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function unauthorized() {
  return NextResponse.json({ error: "Sign in required." }, { status: 401, headers: NO_STORE });
}

function parseAuth(input: unknown): ProviderAuth | undefined | null {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (!isAuthScheme(record.scheme)) return null;
  const headerName = typeof record.headerName === "string" ? record.headerName.trim() : undefined;
  if (headerName !== undefined && !/^[A-Za-z0-9-]+$/.test(headerName)) return null;
  return { scheme: record.scheme, ...(headerName ? { headerName } : {}) };
}

/** Extra static headers for a gateway; names are validated, values kept server-side. */
function parseHeaders(input: unknown): Record<string, string> | undefined | null {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || name.length > 64) return null;
    if (typeof value !== "string" || value.length > 2_048) return null;
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Build the config to discover from: saved base, overlaid by the request. */
function discoveryConfig(
  owner: string,
  input: Record<string, unknown>,
  style: ApiStyle,
  baseUrl: string,
): ProviderConfig {
  const id =
    canonicalProviderId(input.id) ||
    (style === "ollama" ? "ollama" : "custom");
  const saved = routerProviders(owner).find((c) => c.id === id);
  const auth = parseAuth(input.auth);
  const models = Array.isArray(input.models)
    ? input.models.filter((m): m is string => typeof m === "string")
    : saved?.models;
  return {
    ...(saved ?? {}),
    id,
    kind: saved?.kind ?? providerKindForCatalog({ apiStyle: style }),
    apiStyle: style,
    ...(auth ? { auth } : {}),
    baseUrl,
    ...(models ? { models } : {}),
  } as ProviderConfig;
}

export async function POST(request: NextRequest) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400, headers: NO_STORE });
  }
  const input = body as Record<string, unknown>;

  const requestedStyleRaw = input.apiStyle;
  let requestedStyle = requestedStyleRaw;
  // Same legacy aliases as POST /api/providers: both meant OpenAI chat completions.
  if (requestedStyleRaw === "openai-compatible" || requestedStyleRaw === "custom") requestedStyle = "openai-chat";
  if (requestedStyle !== undefined && !isApiStyle(requestedStyle)) {
    return NextResponse.json({ error: "Unsupported API style." }, { status: 400, headers: NO_STORE });
  }
  const savedId = canonicalProviderId(input.id);
  const saved = savedId ? routerProviders(owner).find((c) => c.id === savedId) : undefined;
  const style: ApiStyle =
    (requestedStyle as ApiStyle | undefined) ?? saved?.apiStyle ?? "openai-chat";

  const requestedBase =
    typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : undefined;
  // For Ollama, fall back through the user's configured endpoint rather than
  // the catalog default, so a custom local/LAN port works from this route.
  const baseUrl =
    requestedBase ??
    (style === "ollama" ? resolveOllamaBaseUrl(owner, saved?.baseUrl) : saved?.baseUrl ?? "");
  if (!baseUrl) {
    return NextResponse.json({ error: "A base URL is required." }, { status: 400, headers: NO_STORE });
  }
  const safe = await assertResolvableProviderBaseUrl(baseUrl);
  if (!safe.ok) {
    return NextResponse.json({ error: safe.error }, { status: 400, headers: NO_STORE });
  }

  const auth = parseAuth(input.auth);
  if (auth === null) {
    return NextResponse.json({ error: "Invalid auth configuration." }, { status: 400, headers: NO_STORE });
  }
  const headers = parseHeaders(input.headers);
  if (headers === null) {
    return NextResponse.json(
      { error: "headers must be an object of safe header names and string values." },
      { status: 400, headers: NO_STORE },
    );
  }
  const config: ProviderConfig = {
    ...discoveryConfig(owner, input, style, baseUrl),
    ...(headers ? { headers } : {}),
  };
  const providedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = providedKey || saved?.keys?.[0] || "";

  try {
    const result = await discoverProviderModels(config, apiKey);
    let persisted = false;
    if (saved && input.save !== false && result.models.length > 0) {
      const capabilities: Record<string, NonNullable<(typeof result.models)[number]["capabilities"]>> = {};
      for (const model of result.models) {
        if (model.capabilities) capabilities[model.id] = model.capabilities;
      }
      const currentModels = saved.models ? Object.values(saved.models).filter(Boolean) : [];
      const ids = result.models.map((m) => m.id);
      const tier =
        currentModels.length > 0
          ? undefined
          : [ids[0], ids[Math.floor((ids.length - 1) / 2)] ?? ids[0], ids[ids.length - 1]];
      await updateProviderSettings(owner, saved.id, {
        availableModels: ids,
        ...(Object.keys(capabilities).length > 0 ? { modelCapabilities: capabilities } : {}),
        ...(tier ? { models: tier.filter((m): m is string => Boolean(m)) } : {}),
      });
      persisted = true;
    }
    return NextResponse.json(
      { ok: true, endpoint: result.endpoint, models: result.models, persisted },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof ProviderMutationError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 502, headers: NO_STORE });
  }
}
