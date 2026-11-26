/**
 * The long-term memory store.
 *
 * Facts live in the app's per-user data directory
 * (`<data dir>/users/<hash(userId)>/memory.json`), never inside the user's VM:
 * a VM reset, a fresh container or a redeploy leaves the memory untouched.
 *
 * Every function takes the owner's user id first, so a caller cannot reach
 * another account's memories by accident. Facts are redacted with the
 * harness' secret scanner before they are written, so an agent that is told
 * "my key is sk-..." never persists the key itself.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeRedactor } from "../harness/redact";
import { atomicWriteFile } from "../atomic-write";
import { providerDataDir, userDirName, type DataDirOptions } from "../providers/store";
import { cosineSimilarity, embedText, embedTextWithModel } from "./embeddings";
import {
  DEFAULT_SEARCH_K,
  MAX_FACTS,
  MAX_FACT_CHARS,
  MAX_INJECTED_MEMORIES,
  MAX_SEARCH_K,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MEMORY_FILE,
  MEMORY_SCHEMA_VERSION,
  type MemoryFact,
  type MemoryFile,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemoryWriteInput,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Scrub secret-shaped material out of a fact before it is persisted. The
 * redactor is the same one the harness uses for telemetry, so a key pasted
 * into the chat is masked here too.
 */
export function redactFactText(text: string, env: Record<string, string> = process.env as Record<string, string>): string {
  const redact = makeRedactor(env);
  return redact(text);
}

function clampText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, MAX_FACT_CHARS);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (!tag || tag.length > MAX_TAG_CHARS) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** The directory holding one account's memory file. */
export function userMemoryDir(userId: string, options: DataDirOptions = {}): string {
  return path.join(providerDataDir(options), "users", userDirName(userId));
}

/** The memory file of one account. */
export function userMemoryFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(userMemoryDir(userId, options), MEMORY_FILE);
}

function emptyFile(userId: string): MemoryFile {
  return { version: MEMORY_SCHEMA_VERSION, userId, facts: [] };
}

/**
 * Read one account's memory file. A missing, malformed or foreign-owned file
 * reads as empty — the owner check inside the file is what keeps one
 * account's file from being served to another.
 */
export function readMemoryFile(userId: string, options: DataDirOptions = {}): MemoryFile {
  const file = userMemoryFilePath(userId, options);
  try {
    if (!fs.existsSync(file)) return emptyFile(userId);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(raw)) return emptyFile(userId);
    if (raw.userId !== userId || !Array.isArray(raw.facts)) return emptyFile(userId);
    const facts: MemoryFact[] = [];
    for (const item of raw.facts) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === "string" ? item.id : null;
      const fact = typeof item.fact === "string" ? item.fact : null;
      if (!id || !fact) continue;
      const tags = normalizeTags(item.tags);
      const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
      const updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : createdAt;
      const embedding = Array.isArray(item.embedding)
        ? item.embedding.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        : undefined;
      const embeddingModel = typeof item.embeddingModel === "string" ? item.embeddingModel : undefined;
      facts.push({ id, fact, tags, embedding, embeddingModel, createdAt, updatedAt });
    }
    return { version: MEMORY_SCHEMA_VERSION, userId, facts };
  } catch {
    return emptyFile(userId);
  }
}

/** Atomically replace one account's memory file. */
export function writeMemoryFile(userId: string, data: MemoryFile, options: DataDirOptions = {}): string {
  const file = userMemoryFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: a read-only or foreign-owned mount keeps its mode.
  }
  const body: MemoryFile = { version: MEMORY_SCHEMA_VERSION, userId, facts: data.facts };
  atomicWriteFile(file, JSON.stringify(body, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
  return file;
}

/** Every memory of one account, newest first. */
export function listMemories(userId: string, options: DataDirOptions = {}): MemoryFact[] {
  return readMemoryFile(userId, options).facts.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One memory by id, or null. */
export function getMemory(userId: string, id: string, options: DataDirOptions = {}): MemoryFact | null {
  return readMemoryFile(userId, options).facts.find((f) => f.id === id) ?? null;
}

/** Drop every memory of one account. Returns how many were removed. */
export function clearMemories(userId: string, options: DataDirOptions = {}): number {
  const current = readMemoryFile(userId, options);
  const count = current.facts.length;
  if (count > 0) writeMemoryFile(userId, { ...current, facts: [] }, options);
  return count;
}

/** Drop one memory of one account. Returns false when the id is unknown. */
export function forgetMemory(userId: string, id: string, options: DataDirOptions = {}): boolean {
  const current = readMemoryFile(userId, options);
  const before = current.facts.length;
  const next = current.facts.filter((f) => f.id !== id);
  if (next.length === before) return false;
  writeMemoryFile(userId, { ...current, facts: next }, options);
  return true;
}

/**
 * Store a new fact for one account.
 *
 * The text is clamped, redacted and (when an embedder is available) embedded
 * before it is written. An existing fact with the same text and tags is
 * returned untouched instead of being stored twice.
 */
export async function writeMemory(
  userId: string,
  input: MemoryWriteInput,
  options: DataDirOptions = {},
): Promise<MemoryFact> {
  const fact = redactFactText(clampText(input.fact));
  if (!fact) throw new Error("fact is required");
  const tags = normalizeTags(input.tags);

  const store = readMemoryFile(userId, options);
  const duplicate = store.facts.find((f) => f.fact === fact && sameTags(f.tags, tags));
  if (duplicate) return duplicate;

  const now = Date.now();
  const memory: MemoryFact = { id: `mem_${randomUUID()}`, fact, tags, createdAt: now, updatedAt: now };

  const embedding = await embedText(userId, fact, options);
  if (embedding) {
    memory.embedding = embedding.vector;
    memory.embeddingModel = embedding.model;
  }

  store.facts.push(memory);
  // The account's memory is bounded: the oldest facts are dropped first.
  if (store.facts.length > MAX_FACTS) {
    store.facts.sort((a, b) => a.createdAt - b.createdAt);
    store.facts = store.facts.slice(store.facts.length - MAX_FACTS);
  }
  writeMemoryFile(userId, store, options);
  return memory;
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((tag) => setA.has(tag));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-:\s]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/** Classic BM25 over the fact texts (the always-available fallback). */
export function bm25Score(query: string, docs: Array<{ id: string; text: string }>): Map<string, number> {
  const qTerms = tokenize(query);
  const scores = new Map<string, number>();
  if (qTerms.length === 0) return scores;
  const tokenized = docs.map((d) => ({ id: d.id, terms: tokenize(d.text) }));
  const N = tokenized.length || 1;
  const avgdl = tokenized.reduce((s, d) => s + d.terms.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of new Set(qTerms)) {
    let c = 0;
    for (const d of tokenized) if (d.terms.includes(t)) c++;
    df.set(t, c);
  }
  for (const d of tokenized) {
    const tf = new Map<string, number>();
    for (const term of d.terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    const dl = d.terms.length || 1;
    for (const q of qTerms) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const k1 = 1.2;
      const b = 0.75;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl))));
    }
    if (score > 0) scores.set(d.id, score);
  }
  return scores;
}

/** The embedding model most facts of this account were stored with. */
function dominantModel(facts: readonly MemoryFact[]): string | undefined {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    if (!fact.embeddingModel || !fact.embedding?.length) continue;
    counts.set(fact.embeddingModel, (counts.get(fact.embeddingModel) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Find the memories most relevant to a query.
 *
 * Scoring is hybrid: the lexical BM25 score always runs, and when the account
 * has embedded facts the query is embedded with the same model so the
 * cosine similarity is added. With no embedder available the result is the
 * BM25 ranking alone.
 */
export async function searchMemories(
  userId: string,
  query: string,
  opts: MemorySearchOptions = {},
  dataOptions: DataDirOptions = {},
): Promise<MemorySearchResult[]> {
  const facts = listMemories(userId, dataOptions);
  const q = (query ?? "").trim();
  const k = Math.max(1, Math.min(opts.k ?? DEFAULT_SEARCH_K, MAX_SEARCH_K));
  const tag = opts.tag?.trim();
  const pool = tag ? facts.filter((f) => f.tags.includes(tag)) : facts;

  if (!q) {
    return pool.slice(0, k).map((f) => ({
      id: f.id,
      fact: f.fact,
      tags: f.tags,
      score: 0,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
  }

  const lexical = bm25Score(q, pool.map((f) => ({ id: f.id, text: `${f.fact}\n${f.tags.join(" ")}` })));
  const maxLexical = Math.max(0, ...lexical.values());

  const model = dominantModel(pool);
  let queryVector: number[] | null = null;
  if (model) {
    queryVector = await embedTextWithModel(userId, q, model, dataOptions);
  }

  const scored = pool.map((fact) => {
    const lex = lexical.get(fact.id) ?? 0;
    const lexNorm = maxLexical > 0 ? lex / maxLexical : 0;
    let cosine = 0;
    if (queryVector && fact.embedding?.length && fact.embeddingModel === model) {
      cosine = Math.max(0, cosineSimilarity(queryVector, fact.embedding));
    }
    const score = queryVector ? lexNorm * 0.5 + cosine * 0.5 : lexNorm;
    return { fact, score, lex, cosine };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt)
    .slice(0, k)
    .map((entry) => ({
      id: entry.fact.id,
      fact: entry.fact.fact,
      tags: entry.fact.tags,
      score: Number(entry.score.toFixed(6)),
      createdAt: entry.fact.createdAt,
      updatedAt: entry.fact.updatedAt,
    }));
}

// ---------------------------------------------------------------------------
// Injection into a run
// ---------------------------------------------------------------------------

/** A rough token estimate (4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const AUTO_MEMORY_TOKEN_BUDGET = 300;

/**
 * Render the memories as the block that is injected into a run's system
 * prompt. The block never exceeds the token budget: facts that would blow it
 * are dropped.
 */
export function formatMemoriesForInjection(
  memories: MemorySearchResult[],
  budgetTokens = 1000,
): string {
  return formatMemoriesWithStats(memories, budgetTokens).text;
}

function formatMemoriesWithStats(
  memories: MemorySearchResult[],
  budgetTokens = 1000,
): { text: string; count: number; tokens: number } {
  if (memories.length === 0) return { text: "", count: 0, tokens: 0 };
  const header = "Long-term memory for this account (stored outside the VM; it survives VM resets):";
  const lines: string[] = [header];
  let used = estimateTokens(header);
  let count = 0;
  for (const memory of memories.slice(0, MAX_INJECTED_MEMORIES)) {
    const tags = memory.tags.length ? ` [${memory.tags.join(", ")}]` : "";
    const line = `- ${memory.fact}${tags}`;
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) break;
    lines.push(line);
    used += cost;
    count += 1;
  }
  if (lines.length === 1) return { text: "", count: 0, tokens: 0 };
  const text = lines.join("\n");
  return { text, count, tokens: estimateTokens(text) };
}

/**
 * Recall top-K memories for a prompt within `budgetTokens` (default 300) and
 * return both the rendered text and safe count/token metadata for telemetry.
 */
export async function memoryRecallForPrompt(
  userId: string,
  prompt: string,
  options: DataDirOptions & { budgetTokens?: number } = {},
): Promise<{ text: string; count: number; tokens: number }> {
  try {
    let hits = await searchMemories(
      userId,
      prompt,
      { k: MAX_INJECTED_MEMORIES },
      options,
    );
    // A prompt can be completely unrelated to what the account remembered
    // ("which package manager?" vs "I prefer pnpm") and share no keyword with
    // it, so a keyword search comes back empty. In that case the newest facts
    // are the best context we have: inject them anyway, still capped at five.
    if (hits.length === 0) {
      hits = listMemories(userId, options)
        .slice(0, MAX_INJECTED_MEMORIES)
        .map((fact) => ({
          id: fact.id,
          fact: fact.fact,
          tags: fact.tags,
          score: 0,
          createdAt: fact.createdAt,
          updatedAt: fact.updatedAt,
        }));
    }
    return formatMemoriesWithStats(hits, options.budgetTokens ?? 1000);
  } catch {
    return { text: "", count: 0, tokens: 0 };
  }
}

/**
 * The memory block for one run: the most relevant memories of the account,
 * ranked against the prompt and capped at the injection budget.
 */
export async function memoryContextForPrompt(
  userId: string,
  prompt: string,
  options: DataDirOptions & { budgetTokens?: number } = {},
): Promise<string> {
  const recalled = await memoryRecallForPrompt(userId, prompt, options);
  return recalled.text;
}
