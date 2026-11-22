/**
 * Prefix-stable prompt assembly for prompt caching
 * (CacheAwarePromptBuilder).
 *
 * Provider prompt caches key on the prompt PREFIX: any byte that changes
 * early in the prompt busts the cache for everything after it. This
 * builder enforces a strict 4-zone immutable-to-mutable message layout
 * so the stable prefix stays byte-identical across turns:
 *
 *   Zone 0 (system)      frozen static prefix: core system instructions
 *                          + permanent primitive tool definitions. Must
 *                          NEVER contain timestamps, run/session ids or
 *                          live counters — validated on entry.
 *   Zone 1 (1st message) session-static prefix: repo skeleton / AST map
 *                          + active SPEC.md + mounted SKILL.md bodies.
 *                          Mutates only via mountSkill() or handoff().
 *   Zone 2 (trajectory)  append-only conversation history & tool calls.
 *   Zone 3 (last message) ephemeral volatile tail: budget telemetry
 *                          footer, working-tree diff summary, newly
 *                          discovered deferred tool schemas.
 *
 * On every build the SHA-256 hashes of Zone 0 and Zone 1 are computed.
 * A Zone 0 change mid-session emits a CACHE_BUST_WARNING (with the exact
 * byte-diff) in the returned warnings — the caller should log it as a
 * telemetry event. Zone 1 changes are tracked, not warned: they are
 * expected when a skill mounts or a phase hands off.
 *
 * Provider adapters: the builder returns a CompleteRequest that carries
 * CacheBreakpoints; adapters.ts applies them only where the wire format
 * supports explicit breakpoints (Anthropic `cache_control`), and strips
 * them cleanly everywhere else (OpenAI's prefix caching is automatic;
 * Gemini's is implicit) — so the same prompt still caches by prefix
 * stability on those providers.
 *
 * Repo mapping: builds on the existing gateway — adapters.ts
 * (buildRequest) and router.ts (complete/callProvider) — by assembling
 * the CompleteRequest those already send. It is not a parallel gateway
 * and the router's existing complete() path is untouched: callers that
 * want prefix stability opt in by building their request with this
 * class and passing it to the router as usual. Cache metrics
 * (recordUsage/getCacheMetrics) accumulate per builder instance, i.e.
 * per run; the run analytics object reads them via getCacheMetrics(),
 * and TokenUsage now also carries the per-call cache fields surfaced
 * by parseResponse.
 */

import { createHash } from "node:crypto";
import type {
  CacheBreakpoints,
  CompleteRequest,
  Message,
  ModelTier,
  TokenUsage,
} from "./types";

/** SHA-256 hex of a zone's exact bytes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Volatile content that must never appear in Zone 0. */
const ZONE0_FORBIDDEN: [RegExp, string][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, "timestamp"],
  [/\b\d{2}:\d{2}:\d{2}\b/, "clock time"],
  [/\b20\d\d-\d\d-\d\d\b/, "date"],
  [/\brun[-_ ]?id\b/i, "run id"],
  [/\bsession[-_ ]?id\b/i, "session id"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "UUID"],
  [/\bcurrent (step|turn)\b/i, "live step/turn counter"],
  [/\bstep \d+ of \d+\b/i, "step counter"],
];

/**
 * Reject Zone 0 text containing volatile content. Static numbered
 * instructions ("Step 1: read the file") are fine — they never change;
 * only live values (timestamps, ids, current counters) bust a cache.
 */
export function validateZone0(text: string): void {
  for (const [pattern, label] of ZONE0_FORBIDDEN) {
    const match = pattern.exec(text);
    if (match) {
      throw new Error(`Zone 0 must never contain ${label} (found ${JSON.stringify(match[0])})`);
    }
  }
}

/** Exact byte-diff between two Zone 0 texts: first differing byte + context. */
export function byteDiff(
  previous: string,
  current: string,
): { firstDiffByte: number; previousExcerpt: string; currentExcerpt: string } {
  const a = Buffer.from(previous, "utf8");
  const b = Buffer.from(current, "utf8");
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const start = Math.max(0, i - 40);
  const end = i + 80;
  return {
    firstDiffByte: i,
    previousExcerpt: previous.slice(start, end),
    currentExcerpt: current.slice(start, end),
  };
}

export interface CacheBustWarning {
  type: "CACHE_BUST_WARNING";
  zone: 0;
  previousHash: string;
  currentHash: string;
  /** Byte offset of the first differing byte. */
  firstDiffByte: number;
  /** Context around the first difference in the previous Zone 0. */
  previousExcerpt: string;
  /** Context around the first difference in the current Zone 0. */
  currentExcerpt: string;
}

export interface CacheMetrics {
  /** LLM calls recorded. */
  calls: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Input tokens billed at full price. */
  uncachedInputTokens: number;
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens: number;
  /** cached / (cached + uncached); 0 when no input tokens yet. */
  effectiveCacheHitRate: number;
}

export interface CacheAwarePromptBuilderOptions {
  /** Zone 0: core system instructions + permanent primitive tool definitions. */
  zone0: string;
  /** Zone 1: repo skeleton / AST map + active SPEC.md + mounted SKILL.md bodies. */
  zone1: string;
}

export interface CacheAwareBuildInput {
  /** Zone 2: append-only trajectory (verified history + tool calls). */
  trajectory: Message[];
  /** Zone 3: budget telemetry footer, diff summary, deferred tool schemas. */
  zone3: string;
  /**
   * Rebuilt Zone 0 for this turn. Normally omitted (the constructor's
   * Zone 0 is reused); passing a different one is a mid-session Zone 0
   * mutation and produces a CACHE_BUST_WARNING.
   */
  zone0?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  tier?: ModelTier;
}

export interface BuiltPrompt {
  /** system = Zone 0, messages = [Zone 1, ...trajectory, Zone 3]. */
  request: CompleteRequest;
  zoneHashes: { zone0: string; zone1: string };
  warnings: CacheBustWarning[];
}

export class CacheAwarePromptBuilder {
  private readonly zone0Text: string;
  private zone1Text: string;
  private zone0Hash: string | undefined;
  private zone1Hash: string | undefined;
  private readonly metrics = {
    calls: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheWriteTokens: 0,
  };

  constructor(options: CacheAwarePromptBuilderOptions) {
    validateZone0(options.zone0);
    this.zone0Text = options.zone0;
    this.zone1Text = options.zone1;
  }

  /** Mount a skill: the only sanctioned Zone 1 mutation besides a handoff. */
  mountSkill(skillBody: string): void {
    const body = skillBody.trim();
    if (!body) return;
    this.zone1Text = this.zone1Text.trim() ? `${this.zone1Text}\n\n${body}` : body;
  }

  /** Phase handoff: replace the session-static Zone 1 (SPEC.md / skeleton change). */
  handoff(zone1: string): void {
    this.zone1Text = zone1;
  }

  build(input: CacheAwareBuildInput): BuiltPrompt {
    const zone0 = input.zone0 ?? this.zone0Text;
    if (input.zone0 !== undefined) validateZone0(input.zone0);
    const zone0Hash = sha256Hex(zone0);
    const zone1Hash = sha256Hex(this.zone1Text);
    const warnings: CacheBustWarning[] = [];
    if (this.zone0Hash !== undefined && this.zone0Hash !== zone0Hash) {
      const diff = byteDiff(this.zone0Text, zone0);
      warnings.push({
        type: "CACHE_BUST_WARNING",
        zone: 0,
        previousHash: this.zone0Hash,
        currentHash: zone0Hash,
        firstDiffByte: diff.firstDiffByte,
        previousExcerpt: diff.previousExcerpt,
        currentExcerpt: diff.currentExcerpt,
      });
    }
    if (this.zone0Hash === undefined) {
      this.zone0Hash = zone0Hash;
      this.zone1Hash = zone1Hash;
    } else {
      this.zone1Hash = zone1Hash;
    }

    const hasZone0 = zone0.trim().length > 0;
    const hasZone1 = this.zone1Text.trim().length > 0;
    const messages: Message[] = [];
    if (hasZone1) messages.push({ role: "user", content: this.zone1Text });
    messages.push(...input.trajectory);
    if (input.zone3.trim()) messages.push({ role: "user", content: input.zone3 });

    const breakpoints: CacheBreakpoints = {
      ...(hasZone0 ? { system: true } : {}),
      ...(hasZone1 ? { firstMessage: true } : {}),
      // Second-to-last is a real trajectory turn only when at least
      // three messages exist (otherwise it would be Zone 1 itself).
      ...(messages.length >= 3 ? { secondLastMessage: true } : {}),
    };
    const request: CompleteRequest = {
      messages,
      ...(hasZone0 ? { system: zone0 } : {}),
      cacheBreakpoints: breakpoints,
      ...(input.model ? { model: input.model } : {}),
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    };
    return { request, zoneHashes: { zone0: zone0Hash, zone1: zone1Hash }, warnings };
  }

  /** Fold one call's parsed usage into the run's cache metrics. */
  recordUsage(usage: TokenUsage): void {
    const cached = usage.cachedInputTokens ?? 0;
    this.metrics.calls++;
    this.metrics.cachedInputTokens += cached;
    this.metrics.uncachedInputTokens += Math.max(0, usage.inputTokens - cached);
    this.metrics.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  }

  /** Per-run cache metrics for the run analytics object. */
  getCacheMetrics(): CacheMetrics {
    const total = this.metrics.cachedInputTokens + this.metrics.uncachedInputTokens;
    return {
      ...this.metrics,
      effectiveCacheHitRate: total > 0 ? this.metrics.cachedInputTokens / total : 0,
    };
  }
}
