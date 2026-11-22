/**
 * POST /api/providers/test — send a tiny completion to verify a provider.
 *
 * Accepts a saved provider id (its key and settings are used) or a complete
 * unsaved draft from the settings drawer. Returns only a short redacted text
 * preview, the model and latency. Never echoes the key or request headers.
 */

import { NextResponse, type NextRequest } from "next/server";
import { canonicalProviderId, providerKindForCatalog } from "@/lib/providers/catalog";
import { testProviderConnection } from "@/lib/providers/discovery";
import { classifyProbeError } from "@/lib/providers/errors";
import { providerOwner } from "@/lib/providers/owner";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { routerProviders } from "@/lib/providers/store";
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

  const id = canonicalProviderId(input.id) || "custom";
  const saved = routerProviders(owner).find((c) => c.id === id);

  const requestedStyleRaw = input.apiStyle;
  let requestedStyle = requestedStyleRaw;
  // Same legacy aliases as POST /api/providers: both meant OpenAI chat completions.
  if (requestedStyleRaw === "openai-compatible" || requestedStyleRaw === "custom") requestedStyle = "openai-chat";
  if (requestedStyle !== undefined && !isApiStyle(requestedStyle)) {
    return NextResponse.json({ error: "Unsupported API style." }, { status: 400, headers: NO_STORE });
  }
  const style: ApiStyle =
    (requestedStyle as ApiStyle | undefined) ?? saved?.apiStyle ?? "openai-chat";

  const requestedBase =
    typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : undefined;
  // For Ollama, fall back through the user's configured endpoint rather than
  // the catalog default, so a custom local/LAN port works from this route.
  const baseUrl =
    requestedBase ??
    (style === "ollama" ? resolveOllamaBaseUrl(owner, saved?.baseUrl) : saved?.baseUrl);
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

  const models = Array.isArray(input.models)
    ? input.models.filter((m): m is string => typeof m === "string")
    : undefined;
  const config: ProviderConfig = {
    ...(saved ?? {}),
    id,
    kind: saved?.kind ?? providerKindForCatalog({ apiStyle: style }),
    apiStyle: style,
    ...(auth ? { auth } : {}),
    ...(headers ? { headers } : {}),
    baseUrl,
    ...(models && models.length > 0
      ? {
          models: {
            fast: models[0],
            balanced: models[0],
            deep: models[models.length - 1],
          },
        }
      : {}),
  } as ProviderConfig;

  const providedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = providedKey || saved?.keys?.[0] || "";
  const model = typeof input.model === "string" ? input.model : undefined;

  const startedAt = Date.now();
  try {
    const result = await testProviderConnection(config, apiKey, {
      ...(model ? { model } : {}),
      timeoutMs: 20_000,
    });
    return NextResponse.json({ ...result, status: 200 }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Structured failure the UI can render precisely: coarse class
    // (auth/network/rate-limit/unknown), the finer kind and HTTP status
    // when known, and how long the probe took. Existing fields unchanged.
    const probe = classifyProbeError(err);
    return NextResponse.json(
      {
        ok: false,
        error: message.slice(0, 500),
        errorClass: probe.errorClass,
        ...(probe.kind ? { kind: probe.kind } : {}),
        ...(probe.status !== undefined ? { status: probe.status } : {}),
        latencyMs: Date.now() - startedAt,
      },
      { status: 502, headers: NO_STORE },
    );
  }
}
