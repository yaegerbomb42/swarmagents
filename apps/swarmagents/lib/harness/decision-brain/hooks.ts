/**
 * DecisionBrainHooks: the fail-open loop-control middleware the harness
 * calls into, following the System-1 precedent (PR #42). The runner
 * builds an AgentSnapshot at each tool call and asks for a verdict:
 *
 *   continue → proceed, the stream continues
 *   verify   → proceed for now (no post-result validator is wired yet;
 *              the decision is recorded in the brain.decision event so
 *              the follow-up has the trace to build on)
 *   ask      → the visible approval pause (same as System-1 `ask`)
 *   stop     → the run ends halted with the reason surfaced
 *   retry    → the run ends halted with a distinct `brain retry`
 *              marker; a manager-level re-drive (a separate piece) keys
 *              on it. The runner cannot rewind the CLI.
 *
 * Fail-open, always: the hook is gated by settings, bounded by
 * `hookTimeoutMs`, and any throw/timeout degrades to proceed. A Brain
 * error is reported as a `brain.error` event and never blocks a run.
 * Events go to the constructor's `emit` sink (the System-1 pattern) —
 * never into the telemetry union, so no UI change is needed.
 */

import { HeuristicDecisionRouter } from "./heuristic";
import {
  resolveDecisionBrainSettings,
  type DecisionBrainSettings,
  type DecisionBrainSettingsInput,
} from "./settings";
import type { AgentSnapshot, DecisionResult, DecisionRouter } from "./types";

/** Telemetry the hooks emit to the constructor's sink. */
export type BrainEvent =
  | {
      type: "brain.decision";
      decision: DecisionResult["decision"];
      confidence: number;
      reason: string;
      escalated: boolean;
      latencyMs: number;
    }
  | { type: "brain.error"; message: string };

/** beforeTool's answer. `ask`/`stop`/`retry` are applied by the runner. */
export type BrainVerdict =
  | { action: "proceed" }
  | { action: "ask"; reason: string }
  | { action: "stop"; reason: string }
  | { action: "retry"; reason: string };

export interface DecisionBrainHooksOptions {
  settings?: DecisionBrainSettingsInput | DecisionBrainSettings;
  /** Defaults to the heuristic router (no network, no keys). */
  router?: DecisionRouter;
  emit?: (event: BrainEvent) => void;
  /** Monotonic clock (tests). */
  now?: () => number;
}

const PROCEED: BrainVerdict = { action: "proceed" };

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 200);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`decision brain timeout after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class DecisionBrainHooks {
  readonly settings: DecisionBrainSettings;
  private readonly router: DecisionRouter;
  private readonly opts: DecisionBrainHooksOptions;
  private readonly now: () => number;
  /** Count of fail-open recoveries (for telemetry/tests). */
  failures = 0;

  constructor(options: DecisionBrainHooksOptions = {}) {
    this.opts = options;
    this.settings = resolveDecisionBrainSettings(options.settings);
    this.router = options.router ?? new HeuristicDecisionRouter();
    this.now = options.now ?? (() => performance.now());
  }

  private emit(event: BrainEvent): void {
    try {
      this.opts.emit?.(event);
    } catch {
      /* a broken event sink must not break a run */
    }
  }

  /**
   * Evaluate one snapshot fail-open: disabled → proceed; any router
   * throw/timeout → proceed + a brain.error event.
   */
  async beforeTool(snapshot: AgentSnapshot): Promise<BrainVerdict> {
    if (!this.settings.enabled) return PROCEED;
    const started = this.now();
    let result: DecisionResult;
    try {
      result = await withTimeout(this.router.decide(snapshot), this.settings.hookTimeoutMs);
    } catch (error) {
      this.failures++;
      this.emit({ type: "brain.error", message: messageOf(error) });
      return PROCEED;
    }
    this.emit({
      type: "brain.decision",
      decision: result.decision,
      confidence: result.confidence,
      reason: result.reason,
      escalated: result.escalated,
      latencyMs: this.now() - started,
    });
    switch (result.decision) {
      case "continue":
        return PROCEED;
      case "verify":
        // No post-result validator is wired yet: proceed, recorded above.
        return PROCEED;
      case "ask":
        return { action: "ask", reason: result.reason };
      case "stop":
        return { action: "stop", reason: result.reason };
      case "retry":
        return { action: "retry", reason: result.reason };
    }
  }
}
