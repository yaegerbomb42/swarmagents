/**
 * Embeddings for long-term memory.
 *
 * The chain is: the account's own router provider first (an OpenAI-compatible
 * provider that already has a key — no new credentials, no new host), then a
 * local MiniLM model through transformers.js when that optional package is
 * installed and explicitly enabled, and finally nothing at all — the store
 * then falls back to lexical (BM25) scoring.
 *
 * The embedder that produced a vector is recorded with the fact
 * ("openai:text-embedding-3-small", "minilm:Xenova/all-MiniLM-L6-v2") so a
 * query can be embedded with the very same model before the vectors are
 * compared.
 */

import { serverMode } from "../auth";
import { catalogEntry } from "../providers/catalog";
import { routerProviders, type DataDirOptions } from "../providers/store";
import type { ProviderConfig } from "../providers/types";

/** The optional local model used when no provider embedding is available. */
export const MINILM_MODEL = "Xenova/all-MiniLM-L6-v2";
/** Prefix of a MiniLM-produced model id. */
export const MINILM_MODEL_PREFIX = "minilm:";
/** Env switch: the local MiniLM embedder is off unless this is "1". */
export const MINILM_ENV = "SWARM_MEMORY_MINILM";
/** Request timeout for a provider embedding call. */
export const EMBED_TIMEOUT_MS = 3_000;
/** Total budget for one embedding call across all candidates. */
export const EMBED_BUDGET_MS = 6_000;

export interface EmbeddingResult {
  vector: number[];
  /** "<providerId>:<model>" or "minilm:<model>". */
  model: string;
}

interface EmbeddingCandidate {
  /** Provider id (or "env" for the explicit endpoint override). */
  id: string;
  /** Embedding model to request. */
  model: string;
  /** Full embeddings endpoint. */
  url: string;
  /** Bearer key, when the endpoint needs one. */
  apiKey?: string;
}

function envFlag(name: string): boolean {
  return (process.env[name] ?? "").trim() === "1";
}

/** The embedding model to ask a provider for. */
function embeddingModelFor(providerId: string): string {
  const override = (process.env.SWARM_EMBEDDING_MODEL ?? "").trim();
  if (override) return override;
  switch (providerId) {
    case "ollama":
      return "nomic-embed-text";
    case "lmstudio":
      return "text-embedding-nomic-embed-text-v1.5";
    case "together":
      return "togethercomputer/m2-bert-80M-8k-retrieval";
    case "fireworks":
      return "nomic-ai/nomic-embed-text-v1.5";
    default:
      return "text-embedding-3-small";
  }
}

/** The first usable key for a provider (saved key first, then its env var). */
function providerKey(provider: ProviderConfig): string {
  const saved = (provider.keys ?? []).map((k) => k.trim()).filter(Boolean);
  if (saved.length > 0) return saved[0];
  const envName =
    provider.envKeys ??
    `SWARM_KEYS_${provider.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const raw = process.env[envName];
  if (!raw) return "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)[0] ?? "";
}

/** Every provider that could serve an embedding, best candidate first. */
export function embeddingCandidates(
  userId: string,
  options: DataDirOptions = {},
): EmbeddingCandidate[] {
  const out: EmbeddingCandidate[] = [];

  // An explicit endpoint wins: it is how a deployment points the store at a
  // dedicated embedding service without touching the provider config.
  const envUrl = (process.env.SWARM_EMBEDDING_URL ?? "").trim();
  if (envUrl) {
    out.push({
      id: "env",
      model: (process.env.SWARM_EMBEDDING_MODEL ?? "").trim() || "text-embedding-3-small",
      url: envUrl,
      apiKey: (process.env.SWARM_EMBEDDING_API_KEY ?? "").trim() || undefined,
    });
  }

  let providers: ProviderConfig[] = [];
  try {
    providers = routerProviders(userId, { ...options, hostEnvKeys: !serverMode() });
  } catch {
    providers = [];
  }

  for (const provider of providers) {
    if (provider.kind !== "openai") continue; // only OpenAI-compatible APIs expose /embeddings
    if (provider.enabled === false) continue;
    const base = (provider.baseUrl ?? catalogEntry(provider.id)?.baseUrl ?? "").trim();
    if (!base) continue;
    const key = providerKey(provider);
    const local = catalogEntry(provider.id)?.isLocal === true;
    if (!key && !local) continue;
    out.push({
      id: provider.id,
      model: embeddingModelFor(provider.id),
      url: `${base.replace(/\/+$/, "")}/embeddings`,
      apiKey: key || undefined,
    });
  }

  return out;
}

async function embedWithCandidate(
  candidate: EmbeddingCandidate,
  text: string,
  timeoutMs = EMBED_TIMEOUT_MS,
): Promise<EmbeddingResult | null> {
  try {
    const res = await fetch(candidate.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(candidate.apiKey ? { authorization: `Bearer ${candidate.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: candidate.model, input: text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ embedding?: unknown }> };
    const raw = body?.data?.[0]?.embedding;
    if (!Array.isArray(raw)) return null;
    const vector = raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (vector.length === 0) return null;
    return { vector, model: `${candidate.id}:${candidate.model}` };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local MiniLM (optional, transformers.js)
// ---------------------------------------------------------------------------

type MiniLMOutput = { data?: ArrayLike<number>; tolist?: () => number[][] };

interface TransformersModule {
  pipeline?: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<(input: string, options?: Record<string, unknown>) => Promise<MiniLMOutput>>;
}

let miniLMPipeline: Promise<((input: string, options?: Record<string, unknown>) => Promise<MiniLMOutput>) | null> | null =
  null;

/**
 * Load an optional package at runtime.
 *
 * The specifier is hidden from the bundler on purpose: `@huggingface/transformers`
 * is an optional extra, and a static import would break the build for every
 * deployment that does not install it. Node resolves the specifier from the
 * running bundle's own directory (the app root), so an installed copy is
 * found and a missing one raises ERR_MODULE_NOT_FOUND, which the caller
 * turns into "no local embedder".
 */
const loadOptionalModule = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<Record<string, unknown>>;

/**
 * Mean-pool a token-embedding matrix into one vector and L2-normalize it.
 * Exported so the pooling can be unit tested without the model.
 */
export function meanPoolAndNormalize(rows: number[][]): number[] {
  if (rows.length === 0) return [];
  const dims = rows[0]?.length ?? 0;
  if (dims === 0) return [];
  const pooled = new Array<number>(dims).fill(0);
  for (const row of rows) {
    for (let i = 0; i < dims; i++) pooled[i] += row[i] ?? 0;
  }
  for (let i = 0; i < dims; i++) pooled[i] /= rows.length;
  let norm = 0;
  for (const value of pooled) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return pooled;
  return pooled.map((value) => value / norm);
}

/**
 * Load the local MiniLM pipeline. The optional `@huggingface/transformers`
 * package is resolved at runtime (never bundled): when it is missing the
 * embedder simply reports "unavailable" and the store falls back to BM25.
 */
async function loadMiniLM(): Promise<
  ((input: string, options?: Record<string, unknown>) => Promise<MiniLMOutput>) | null
> {
  if (!miniLMPipeline) {
    miniLMPipeline = (async () => {
      try {
        const mod = (await loadOptionalModule("@huggingface/transformers")) as TransformersModule;
        if (typeof mod?.pipeline !== "function") return null;
        return await mod.pipeline("feature-extraction", MINILM_MODEL, { dtype: "q8" });
      } catch {
        return null;
      }
    })();
  }
  return miniLMPipeline;
}

/** Embed with the local MiniLM model, or null when it is unavailable. */
export async function embedWithMiniLM(text: string): Promise<EmbeddingResult | null> {
  if (!envFlag(MINILM_ENV)) return null;
  const extractor = await loadMiniLM();
  if (!extractor) return null;
  try {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const vector = Array.from(output?.data ?? []).map((n) => Number(n));
    if (vector.length === 0) return null;
    return { vector, model: `${MINILM_MODEL_PREFIX}${MINILM_MODEL}` };
  } catch {
    return null;
  }
}

/**
 * Embed text with the account's router provider, falling back to the local
 * MiniLM model. Returns null when neither is available.
 */
export async function embedText(
  userId: string,
  text: string,
  options: DataDirOptions = {},
): Promise<EmbeddingResult | null> {
  const clean = text.trim();
  if (!clean) return null;
  const deadline = Date.now() + EMBED_BUDGET_MS;
  for (const candidate of embeddingCandidates(userId, options)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await embedWithCandidate(candidate, clean, Math.min(EMBED_TIMEOUT_MS, remaining));
    if (result) return result;
  }
  return embedWithMiniLM(clean);
}

/**
 * Embed text with the model that produced the stored vectors, so the query
 * and the facts live in the same vector space. Returns null when that model
 * is no longer reachable (the caller then scores lexically).
 */
export async function embedTextWithModel(
  userId: string,
  text: string,
  model: string,
  options: DataDirOptions = {},
): Promise<number[] | null> {
  const clean = text.trim();
  if (!clean || !model) return null;

  if (model.startsWith(MINILM_MODEL_PREFIX)) {
    const result = await embedWithMiniLM(clean);
    return result && result.model === model ? result.vector : null;
  }

  const separator = model.indexOf(":");
  if (separator <= 0) return null;
  const providerId = model.slice(0, separator);
  const modelName = model.slice(separator + 1);
  const candidate = embeddingCandidates(userId, options).find((c) => c.id === providerId);
  if (!candidate) return null;
  const result = await embedWithCandidate({ ...candidate, model: modelName }, clean);
  return result ? result.vector : null;
}

/** Cosine similarity of two vectors (0 when either is empty). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const value = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}
