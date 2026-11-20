/**
 * SystemOneHooks: the fail-open System-1 middleware the harness calls into,
 * ported from Omnexx's SystemOneMiddleware
 * (vendor/omnexx/src/runtime/system-one/middleware.ts) without its kernel
 * (EventLog, ToolContext, jail, command policy).
 *
 *   onPrompt   → intent + read-only prefetch block to append to the prompt
 *   beforeTool → guardrail (Bash) and patch sanity (Edit/MultiEdit/Write)
 *   afterTool  → output triage of long Bash output
 *   afterTurn  → continuation check: a closing reply when the run can stop
 *
 * Fail-open, always: every hook is gated by settings, bounded by
 * `hookTimeoutMs`, and wrapped so that ANY System-1 failure (scorer throws
 * or hangs, readFile/search fails, even the event sink throws) degrades to
 * the pass-through answer — allow / unchanged output / keep going. A
 * System-1 error is reported as a `system1.error` event and never blocks a
 * run. System-1 only ever escalates to a human (`ask`); it never denies a
 * tool by itself, and the harness's own risk gate (risk.ts) still runs.
 */

import { ContinuationTracker, assessCommand, assessPatch, commandPreview, EDIT_TOOLS, guardrailReason, needsTriage, patchOf, patchRejection, speculate, speculativeBlock, triageOutput, type SearchRunner, type TurnCall } from "./gates";
import { localScorer, withTimeout, type SystemOneScorer } from "./scorer";
import { resolveSystemOneSettings, type SystemOneSettings, type SystemOneSettingsInput } from "./settings";

export type SystemOneGateName = "guardrail" | "patchSanity" | "outputTriage" | "earlyStop" | "speculativeRouting";

/** Telemetry the hooks emit. Previews only — never full file contents or env. */
export type SystemOneEvent =
  | { type: "system1.guardrail"; commandPreview: string; prob: number; escalated: boolean; latencyMs: number }
  | { type: "system1.patch_sanity"; path: string; rejected: boolean; placeholderProb: number; completeness: number; latencyMs: number }
  | { type: "system1.triage"; tool: string; changed: boolean; linesPruned: number; warningLines: number; tokensSaved: number; latencyMs: number }
  | { type: "system1.early_stop"; turn: number; prob: number; filesModified: number; latencyMs: number }
  | { type: "system1.intent"; intent: string; confidence: number; speculated: boolean; latencyMs: number }
  | { type: "system1.error"; gate: SystemOneGateName; message: string };

/** beforeTool's answer. `ask` routes through the existing approval flow. */
export type BeforeToolVerdict =
  | { action: "allow" }
  | { action: "ask"; reason: string; gate: "guardrail"; prob: number }
  | { action: "reject"; message: string; gate: "patchSanity" };

export interface SystemOneHooksOptions {
  settings?: SystemOneSettingsInput | SystemOneSettings;
  /** Defaults to the calibrated local scorer (no network, no keys). */
  scorer?: SystemOneScorer;
  emit?: (event: SystemOneEvent) => void;
  /** Reads a workspace file (Write patch-sanity needs the old text). */
  readFile?: (path: string) => Promise<string>;
  /** Read-only search runner for speculative prefetch (argv, in the repo). */
  search?: SearchRunner;
  /** Workspace root, for the out-of-repo guardrail signal. */
  repoRoot?: string;
  /** Allow mutations outside repoRoot without the out-of-scope penalty. */
  allowOutsideRepo?: boolean;
  /** Monotonic clock (tests). */
  now?: () => number;
}

const ALLOW: BeforeToolVerdict = { action: "allow" };

const rec = (x: unknown): Record<string, unknown> =>
  typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 200);
}

export class SystemOneHooks {
  readonly settings: SystemOneSettings;
  private readonly scorer: SystemOneScorer;
  private readonly tracker = new ContinuationTracker();
  private readonly opts: SystemOneHooksOptions;
  private readonly now: () => number;
  private prompt = "";
  /** Count of fail-open recoveries, by gate (for telemetry/tests). */
  readonly failures: Record<SystemOneGateName, number> = {
    guardrail: 0,
    patchSanity: 0,
    outputTriage: 0,
    earlyStop: 0,
    speculativeRouting: 0,
  };

  constructor(options: SystemOneHooksOptions = {}) {
    this.opts = options;
    this.settings = resolveSystemOneSettings(options.settings);
    this.scorer = options.scorer ?? localScorer;
    this.now = options.now ?? (() => performance.now());
  }

  private on(gate: SystemOneGateName): boolean {
    return this.settings.enabled && this.settings.gates[gate];
  }

  private emit(event: SystemOneEvent): void {
    try {
      this.opts.emit?.(event);
    } catch {
      /* a broken event sink must not break a run */
    }
  }

  /**
   * Run one hook body fail-open: settings-gated, time-bounded, and any
   * throw/timeout returns `fallback` and records a system1.error.
   */
  private async guarded<T>(gate: SystemOneGateName, fallback: T, body: () => Promise<T>): Promise<T> {
    if (!this.on(gate)) return fallback;
    try {
      return await withTimeout(body(), this.settings.hookTimeoutMs);
    } catch (error) {
      this.failures[gate]++;
      this.emit({ type: "system1.error", gate, message: messageOf(error) });
      return fallback;
    }
  }

  /** Gate 4: a read-only prefetch block to append to the user prompt, or undefined. */
  async onPrompt(prompt: string): Promise<string | undefined> {
    this.prompt = typeof prompt === "string" ? prompt : "";
    return this.guarded("speculativeRouting", undefined, async () => {
      if (!this.prompt.trim()) return undefined;
      const started = this.now();
      const v = await this.scorer.intent(this.prompt.slice(0, 2_000));
      const investigative = v.intent === "explain_code" || v.intent === "git_operation";
      const findings =
        investigative && this.opts.search && v.confidence >= this.settings.speculativeThreshold
          ? await speculate(v.intent, this.prompt, this.opts.search)
          : undefined;
      this.emit({ type: "system1.intent", intent: v.intent, confidence: v.confidence, speculated: Boolean(findings), latencyMs: this.now() - started });
      return findings ? speculativeBlock(v.intent, v.confidence, findings) : undefined;
    });
  }

  /** Gates 1 and 5, before a tool runs. Fail-open: any error → allow. */
  async beforeTool(name: string, input: unknown): Promise<BeforeToolVerdict> {
    if (name === "Bash") {
      return this.guarded("guardrail", ALLOW, async () => {
        const i = rec(input);
        const command = typeof i.command === "string" ? i.command : "";
        if (!command.trim()) return ALLOW;
        const started = this.now();
        const repoRoot = this.opts.repoRoot ?? "";
        const cwd = typeof i.cwd === "string" && i.cwd ? i.cwd : repoRoot;
        const v = await assessCommand(
          this.scorer,
          { command, cwd, repoRoot, allowOutsideRepo: this.opts.allowOutsideRepo === true },
          this.settings.destructiveThreshold,
        );
        this.emit({ type: "system1.guardrail", commandPreview: commandPreview(command), prob: v.prob, escalated: v.destructive, latencyMs: this.now() - started });
        return v.destructive ? { action: "ask", reason: guardrailReason(v.prob), gate: "guardrail", prob: v.prob } : ALLOW;
      });
    }
    if (EDIT_TOOLS.has(name)) {
      return this.guarded("patchSanity", ALLOW, async () => {
        const started = this.now();
        const patch = await patchOf(name, input, this.opts.readFile);
        if (!patch) return ALLOW;
        const v = await assessPatch(this.scorer, patch, this.settings.patchPlaceholderThreshold);
        this.emit({ type: "system1.patch_sanity", path: patch.path, rejected: v.reject, placeholderProb: v.placeholderProb, completeness: v.completeness, latencyMs: this.now() - started });
        return v.reject ? { action: "reject", message: patchRejection(patch.path, v), gate: "patchSanity" } : ALLOW;
      });
    }
    return ALLOW;
  }

  /** Gate 3: the tool output as it should enter the context. Fail-open: any error → unchanged. */
  async afterTool(name: string, content: string): Promise<string> {
    if (name !== "Bash" || typeof content !== "string" || !needsTriage(content)) return content;
    return this.guarded("outputTriage", content, async () => {
      const started = this.now();
      const r = await triageOutput(this.scorer, content, name);
      this.emit({ type: "system1.triage", tool: name, changed: r.changed, linesPruned: r.linesPruned, warningLines: r.warningLines, tokensSaved: r.tokensSaved, latencyMs: this.now() - started });
      return r.content;
    });
  }

  /**
   * Gate 2, after each model turn: the closing reply to end the run on when
   * the request is done and the loop is only re-inspecting; undefined to
   * keep going. The tracker always records (even with the gate off) so
   * enabling it mid-run sees the whole trace.
   */
  async afterTurn(calls: readonly TurnCall[], assistantText: string, turn: number): Promise<string | undefined> {
    try {
      this.tracker.record(calls, assistantText);
    } catch {
      return undefined;
    }
    return this.guarded("earlyStop", undefined, async () => {
      if (!this.tracker.eligible(assistantText, this.prompt)) return undefined;
      const started = this.now();
      const prob = await this.scorer.completion(this.tracker.state(this.prompt));
      if (!(prob > this.settings.earlyStopThreshold)) return undefined;
      this.emit({ type: "system1.early_stop", turn, prob, filesModified: this.tracker.filesModified.size, latencyMs: this.now() - started });
      return this.closingReply(assistantText);
    });
  }

  private closingReply(assistantText: string): string {
    if (assistantText.trim().length >= 200) return assistantText.trim();
    // An answer given earlier in the run (explain-style tasks) is the reply.
    if (this.tracker.filesModified.size === 0 && this.tracker.lastSubstantive.length >= 200) return this.tracker.lastSubstantive;
    const files = [...this.tracker.filesModified].sort((a, b) => a.localeCompare(b));
    const more = files.length > 8 ? ` and ${files.length - 8} more` : "";
    const changed = files.length
      ? `Changed ${files.slice(0, 8).join(", ")}${more}; the checks passed after the last edit.`
      : "Answered above.";
    const lead = assistantText.trim();
    return `${lead ? `${lead}\n\n` : ""}Done. ${changed}`;
  }
}
