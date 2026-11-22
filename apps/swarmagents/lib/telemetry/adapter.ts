/**
 * Bridge from persisted `SequencedEvent` logs to the flat `RunEvent`
 * vocabulary consumed by `efficiency()` and `diagnoseRun()`.
 *
 * The diagnostics were ported from the vendor tree with their own event names
 * (`turn`, `tool.call`, `loop.gates`), while the harness writes `usage`,
 * `tool.call`, `llm.call`, … into the run log. This adapter makes those pure
 * diagnostics usable on real, replayed runs without changing either module.
 */
import type { SequencedEvent } from "./bus";
import type { RunEvent } from "./efficiency";
import { field, isRecord, num, str } from "./events";

export function adaptSequencedEventsToRunEvents(events: readonly SequencedEvent[]): RunEvent[] {
  return events.map((event) => {
    const data = isRecord(event.data) ? event.data : {};
    const base = { ts: event.ts, seq: event.seq };

    switch (event.type) {
      case "usage": {
        // One assistant turn's usage. The diagnostics expect uncached input
        // (cache writes included) and cache reads as separate numbers.
        const input = num(field(event, "inputTokens"));
        const cached = num(field(event, "cachedTokens"));
        const tokens: Record<string, unknown> = {};
        if (input !== undefined) tokens.uncached = cached !== undefined ? Math.max(0, input - cached) : input;
        if (cached !== undefined) tokens.cacheRead = cached;
        const turn = num(field(event, "turn"));
        return {
          ...base,
          type: "turn",
          ...(turn !== undefined ? { turn } : {}),
          tokens,
          ms: num(field(event, "ms")) ?? 0,
        };
      }
      case "tool.call":
      case "tool.denied": {
        const error = str(field(event, "error"));
        return {
          ...base,
          type: event.type,
          tool: str(field(event, "tool")) ?? str(field(event, "name")) ?? "",
          input: field(event, "input"),
          ms: num(field(event, "ms")) ?? num(field(event, "latencyMs")) ?? 0,
          ...(field(event, "isError") === true ? { isError: true } : {}),
          ...(error ? { error } : {}),
        };
      }
      case "loop.gates":
      case "verify.gates": {
        const gates = field(event, "gates");
        return {
          ...base,
          type: event.type,
          ms: num(field(event, "ms")) ?? num(field(event, "durationMs")) ?? 0,
          ...(Array.isArray(gates) ? { gates } : {}),
        };
      }
      default:
        return { ...base, type: event.type, ...data };
    }
  });
}
