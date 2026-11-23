/**
 * events.ts — the single shared event-normalization module for lib/telemetry/.
 *
 * usage.ts and cost-latency.ts used to carry their own copies of the same
 * isRecord/num/str/field helpers and their own event-folding switch blocks,
 * and the copies had already drifted apart:
 *
 *   - `num()`: usage.ts rejected negative numbers (absent); cost-latency.ts
 *     accepted them, so a negative inputTokens could drive the cost
 *     dashboard's token totals negative while the usage meter ignored it.
 *   - lens calls: usage.ts counted a lens cost only when the call succeeded
 *     (outcome === "ok"); cost-latency.ts added it unconditionally, so a
 *     failed lens call showed up in the cost dashboard but not the usage
 *     meter.
 *   - failed-call costs: usage.ts ignored a failed attempt's costUsd;
 *     cost-latency.ts clamped a negative cost to $0 and counted the attempt
 *     as priced.
 *   - `run.paused`: usage.ts tracked it as a run status; cost-latency.ts had
 *     no status concept at all, and efficiency()/diagnoseRun() had no pause
 *     concept, so a paused run's dead time read as model work.
 *   - `field()`: usage.ts kept an explicitly-undefined top-level field from
 *     falling back to the event's data payload; cost-latency.ts fell back.
 *     `run.failover` was read from data only in one module, either source
 *     in the other.
 *
 * The shared rules below are the agreement: one `num()` (finite,
 * non-negative, else absent), one `nonNegative()` (finite, clamped at zero,
 * for durations), one `field()` (a defined top-level value wins, otherwise
 * the data payload), and one typed reader per event shape. Both aggregators
 * read through them, so billing and latency metrics can never diverge again.
 * A negative value is corrupt telemetry, never a credit: counts and costs
 * treat it as absent, durations clamp to zero.
 *
 * Also in this module: `adaptSequencedEventsToRunEvents()`, the bridge from
 * persisted SequencedEvent logs to the flat RunEvent vocabulary
 * efficiency()/diagnoseRun() consume. The two vocabularies never matched —
 * efficiency() expects `turn`/`tool.call`/`loop.gates` events with a `tool`
 * field, while the bus writes `usage`/`tool.call`/`tool.result`/
 * `tool.blocked` events with a `name` field — so the diagnostics could
 * never run on a real log until now.
 *
 * Still carrying local copies of these helpers (follow-ups, not this PR):
 * lib/telemetry/run-token-accounting.ts (its `num` still accepts negatives,
 * its cost check still accepts negative costs), lib/runtime/run-summary.ts
 * and lib/runtime/run-report.ts (same isRecord/num/str/field trio).
 */

import type { SequencedEvent } from "./bus";
import type { RunEvent } from "./efficiency";

/**
 * Minimal shape a persisted telemetry event has for normalization: the
 * fields every reader needs. Both {@link SequencedEvent} (the durable log)
 * and the cost module's structural CostEvent satisfy it.
 */
export interface EventInput {
  /** Event type, e.g. "llm.call". */
  type: string;
  /** Epoch ms the event was recorded. */
  ts: number;
  /** Per-run sequence number, when the event carries one. */
  seq?: number;
  /** Gateway-style payload (llm.call, run.created, run.failover). */
  data?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Finite, non-negative number; anything else is absent. Counts, tokens, and
 * costs use this: a negative value is corrupt telemetry, not a credit.
 * (usage.ts semantics; cost-latency.ts used to accept negatives here.)
 */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Finite number clamped at zero; non-finite values are absent. Durations
 * and latencies use this: a negative duration is a clock bug, not a
 * negative wait. (cost-latency.ts semantics.)
 */
export function nonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

/** Non-empty string; anything else is absent. */
export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a field from an event. Harness events carry their fields at the top
 * level; gateway events (`llm.call`, `run.created`, `run.failover`) carry a
 * data payload. Read both: a defined top-level value wins, otherwise the
 * data payload's. (usage.ts used `name in event` here, which kept an
 * explicitly-undefined top-level field from falling back to data.)
 */
export function field(event: EventInput, name: string): unknown {
  const flat = (event as unknown as Record<string, unknown>)[name];
  if (flat !== undefined) return flat;
  const data = isRecord(event.data) ? event.data : {};
  return data[name];
}

/** Normalized `run.created`: the run's owner and starting model. */
export interface NormalizedRunCreated {
  userId?: string;
  model?: string;
}

export function readRunCreated(event: EventInput): NormalizedRunCreated {
  return {
    userId: str(field(event, "userId")),
    model: str(field(event, "model")),
  };
}

/** Normalized `run.started`: the model and provider the router selected. */
export interface NormalizedRunStarted {
  model?: string;
  provider?: string;
}

export function readRunStarted(event: EventInput): NormalizedRunStarted {
  return {
    model: str(field(event, "model")),
    provider: str(field(event, "provider")),
  };
}

/** Normalized `run.failover`: the provider/model of the attempt that failed over. */
export interface NormalizedRunFailover {
  provider?: string;
  model?: string;
}

export function readRunFailover(event: EventInput): NormalizedRunFailover {
  return {
    provider: str(field(event, "provider")),
    model: str(field(event, "model")),
  };
}

/** Normalized `usage`: one assistant message's token counts. */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model?: string;
}

export function readUsage(event: EventInput): NormalizedUsage {
  return {
    inputTokens: num(field(event, "inputTokens")) ?? 0,
    outputTokens: num(field(event, "outputTokens")) ?? 0,
    cachedTokens: num(field(event, "cachedTokens")) ?? 0,
    model: str(field(event, "model")),
  };
}

/**
 * Normalized `llm.call`: one provider attempt (see lib/runtime/llm-gateway.ts
 * LlmCallEvent and lib/lenses/run.ts for lens calls). `costUsd` is null when
 * no price is known — including a corrupt negative cost, which both
 * aggregators treat as unknown rather than a priced $0 call.
 */
export interface NormalizedLlmCall {
  provider?: string;
  model?: string;
  /** 1-based attempt number within the proxied request; 1 when absent. */
  attempt: number;
  /** "ok" or the failover reason (401/402/429/5xx/timeout, ...). */
  outcome: string;
  /** Total attempt duration, clamped at zero. */
  latencyMs: number;
  /** Milliseconds the attempt waited before the provider started serving it. */
  queuedMs?: number;
  /** Milliseconds to the first token. */
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Estimated USD for this attempt; null when no price is known. */
  costUsd: number | null;
  /** True when the provider reported the cost (vs an estimate). */
  costReported: boolean;
  /** "lens" for output-lens calls; absent for agent attempts. */
  source?: string;
  /** Lens id, for lens calls. */
  lens?: string;
}

export function readLlmCall(event: EventInput): NormalizedLlmCall {
  return {
    provider: str(field(event, "provider")),
    model: str(field(event, "model")),
    attempt: num(field(event, "attempt")) ?? 1,
    outcome: str(field(event, "outcome")) ?? "unknown",
    latencyMs: nonNegative(field(event, "latencyMs")) ?? 0,
    queuedMs: nonNegative(field(event, "queuedMs")),
    ttftMs: nonNegative(field(event, "ttftMs")),
    inputTokens: num(field(event, "inputTokens")),
    outputTokens: num(field(event, "outputTokens")),
    costUsd: num(field(event, "costUsd")) ?? null,
    costReported: field(event, "costReported") === true,
    source: str(field(event, "source")),
    lens: str(field(event, "lens")),
  };
}

/** Which terminal event ended the run. */
export type TerminalKind = "finished" | "error" | "cancelled";

/** Normalized terminal event (`run.finished` / `run.error` / `run.cancelled`). */
export interface NormalizedTerminalEvent {
  kind: TerminalKind;
  /** Final cost reported by the harness, when it reported one. */
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

/** Normalize a terminal event; undefined for any other event type. */
export function readTerminalEvent(event: EventInput): NormalizedTerminalEvent | undefined {
  switch (event.type) {
    case "run.finished":
      return {
        kind: "finished",
        costUsd: num(field(event, "costUsd")),
        durationMs: num(field(event, "durationMs")),
        numTurns: num(field(event, "numTurns")),
      };
    case "run.error":
      return { kind: "error" };
    case "run.cancelled":
      return { kind: "cancelled" };
    default:
      return undefined;
  }
}

function clipError(s: string, max = 500): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Bridge persisted SequencedEvent logs to the flat RunEvent vocabulary
 * efficiency() and diagnoseRun() consume.
 *
 * Mapping (grounded in the real publishers — lib/harness/runner.ts,
 * lib/runtime/llm-gateway.ts, lib/lenses/run.ts, lib/computers/remote.ts):
 *
 *   - `usage` → `turn`: one assistant message is one model call. Turn
 *     numbers are assigned sequentially in log order. Tokens split as
 *     `uncached = max(0, inputTokens - cachedTokens)` and
 *     `cacheRead = cachedTokens`: cachedTokens folds cache reads +
 *     creations (see usage.ts), so the read/write split is not recoverable;
 *     this preserves fresh + cached totals and the cache share.
 *   - `tool.call` → `tool.call`: the bus writes the tool name in `name`,
 *     the diagnostics read `tool`, so it is renamed. `input` passes through
 *     (record or JSON string) for the read-range analysis; `id` is kept so
 *     the matching result can annotate the call.
 *   - `tool.result` → annotates the matching `tool.call` in place
 *     (`isError` + `error` from the result's output, capped): a failed call
 *     is what edit-miss and denial detection read. A result for a call
 *     outside this log slice is dropped.
 *   - `tool.blocked` → `tool.denied`: the allowlist / risk gate refused the
 *     call before it ran, so there is no `tool.call` to annotate.
 *   - `llm.call` is dropped: provider attempts are not turns (a turn may
 *     retry across providers) and their cost/latency already live in the
 *     usage and cost-latency reports.
 *   - lifecycle events (`run.created`, `run.started`, `run.finished`, …)
 *     are dropped: they carry no turn/tool work. Wall time is first → last
 *     mapped event; pass `span` to efficiency() for the full run span.
 *
 * Turn durations: a `turn` event's `ms` is the gap since the previous event
 * of any kind, minus paused time — the model call that produced the usage
 * ended at the usage's ts and started after the previous event, so that gap
 * is the call, and efficiency() counts it as covered rather than idle. A
 * `run.paused` interval runs from its event to the next event and is never
 * covered, so a paused run's dead time reads as idle (the `idle` finding),
 * not as model work. The first turn has no previous event and covers
 * nothing.
 *
 * Honest limitations (the log does not carry these, so the adapter cannot
 * invent them):
 *
 *   - Tool calls carry no duration: a tool that runs over 60s reads as idle
 *     time before the next event. (Covering the gap before the call with the
 *     tool's duration would hide real idle and still not cover the run.)
 *   - No publisher emits `loop.gates` / `verify.gates`, so gate-time
 *     findings cannot fire from a real log until the runner publishes gate
 *     events.
 *   - When the stream carried no per-message usage, the log holds a single
 *     final `usage` event with the run's cumulative tokens (see
 *     lib/harness/runner.ts emitResultUsage): it becomes one turn holding
 *     the run totals, so per-turn figures are run totals in that case.
 */
export function adaptSequencedEventsToRunEvents(
  events: readonly SequencedEvent[],
): RunEvent[] {
  // Chronological order; a persisted log already is, but a caller may hand
  // in a slice. Turn numbers and the model-call durations below assume it.
  const sorted = [...events]
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);
  const out: RunEvent[] = [];
  const callsById = new Map<string, RunEvent>();
  let turn = 0;
  let previousTs: number | undefined;
  let pausedSince: number | undefined;

  for (const event of sorted) {
    const ts = event.ts;
    // Time inside (previousTs, ts] spent paused: a run.paused event opens
    // the interval, the next event closes it.
    const pausedMs =
      pausedSince !== undefined && previousTs !== undefined
        ? Math.max(0, ts - Math.max(previousTs, pausedSince))
        : 0;
    if (event.type === "run.paused") pausedSince = ts;
    else pausedSince = undefined;

    switch (event.type) {
      case "usage": {
        turn += 1;
        const usage = readUsage(event);
        const ms =
          previousTs !== undefined ? Math.max(0, ts - previousTs - pausedMs) : undefined;
        out.push({
          type: "turn",
          ts,
          turn,
          tokens: {
            uncached: Math.max(0, usage.inputTokens - usage.cachedTokens),
            cacheRead: usage.cachedTokens,
          },
          ...(ms !== undefined ? { ms } : {}),
        });
        break;
      }
      case "tool.call": {
        const name = str(field(event, "name")) ?? str(field(event, "tool")) ?? "unknown";
        const id = str(field(event, "id"));
        const runEvent: RunEvent = {
          type: "tool.call",
          ts,
          tool: name,
          ...(id !== undefined ? { id } : {}),
        };
        const input = field(event, "input");
        if (isRecord(input) || typeof input === "string") runEvent.input = input;
        out.push(runEvent);
        if (id !== undefined) callsById.set(id, runEvent);
        break;
      }
      case "tool.result": {
        const id = str(field(event, "id"));
        const call = id !== undefined ? callsById.get(id) : undefined;
        if (call && field(event, "ok") === false) {
          call.isError = true;
          const error = str(field(event, "error")) ?? str(field(event, "output"));
          if (error !== undefined) call.error = clipError(error);
        }
        break;
      }
      case "tool.blocked": {
        const name = str(field(event, "name")) ?? str(field(event, "tool")) ?? "unknown";
        const reason = str(field(event, "reason")) ?? "policy";
        out.push({
          type: "tool.denied",
          ts,
          tool: name,
          reason,
          error: reason,
        });
        break;
      }
      default:
        break;
    }
    previousTs = ts;
  }
  return out;
}
