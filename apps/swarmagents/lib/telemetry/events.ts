/**
 * Shared, typed readers for persisted telemetry events.
 *
 * `usage.ts` (billing) and `cost-latency.ts` (latency) used to carry their own
 * copies of `isRecord`/`num`/`str`/`field` and had drifted on lens calls,
 * failed-call costs and run.paused. Both now read fields through this module so
 * the numbers can never disagree about what an event *says* — only about what
 * to do with it.
 *
 * Events may carry their payload at the top level (harness events) or under
 * `data` (gateway events); `field` accepts both.
 */

export interface TelemetryEventShape {
  type: string;
  ts: number;
  seq?: number;
  data?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite number, or undefined for everything else (never NaN/Infinity). */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Non-empty string, or undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read a field from the flat event first, then from its `data` payload. */
export function field(event: TelemetryEventShape, name: string): unknown {
  const flat = (event as unknown as Record<string, unknown>)[name];
  if (flat !== undefined) return flat;
  const data = isRecord(event.data) ? event.data : undefined;
  return data ? data[name] : undefined;
}

export interface RunCreatedFields {
  userId?: string;
  model?: string;
}

export function readRunCreated(event: TelemetryEventShape): RunCreatedFields {
  const data = isRecord(event.data) ? event.data : {};
  return { userId: str(data.userId), model: str(data.model) };
}

export interface RunStartedFields {
  model?: string;
  provider?: string;
}

export function readRunStarted(event: TelemetryEventShape): RunStartedFields {
  return { model: str(field(event, "model")), provider: str(field(event, "provider")) };
}

export interface RunFailoverFields {
  provider?: string;
  model?: string;
}

export function readRunFailover(event: TelemetryEventShape): RunFailoverFields {
  const data = isRecord(event.data) ? event.data : {};
  return {
    provider: str(field(event, "provider")) ?? str(data.provider),
    model: str(field(event, "model")) ?? str(data.model),
  };
}

export interface UsageFields {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  model?: string;
}

export function readUsage(event: TelemetryEventShape): UsageFields {
  return {
    tokensIn: num(field(event, "inputTokens")) ?? 0,
    tokensOut: num(field(event, "outputTokens")) ?? 0,
    tokensCached: num(field(event, "cachedTokens")) ?? 0,
    model: str(field(event, "model")),
  };
}

export interface LlmCallFields {
  provider?: string;
  model?: string;
  outcome?: string;
  attempt: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  queuedMs?: number;
  ttftMs?: number;
  /** Output lenses share the bus but are billed separately from agent calls. */
  isLens: boolean;
}

export function readLlmCall(event: TelemetryEventShape): LlmCallFields {
  const data = isRecord(event.data) ? event.data : {};
  return {
    provider: str(field(event, "provider")),
    model: str(field(event, "model")),
    outcome: str(field(event, "outcome")),
    attempt: num(field(event, "attempt")) ?? 1,
    costUsd: num(field(event, "costUsd")),
    inputTokens: num(field(event, "inputTokens")),
    outputTokens: num(field(event, "outputTokens")),
    latencyMs: num(field(event, "latencyMs")) ?? 0,
    queuedMs: num(field(event, "queuedMs")),
    ttftMs: num(field(event, "ttftMs")),
    isLens: data.source === "lens",
  };
}

export interface RunFinishedFields {
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export function readRunFinished(event: TelemetryEventShape): RunFinishedFields {
  return {
    costUsd: num(field(event, "costUsd")),
    durationMs: num(field(event, "durationMs")),
    numTurns: num(field(event, "numTurns")),
  };
}

/** Terminal run events; run.paused is included for SSE/replay purposes. */
export const TERMINAL_RUN_EVENTS: ReadonlySet<string> = new Set([
  "run.finished",
  "run.error",
  "run.cancelled",
  "run.paused",
]);

export function isTerminalRunEvent(type: string): boolean {
  return TERMINAL_RUN_EVENTS.has(type);
}
