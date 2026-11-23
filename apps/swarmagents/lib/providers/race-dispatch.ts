/**
 * Provider race dispatch: wires the race engine (race.ts) into the LLM
 * gateway (lib/runtime/llm-gateway.ts).
 *
 * The engine races up to N keys of ONE provider and takes the first VALID
 * response. This module races across providers: one engine run per
 * candidate provider (each racing that provider's keys), all fired
 * concurrently, first valid response wins, losers are aborted. The gateway
 * calls in only when the user's settings enable racing AND the request is
 * a simple text completion (see extractRacePrompt); every other request —
 * and every racing failure — keeps the sequential path byte-identical.
 *
 * Keys: the engine drives a Router built from the signed-in user's own
 * provider config (user-run-pool.ts, hostEnvKeys: false). Host env keys
 * (SWARM_KEYS_*) are never used for signed-in users, and no key value ever
 * reaches telemetry — attempts carry provider/model/latency/outcome only.
 *
 * Budget: racing multiplies spend, so the gateway runs its per-run budget
 * gate before dispatching and this module reports every settled attempt's
 * estimated cost through the injected noteSpend hook (the winner's usage
 * is reported by the provider; aborted losers report no usage, so their
 * spend — if the provider bills a cancelled call — is uncounted, the same
 * blind spot the sequential path has for client-aborted calls).
 */

import { randomUUID } from "node:crypto";
import { ProviderRaceEngine, type RaceResult, type RaceRouter } from "./race";
import { userPoolRouter } from "./user-run-pool";
import { estimateCostUsd } from "./pricing";
import type { UserSettings } from "./settings";
import type { FetchLike, ProviderConfig, ProviderErrorKind, TokenUsage } from "./types";

/** Resolved race settings with defaults applied. */
export interface RaceDispatchConfig {
  /** Providers raced concurrently (1..8). */
  maxParallel: number;
  /** Keys raced per provider (1..5). */
  keysPerProvider: number;
}

export const DEFAULT_RACE_MAX_PARALLEL = 3;
export const DEFAULT_RACE_KEYS_PER_PROVIDER = 2;
export const MAX_RACE_PARALLEL = 8;
export const MAX_RACE_KEYS_PER_PROVIDER = 5;

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < min || n > max) return undefined;
  return n;
}

/**
 * The user's race configuration, or null when racing is off (the default).
 * Malformed values fall back to the defaults rather than disabling racing
 * the user explicitly turned on.
 */
export function raceConfigFromSettings(settings: UserSettings): RaceDispatchConfig | null {
  const race = settings.race;
  if (!race || race.enabled !== true) return null;
  return {
    maxParallel: clampInt(race.maxParallel, 1, MAX_RACE_PARALLEL) ?? DEFAULT_RACE_MAX_PARALLEL,
    keysPerProvider:
      clampInt(race.keysPerProvider, 1, MAX_RACE_KEYS_PER_PROVIDER) ?? DEFAULT_RACE_KEYS_PER_PROVIDER,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of one message's content, or null when it carries anything but text. */
function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
    parts.push(block.text);
  }
  return parts.join("");
}

/**
 * The prompt to race for an Anthropic-shaped request body, or null when
 * the request is not race-eligible. Eligible: non-streaming, no tools,
 * every message text-only, system absent or a plain string. Tool loops
 * (Claude Code traffic) are never eligible — the engine sends one text
 * completion, so racing them would change what the model sees.
 *
 * A single user message is raced verbatim. Multi-turn histories are
 * flattened (system first, then `role: text` lines) — lossy, but the
 * race exists for latency on text completions, and the sequential path
 * remains available by leaving racing off.
 */
export function extractRacePrompt(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (body.stream === true) return null;
  if (Array.isArray(body.tools) && body.tools.length > 0) return null;
  if (body.system !== undefined && typeof body.system !== "string") return null;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const turns: { role: string; text: string }[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) return null;
    if (raw.role !== "user" && raw.role !== "assistant") return null;
    const text = messageText(raw.content);
    if (text === null) return null;
    turns.push({ role: raw.role, text });
  }

  const system = typeof body.system === "string" ? body.system.trim() : "";
  if (turns.length === 1 && turns[0]!.role === "user") {
    return system ? `${system}\n\n${turns[0]!.text}` : turns[0]!.text;
  }
  const lines = turns.map((t) => `${t.role}: ${t.text}`);
  return system ? `${system}\n\n${lines.join("\n\n")}` : lines.join("\n\n");
}

/** max_tokens from a request body, when it is a usable positive number. */
export function raceMaxTokens(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const value = body.max_tokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** One provider the race may use, in priority order (gateway-ordered). */
export interface RaceCandidate {
  config: ProviderConfig;
  model: string;
}

/**
 * Telemetry payload for one raced attempt. Structurally the gateway's
 * llm.call event data (lib/runtime/llm-gateway.ts LlmCallEvent); kept
 * local so this module has no runtime dependency on the gateway.
 */
export interface RaceCallEventData {
  provider: string;
  model: string;
  attempt: number;
  outcome: string;
  status?: number;
  errorKind?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number | null;
  queuedMs?: number;
  ttftMs?: number;
}

/** One settled race attempt (gateway LlmAttempt shape). */
export interface RaceAttempt {
  provider: string;
  model: string;
  ok: boolean;
  status?: number;
  kind?: ProviderErrorKind;
  error?: string;
  latencyMs: number;
}

export interface RaceCompletionOptions {
  owner: string;
  prompt: string;
  /** Ordered candidates (the gateway's orderLlmCandidates output). */
  candidates: RaceCandidate[];
  config: RaceDispatchConfig;
  /** False excludes paid providers, mirroring the router policy. */
  allowPaid?: boolean;
  maxTokens?: number;
  /** Estimated input tokens, for usage/cost reporting. */
  inputTokens?: number;
  /** Attempt number of the first raced attempt (1-based). */
  attemptBase?: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
  now?: () => number;
  emit?: (data: RaceCallEventData) => void;
  noteSpend?: (usd: number) => void;
  /** Injectable for tests; defaults to the per-user pool router. */
  routerFactory?: (owner: string) => RaceRouter;
}

export interface RaceCompletionResult {
  /** Anthropic-shaped non-streaming message body. */
  body: unknown;
  usage: TokenUsage;
  attempts: RaceAttempt[];
  winner: RaceResult;
}

function anthropicTextBody(result: RaceResult, usage: TokenUsage): unknown {
  return {
    id: `msg_race_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: result.model,
    content: [{ type: "text", text: result.text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Race the top `config.maxParallel` candidate providers concurrently and
 * return the first valid completion. Rejects when every candidate fails
 * (or the caller's signal aborts) so the gateway can fall back to its
 * sequential path.
 */
export async function raceCompletion(options: RaceCompletionOptions): Promise<RaceCompletionResult> {
  const now = options.now ?? Date.now;
  const allowPaid = options.allowPaid !== false;
  const eligible = options.candidates.filter(
    (c) => c.config.enabled !== false && (allowPaid || c.config.isFree === true),
  );
  const selected = eligible.slice(0, options.config.maxParallel);
  if (selected.length === 0) {
    throw new Error("race: no eligible providers");
  }

  const router = (options.routerFactory ?? ((owner: string) => userPoolRouter(owner)))(options.owner);
  const engine = new ProviderRaceEngine({
    router,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
  });

  const attemptBase = options.attemptBase ?? 1;
  const attempts: RaceAttempt[] = new Array<RaceAttempt>(selected.length);
  const raceController = new AbortController();
  const outerSignal = options.signal;
  const onOuterAbort = () => raceController.abort();
  if (outerSignal) {
    if (outerSignal.aborted) raceController.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let winner: RaceResult | null = null;
  const startedAt = now();

  try {
    await Promise.allSettled(
      selected.map(async (candidate, index) => {
        const { config, model } = candidate;
        const attempt = attemptBase + index;
        const t0 = now();
        try {
          const result = await engine.complete({
            prompt: options.prompt,
            provider: config.id,
            candidates: options.config.keysPerProvider,
            model,
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            signal: raceController.signal,
          });
          const latencyMs = now() - t0;
          const isWinner = winner === null;
          if (isWinner) {
            winner = result;
            // First valid response wins: cancel every other provider.
            raceController.abort();
          }
          attempts[index] = { provider: config.id, model, ok: true, latencyMs };
          const usage: TokenUsage = {
            inputTokens: options.inputTokens ?? 0,
            outputTokens: result.tokens,
          };
          const cost = estimateCostUsd(config, model, usage) ?? null;
          if (cost !== null && cost > 0) options.noteSpend?.(cost);
          options.emit?.({
            provider: config.id,
            model,
            attempt,
            outcome: "ok",
            latencyMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: cost,
            queuedMs: Math.max(0, t0 - startedAt),
            ttftMs: latencyMs,
          });
          return result;
        } catch (err) {
          const latencyMs = now() - t0;
          const aborted = isAbortError(err) || raceController.signal.aborted;
          attempts[index] = {
            provider: config.id,
            model,
            ok: false,
            kind: aborted ? "aborted" : "unknown",
            ...(aborted ? {} : { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }),
            latencyMs,
          };
          options.emit?.({
            provider: config.id,
            model,
            attempt,
            outcome: aborted ? "aborted" : "error",
            errorKind: aborted ? "aborted" : "unknown",
            latencyMs,
            costUsd: null,
            queuedMs: Math.max(0, t0 - startedAt),
          });
          throw err;
        }
      }),
    );
  } finally {
    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
  }

  if (outerSignal?.aborted) {
    const reason = outerSignal.reason instanceof Error ? outerSignal.reason : new Error("Aborted");
    throw reason;
  }
  // Callback assignments to `winner` are invisible to control-flow analysis,
  // which keeps `winner` narrowed to null after Promise.allSettled. Cast
  // restores the union so the null check can narrow to RaceResult.
  const finalizedWinner = winner as RaceResult | null;
  if (!finalizedWinner) {
    const detail = attempts
      .filter((a): a is RaceAttempt => a !== undefined)
      .map((a) => `${a.provider}: ${a.error ?? a.kind ?? "failed"}`)
      .join("; ");
    throw new Error(`race: all ${selected.length} provider(s) failed: ${detail}`);
  }

  const usage: TokenUsage = {
    inputTokens: options.inputTokens ?? 0,
    outputTokens: finalizedWinner.tokens,
  };
  return {
    body: anthropicTextBody(finalizedWinner, usage),
    usage,
    attempts,
    winner: finalizedWinner,
  };
}
