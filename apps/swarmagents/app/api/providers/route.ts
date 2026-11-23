import { NextResponse } from "next/server";
import { PROVIDER_CATALOG, canonicalProviderId } from "@/lib/providers/catalog";
import { runKeyMutation } from "@/lib/providers/mutations";
import { providerRow } from "@/lib/providers/rows";
import {
  ProviderMutationError,
  routerProviders,
  savedProviderIds,
  saveProvider,
  providerQuotaCooldowns,
  updateProviderSettings,
} from "@/lib/providers/store";
import { providerOwner } from "@/lib/providers/owner";
import { recordAudit } from "@/lib/audit";
import { JsonBodyError, readJsonBody } from "@/lib/http";
import { routerQuotaCooldowns } from "@/lib/runtime/llm-routing";
import { assertResolvableProviderBaseUrl } from "@/lib/providers/url-safety";
import { isApiStyle, isAuthScheme, isPerplexityEffort } from "@/lib/providers/types";
import type { ModelCapabilities, PerplexityEffort, ProviderAuth } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
/** Bounded body size for provider config writes; rejects oversized payloads with 413. */
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

/**
 * Providers catalog + the signed-in user's configured providers.
 *
 * The response never includes key material — only per-provider key counts
 * and last-4 masks. `providers` rows are also shaped for the role catalog's
 * model picker (id/label/model/enabled/models). Only the caller's own
 * providers are ever listed.
 */
export function GET(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  const configured = routerProviders(owner);
  const saved = new Set(savedProviderIds(owner));
  const configuredById = new Map(configured.map((p) => [p.id, p]));
  // 402 cooldowns from the legacy key pools and from the LLM router's
  // per-key credit exhaustion (a provider counts once all its keys are out).
  const quotaCooldowns = new Map(Object.entries(providerQuotaCooldowns(owner)));
  for (const [provider, until] of Object.entries(routerQuotaCooldowns(owner))) {
    quotaCooldowns.set(provider, Math.max(quotaCooldowns.get(provider) ?? 0, until));
  }

  const catalog = PROVIDER_CATALOG.map((entry) => {
    const cfg = configuredById.get(entry.id);
    const row = cfg
      ? providerRow(cfg, { saved: saved.has(entry.id), quotaCooldowns })
      : null;
    return {
      ...entry,
      connected: Boolean(row && (row.keyCount > 0 || !row.needsKey)),
      keyCount: row?.keyCount ?? 0,
      rank: row?.rank ?? 0,
      saved: row?.saved ?? false,
      // A saved provider's own billing flag wins; otherwise fall back to
      // the catalog's verified free-tier mark so the card can show it.
      isFree: row?.isFree ?? entry.isFree ?? false,
      quotaCoolingDownUntil: row?.quotaCoolingDownUntil,
      keySlots: row?.keySlots ?? [],
    };
  });

  const providers = configured.map((cfg) =>
    providerRow(cfg, { saved: saved.has(cfg.id), quotaCooldowns })
  );

  return json({ catalog, providers });
}

function isValidModelList(models: unknown, max = 500): models is string[] {
  if (!Array.isArray(models)) return false;
  if (models.length === 0 || models.length > max) return false;
  return models.every(
    (m) => typeof m === "string" && m.trim().length > 0 && m.length <= 200
  );
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

function parseHeaders(input: unknown): Record<string, string> | undefined | null {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== "string" || value.length > 4_096) {
      return null;
    }
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseCapabilities(input: unknown): Record<string, ModelCapabilities> | undefined | null {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, ModelCapabilities> = {};
  for (const [model, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!model.trim() || model.length > 200) return null;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const caps = raw as Record<string, unknown>;
    if (
      typeof caps.vision !== "boolean" ||
      typeof caps.tools !== "boolean" ||
      typeof caps.computerUse !== "boolean"
    ) {
      return null;
    }
    const contextWindow =
      typeof caps.contextWindow === "number" && Number.isFinite(caps.contextWindow) && caps.contextWindow > 0
        ? Math.floor(caps.contextWindow)
        : undefined;
    out[model] = {
      vision: caps.vision,
      tools: caps.tools,
      computerUse: caps.computerUse,
      ...(contextWindow ? { contextWindow } : {}),
      source: "override",
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isValidKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

/** Save a provider keyed by id into the caller's account. Returns only a masked summary. */
export async function POST(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_PROVIDER_BODY_BYTES);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Body must be an object." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  if (typeof input.id !== "string") {
    return json({ error: "id is required." }, { status: 400 });
  }
  const id = canonicalProviderId(input.id);
  if (!id || id.length > 64) {
    return json({ error: "id must be a slug (a-z, 0-9, dashes)." }, { status: 400 });
  }

  const apiStyleRaw = input.apiStyle;
  let apiStyle = apiStyleRaw;
  // Legacy aliases: both meant "OpenAI chat completions".
  if (apiStyleRaw === "openai-compatible" || apiStyleRaw === "custom") apiStyle = "openai-chat";
  if (apiStyle !== undefined && !isApiStyle(apiStyle)) {
    return json(
      {
        error:
          "apiStyle must be one of openai-chat, openai-responses, anthropic, gemini, ollama.",
      },
      { status: 400 }
    );
  }
  const auth = parseAuth(input.auth);
  if (auth === null) {
    return json(
      { error: "auth.scheme must be none, bearer, x-api-key, x-goog-api-key, custom-header or basic." },
      { status: 400 }
    );
  }
  const headers = parseHeaders(input.headers);
  if (headers === null) {
    return json({ error: "headers must be an object of safe header names and string values." }, { status: 400 });
  }
  const modelCapabilities = parseCapabilities(input.modelCapabilities);
  if (modelCapabilities === null) {
    return json(
      { error: "modelCapabilities must map model ids to {vision, tools, computerUse} booleans." },
      { status: 400 }
    );
  }

  const baseUrl = input.baseUrl === undefined ? undefined : String(input.baseUrl).trim();
  if (baseUrl !== undefined && baseUrl !== "") {
    const safe = await assertResolvableProviderBaseUrl(baseUrl);
    if (!safe.ok) {
      return json({ error: safe.error }, { status: 400 });
    }
  }

  const models = input.models === undefined ? undefined : input.models;
  if (models !== undefined && !isValidModelList(models, 50)) {
    return json(
      { error: "models must be an array of 1-50 non-empty model id strings." },
      { status: 400 }
    );
  }
  const availableModels = input.availableModels === undefined ? undefined : input.availableModels;
  if (availableModels !== undefined && !isValidModelList(availableModels, 500)) {
    return json(
      { error: "availableModels must be an array of 1-500 non-empty model id strings." },
      { status: 400 }
    );
  }

  const rank = input.rank === undefined ? undefined : input.rank;
  if (
    rank !== undefined &&
    (typeof rank !== "number" || !Number.isFinite(rank) || rank < 0)
  ) {
    return json(
      { error: "Rank must be a number greater than or equal to 0." },
      { status: 400 }
    );
  }

  const apiKey = input.apiKey === undefined ? undefined : String(input.apiKey);
  if (apiKey !== undefined && apiKey !== "" && !isValidKey(apiKey)) {
    return json({ error: "API key must be 1-512 printable characters." }, { status: 400 });
  }
  // A missing key is allowed on edit (the saved keys are preserved) and for
  // providers whose auth scheme is "none" or that run locally (Ollama/BYOC).
  // saveProvider enforces the requirement for brand-new keyed providers.

  const isFree = input.isFree;
  if (isFree !== undefined && typeof isFree !== "boolean") {
    return json({ error: "isFree must be a boolean." }, { status: 400 });
  }
  const inputPrice = input.inputPricePer1mTokens;
  const outputPrice = input.outputPricePer1mTokens;
  const validPrice = (v: unknown): v is number =>
    v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (!validPrice(inputPrice) || !validPrice(outputPrice)) {
    return json(
      { error: "inputPricePer1mTokens/outputPricePer1mTokens must be non-negative numbers." },
      { status: 400 }
    );
  }
  // Perplexity Agent API effort level. Undefined keeps the saved value on
  // edit; null clears it. saveProvider enforces Perplexity-only.
  const effort = input.effort;
  if (effort !== undefined && effort !== null && !isPerplexityEffort(effort)) {
    return json(
      { error: "effort must be one of fast, low, medium, high, xhigh (or null to clear)." },
      { status: 400 }
    );
  }

  try {
    const { config } = saveProvider(owner, {
      id,
      apiStyle,
      auth,
      baseUrl: baseUrl || undefined,
      models: models as string[] | undefined,
      availableModels: availableModels as string[] | undefined,
      modelCapabilities,
      headers,
      apiKey,
      rank: rank as number | undefined,
      isFree,
      inputPricePer1mTokens: inputPrice,
      outputPricePer1mTokens: outputPrice,
      effort: effort as PerplexityEffort | null | undefined,
    });
    const row = providerRow(config, { saved: true });
    recordAudit({ user: owner, action: "provider.add", target: id, result: "success" });
    return json({ ok: true, provider: row }, { status: 201 });
  } catch (err) {
    if (err instanceof ProviderMutationError) {
      return json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[providers] failed to save provider "${id}": ${message}`);
    recordAudit({ user: owner, action: "provider.add", target: id, result: "failure" });
    return json({ error: "Could not save provider configuration." }, { status: 500 });
  }
}

/**
 * Add, remove or rotate a single key of a provider. The provider id travels
 * in the body so the collection route can answer the same mutations as
 * `PATCH /api/providers/[id]`.
 *
 * Body: {id, action:"add-key", apiKey} | {id, action:"remove-key", index}
 *      | {id, action:"rotate-key", index, apiKey}
 */
export async function PATCH(request: Request) {
  const owner = providerOwner(request);
  if (!owner) return unauthorized();
  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_PROVIDER_BODY_BYTES);
  } catch (err) {
    if (err instanceof JsonBodyError) {
      return json({ error: err.message }, { status: err.status });
    }
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const rawId = (body as Record<string, unknown>).id;
  if (typeof rawId !== "string" || rawId.trim() === "") {
    return json({ error: "id is required." }, { status: 400 });
  }
  const id = canonicalProviderId(rawId);
  if (!id) {
    return json({ error: "id must be a slug (a-z, 0-9, dashes)." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  // Endpoint/model/capability edits share this route with key mutations so the
  // settings drawer has one save path. They never accept or return key values.
  if (
    input.action === "set-endpoint" ||
    input.action === "set-models" ||
    input.action === "set-capabilities"
  ) {
    const apiStyleRaw = input.apiStyle;
    let apiStyle = apiStyleRaw;
    // Same legacy aliases as POST /api/providers: both meant OpenAI chat completions.
    if (apiStyleRaw === "openai-compatible" || apiStyleRaw === "custom") apiStyle = "openai-chat";
    if (apiStyle !== undefined && !isApiStyle(apiStyle)) {
      return json({ error: "Unsupported API style." }, { status: 400 });
    }
    const auth = parseAuth(input.auth);
    if (auth === null) {
      return json({ error: "Invalid auth configuration." }, { status: 400 });
    }
    const headers = parseHeaders(input.headers);
    if (headers === null) {
      return json({ error: "Invalid static headers." }, { status: 400 });
    }
    const modelCapabilities = parseCapabilities(input.modelCapabilities);
    if (modelCapabilities === null) {
      return json({ error: "Invalid capability overrides." }, { status: 400 });
    }
    const baseUrl = input.baseUrl === undefined ? undefined : String(input.baseUrl).trim();
    if (baseUrl !== undefined && baseUrl !== "") {
      const safe = await assertResolvableProviderBaseUrl(baseUrl);
      if (!safe.ok) return json({ error: safe.error }, { status: 400 });
    }
    const models = input.models === undefined ? undefined : input.models;
    if (models !== undefined && !isValidModelList(models, 50)) {
      return json({ error: "models must be an array of 1-50 model ids." }, { status: 400 });
    }
    const availableModels = input.availableModels === undefined ? undefined : input.availableModels;
    if (availableModels !== undefined && !isValidModelList(availableModels, 500)) {
      return json({ error: "availableModels must be an array of 1-500 model ids." }, { status: 400 });
    }
    const effort = input.effort;
    if (effort !== undefined && effort !== null && !isPerplexityEffort(effort)) {
      return json({ error: "effort must be one of fast, low, medium, high, xhigh (or null to clear)." }, { status: 400 });
    }
    try {
      const { config } = updateProviderSettings(owner, id, {
        ...(apiStyle !== undefined ? { apiStyle } : {}),
        ...(auth !== undefined ? { auth } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(models !== undefined ? { models: models as string[] } : {}),
        ...(availableModels !== undefined ? { availableModels: availableModels as string[] } : {}),
        ...(modelCapabilities !== undefined ? { modelCapabilities } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(effort !== undefined ? { effort: effort as PerplexityEffort | null } : {}),
      });
      return json(
        { ok: true, provider: providerRow(config, { saved: true }) },
      );
    } catch (err) {
      if (err instanceof ProviderMutationError) {
        return json({ error: err.message }, { status: err.status });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[providers] failed to update provider "${id}": ${message}`);
      return json({ error: "Could not update provider configuration." }, { status: 500 });
    }
  }

  const { status, body: payload } = runKeyMutation(owner, id, body);
  return json(payload, { status });
}
