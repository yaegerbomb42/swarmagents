/**
 * ClaudeCodeRunner: run Claude Code as the agent inside a user's VM.
 *
 * Spawns `claude -p <prompt> --output-format stream-json --verbose` (plus
 * `--resume <sessionId>` when resuming) through the caller's VmExec-like
 * interface, and normalizes the raw stream-json output into the typed
 * TelemetryEvent union from ./types.ts.
 *
 * Risk gating: every tool.call is classified by ./risk.ts (allow/ask/deny).
 *   - With the in-VM PreToolUse approval hook (`approvalHook: true`), the
 *     verdict is synchronous with execution: the CLI blocks on
 *     vm-image/hooks/pre-tool-use.mjs until the harness returns allow/deny,
 *     and the runner deliberately does no post-hoc gating.
 *   - Without it (legacy/CLIs without the hook):
 *     - allow: passes through unchanged.
 *     - ask: when an approvalGateway is wired, the harness emits
 *       approval.required and pauses further processing until the gateway's
 *       ticket resolves. Approved runs resume; denied/expired runs halt with a
 *       run.error.
 *     - deny: the call is blocked immediately (tool.blocked + run.error).
 *
 * Provider keys never appear in argv — they are passed via the exec env map
 * and scrubbed from every emitted event (see ./redact.ts).
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  ApprovalTicket,
  QuestionRequest,
  QuestionTicket,
  HandoffRequest,
  HandoffTicket,
  RolePhase,
  RoleSwitchRequest,
  RunOutcome,
  RunRequest,
  TelemetryEvent,
  VmExecOpts,
} from "./types";
import { isMetaTool } from "../self-manage/session";
import { buildDomainPlaybook } from "../playbook/domain-playbooks";
import { createStreamJsonParser } from "./stream-json";
import { compactToolResultText } from "./context/turn-compaction";
import { GateQueue } from "./gate-queue";
import { makeRedactor, redactValue } from "./redact";
import { classifyToolCall } from "./risk";
import { isIrreversibleExternal } from "./tool-approval";
import {
  SystemOneHooks,
  resolveSystemOneSettings,
  type BeforeToolVerdict,
  type SystemOneHooksOptions,
} from "./system-one/index";
import {
  DecisionBrainHooks,
  resolveDecisionBrainSettings,
  type AgentSnapshot,
  type BrainVerdict,
  type DecisionBrainHooksOptions,
} from "./decision-brain/index";
import { isRoleListTool, isRoleSwitchTool } from "./role-mcp";
import { isAskUserTool, parseAskUserArguments } from "./ask-mcp";
import { isDesktopHandoffTool, parseDesktopHandoffArguments } from "./desktop-handoff-mcp";
import { classifyDesktopToolCallAsync, computerActionEvent, isDesktopMcpCall } from "./computer-mcp";
import {
  ContextGovernor,
  StateLedger,
  resolveContextPacker,
  summarizeTurnResult,
  systemExtrasFrom,
  toPackedRunRequest,
  type ContextPackerMode,
} from "./context/contextGovernor";
import {
  joinSystemSections,
  orderSystemSections,
  packSystemSections,
  systemSectionsFrom,
} from "./context/system-packer";
import {
  ProgressWatchdog,
  errorSignature,
  extractDiscoveredSymbols,
  isMutatingTool,
  isReadTool,
  vmExecGitRunner,
  type ProgressWatchdogOptions,
  type TurnSignal,
} from "./progress-watchdog";

export interface ClaudeCodeRunnerOptions {
  /** Path to the claude binary. Defaults to "claude" (or $CLAUDE_BIN). */
  bin?: string;
  /**
   * Context packer for the invocation prompt. "claude-code" (the default)
   * keeps today's behaviour: the prompt and appended system text are passed
   * through byte-for-byte. "l1" packs the prompt into the fixed L1 budget
   * (8,192 tokens) before the CLI is spawned. A per-run `contextPacker` on the
   * request wins over this setting; a per-role default is used when neither is
   * set.
   *
   * One run() is one L1 turn: the prompt is rebuilt fresh from the state
   * ledger, the AST skeleton and the working set the caller supplies, and
   * run() returns the updated ledger plus the files the turn edited in the
   * outcome, so the next invocation packs from the accumulated state
   * instead of appending history. Turns inside one CLI invocation are
   * still the CLI's own: the packer governs the invocation prompt, and
   * the ledger is what makes successive invocations cheap.
   */
  contextPacker?: ContextPackerMode;
  /**
   * Per-role packer defaults, e.g. { coder: "l1" }. Consulted when neither the
   * run nor this runner sets a packer explicitly.
   */
  roleContextPackers?: Record<string, ContextPackerMode>;
  /**
   * Optional System-1 fail-open pre-checks. Nothing is constructed or called
   * unless `settings.enabled` is true, so the default run path is untouched.
   */
  systemOne?: SystemOneHooksOptions;
  /**
   * Optional Decision Brain loop control. Nothing is constructed or called
   * unless `settings.enabled` is true, so the default run path is untouched.
   * The Brain evaluates each allowed tool call from a snapshot of the loop
   * state; it can ask, stop, or signal a retry (a manager-level re-drive —
   * the runner cannot rewind the CLI).
   */
  decisionBrain?: DecisionBrainHooksOptions;
  /**
   * Optional ProgressWatchdog loop monitoring. Nothing is constructed or
   * called unless `enabled` is true, so the default run path is untouched.
   * The watchdog observes each tool result, checkpoints the working tree
   * every few mutating turns, and halts with a distinct rewind marker
   * when a failure pathology fires (a manager-level re-drive — the
   * runner cannot rewind the CLI). Test counts and diff hashes are not
   * visible to the runner, so its verdicts cover exact spin and read
   * paralysis; the oracle/manager feed the richer signals via the same
   * observe() API for diff thrash and monotonic regression.
   */
  progressWatchdog?: ProgressWatchdogOptions;
}

/** What buildArgv applied when the L1 packer ran, for the telemetry line. */
interface AppliedContextPacker {
  mode: ContextPackerMode;
  logLine: string;
}

/**
 * L1 turn state handed back to run() so it can close the loop: the ledger
 * this invocation packed from (mutated at the end of the run with the
 * turn's step and error) and the turn number it packed as.
 */
interface AppliedL1Turn {
  ledger: StateLedger;
  turn: number;
}

/**
 * RunRequest plus the optional per-run packer override. The field is read
 * structurally so a caller can opt one invocation into a packer without
 * changing the core RunRequest contract (the callers are owned elsewhere).
 */
type RunRequestWithPacker = RunRequest & { contextPacker?: unknown };

interface FinalResultMeta {
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  /** Stream-json `result` subtype ("success", "error_max_turns", ...). */
  subtype?: string;
  /** Stream-json `result` is_error flag. */
  isError?: boolean;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * Claude Code stderr warnings that are informational, never run errors.
 * The CLI prints `[claude-code:unrecognized_model]` for any model id it does
 * not recognise as an Anthropic model (e.g. third-party models routed
 * through the LLM gateway) — the model still works, so the warning must
 * never be surfaced as the run's error.
 */
const BENIGN_WARNING_PATTERNS: readonly RegExp[] = [/\[claude-code:unrecognized_model\]/];

/** Drop whole lines that are known benign warnings; "" when nothing remains. */
function stripBenignWarnings(text: string): string {
  return text
    .split("\n")
    .filter((line) => !BENIGN_WARNING_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
}

/** Signal names for the exits a Unix process reports as 128 + signal. */
const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  6: "SIGABRT",
  9: "SIGKILL",
  15: "SIGTERM",
};

/** True when the exit code means the process was killed by a signal (128+n). */
export function isSignalKillExitCode(exitCode: number): boolean {
  return exitCode > 128 && exitCode <= 128 + 31;
}

/** Default cap for --max-turns when SWARM_MAX_TURNS is unset or invalid. */
export const DEFAULT_SWARM_MAX_TURNS = 200;

/** Threshold and inline ceiling (in chars) for filtering oversized tool.result logs. */
export const AUTO_CONDENSE_THRESHOLD_CHARS = 4000;
export const AUTO_CONDENSE_MAX_CHARS = 4000;

/**
 * Effective --max-turns for one invocation: the requested ceiling,
 * floored to an integer, at least 1, and capped by SWARM_MAX_TURNS (or
 * the 200 default when the env is unset/invalid). Undefined when no
 * ceiling was requested — the CLI's own default applies, as today.
 * The cap is enforced here, at the argv boundary, so every source
 * (dispatch, role ceiling, direct caller) is capped the same way.
 */
export function resolveMaxTurns(
  requested: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return undefined;
  const rawCap = env.SWARM_MAX_TURNS?.trim();
  let cap = DEFAULT_SWARM_MAX_TURNS;
  if (rawCap) {
    const parsed = Number(rawCap);
    if (Number.isSafeInteger(parsed) && parsed > 0) cap = parsed;
  }
  return Math.max(1, Math.min(Math.floor(requested), cap));
}

/** Human-readable signal name for a 128+n exit code, e.g. 137 -> "SIGKILL". */
function signalNameFor(exitCode: number): string {
  return SIGNAL_NAMES[exitCode - 128] ?? `signal ${exitCode - 128}`;
}

/**
 * Describe a signal kill in plain language. `stderr` is the stderr tail,
 * used only to spot an OOM kill; benign warnings are stripped from it first
 * so they never leak into the reason.
 */
function describeKill(exitCode: number, stderr: string): string {
  const signal = signalNameFor(exitCode);
  if (/out of memory|oom-killer|memory cgroup/i.test(stderr)) {
    return (
      `claude was killed (exit ${exitCode}, ${signal}) — the container ran out of memory. ` +
      `Free up memory or use a smaller model, then retry.`
    );
  }
  return (
    `claude was killed (exit ${exitCode}, ${signal}) before it could finish. ` +
    `This usually means a timeout, a cancellation, or the container reaping the ` +
    `process group while a background child was still running.`
  );
}

/** A `result` event only counts as the agent finishing when it succeeded. */
function resultSucceeded(meta: FinalResultMeta): boolean {
  if (meta.isError === true) return false;
  return meta.subtype === undefined || meta.subtype === "success";
}

/** Map a stream-json `result` subtype to a stable finish reason, or undefined. */
function finalReasonFor(subtype: string | undefined): string | undefined {
  if (subtype === "error_max_turns") return "max_turns";
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Snapshot tool args, bounded so a huge tool input cannot bloat the
 * decision payload. Small inputs pass through verbatim; oversized ones
 * are replaced by a preview (destructive patterns live at the start of
 * a command, so the preview keeps the signal the heuristic scans for).
 */
function snapshotToolArgs(input: unknown): Record<string, unknown> {
  if (!isObject(input)) return {};
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    return {};
  }
  if (serialized.length <= 4000) return input;
  return { truncated: true, preview: serialized.slice(0, 4000) };
}

/** Parse a Claude `usage` object (assistant messages and the final result share its shape). */
function parseUsage(value: unknown): UsageTotals | null {
  if (!isObject(value)) return null;
  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : undefined;
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return null;
  // A provider that reported no usage surfaces as 0/0 (the proxy never sees a
  // usage object from it). Treat that as "no data" rather than recording a
  // fabricated zero, so the UI can show "—" instead of lying numbers.
  if (inputTokens === 0 && outputTokens === 0) return null;
  const cacheRead = typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens : 0;
  const cacheCreation = typeof value.cache_creation_input_tokens === "number" ? value.cache_creation_input_tokens : 0;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedTokens: cacheRead + cacheCreation,
  };
}

/**
 * Race a ticket outcome against the run's abort signal. The abort listener
 * is detached in a finally once the race settles: a `{ once: true }`
 * listener lingers on a long-lived request signal whenever the ticket
 * settles first (answer/denial/timeout), keeping the run's closure alive.
 */
export async function raceAgainstAbort<T>(
  outcome: Promise<T>,
  signal: AbortSignal | undefined,
  onAbortValue: T,
): Promise<T> {
  if (!signal) return outcome;
  // Already aborted: the race is lost before it starts, so resolve the abort
  // value directly instead of letting an already-settled outcome win.
  if (signal.aborted) return onAbortValue;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      outcome,
      new Promise<T>((resolve) => {
        onAbort = () => resolve(onAbortValue);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class ClaudeCodeRunner {
  private readonly bin: string;
  /** Runner-level packer selection; undefined means "use the role default". */
  private readonly contextPacker: unknown;
  /** Per-role packer defaults, e.g. { coder: "l1" }. */
  private readonly roleContextPackers: Record<string, unknown> | undefined;
  private readonly systemOneOptions: SystemOneHooksOptions | undefined;
  private readonly decisionBrainOptions: DecisionBrainHooksOptions | undefined;
  private readonly progressWatchdogOptions: ProgressWatchdogOptions | undefined;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.bin = options.bin ?? process.env.CLAUDE_BIN ?? "claude";
    this.contextPacker = options.contextPacker;
    this.roleContextPackers = options.roleContextPackers;
    this.systemOneOptions = options.systemOne;
    this.decisionBrainOptions = options.decisionBrain;
    this.progressWatchdogOptions = options.progressWatchdog;
  }

  /**
   * Run one claude CLI invocation in the VM and stream normalized telemetry.
   * Resolves when the process exits; emits run.finished / run.error as the
   * final event. The caller's onEvent may be called synchronously from within
   * exec callbacks, so it must be cheap and must not await.
   */
  async run(request: RunRequest, onEvent: (event: TelemetryEvent) => void): Promise<RunOutcome> {
    const redact = makeRedactor(request.env, request.redactSecrets);
    const { argv, packer, l1 } = this.buildArgv(request);
    /** Files this L1 turn edited (Edit/Write/NotebookEdit file paths). */
    const editedFiles = new Set<string>();
    /**
     * Files this invocation wrote/edited, tracked for every run (not only L1)
     * so the deliverable check can tell whether a "done" needs verification.
     */
    const changedFiles = new Set<string>();
    /** True once a real verification ran after the most recent file change. */
    let verifiedSinceChange = false;
    /** Final `result` text of the stream, for the ledger step summary. */
    let lastResultText: string | undefined;
    // System-1 is entirely inert when disabled: no hooks object, no await,
    // no events — the run path is byte-identical to the one without it.
    const systemOne =
      this.systemOneOptions && resolveSystemOneSettings(this.systemOneOptions.settings).enabled
        ? new SystemOneHooks(this.systemOneOptions)
        : undefined;
    // The Decision Brain is inert on the same terms: no hooks object, no
    // await, no events unless its own settings enable it. A per-run
    // `decisionBrain` on the request (the runtime wires the user's saved
    // settings + telemetry sink there) wins over the constructor option.
    const brainOptions = request.decisionBrain ?? this.decisionBrainOptions;
    const brain =
      brainOptions && resolveDecisionBrainSettings(brainOptions.settings).enabled
        ? new DecisionBrainHooks(brainOptions)
        : undefined;
    // The ProgressWatchdog is inert on the same terms. When enabled it
    // observes each tool result (via the gate chain, like the Brain) and
    // checkpoints the working tree in the VM; a pathology halts the run
    // with a rewind marker for a manager-level re-drive. The git runner
    // is VmExec-backed so snapshots run inside the VM at request.cwd;
    // without a cwd there is nothing to snapshot and the watchdog is
    // detection-only.
    const watchdog =
      this.progressWatchdogOptions?.enabled === true
        ? new ProgressWatchdog({
            ...this.progressWatchdogOptions,
            cwd: this.progressWatchdogOptions.cwd ?? request.cwd,
            git:
              this.progressWatchdogOptions.git ??
              (request.cwd ? vmExecGitRunner(request.vm) : undefined),
          })
        : undefined;

    let started = false;
    let lastSessionId: string | undefined;
    let firstErrorMessage: string | undefined;
    let finalMeta: FinalResultMeta | undefined;
    /** Cumulative usage from the final `result` event, used when no assistant usage arrived. */
    let resultUsage: UsageTotals | null = null;
    let sawAssistantUsage = false;
    let malformedLines = 0;
    let streamTruncated = false;
    let stderrTail = "";
    /** Set when the risk gate halts the run (deny or denied/expired ask). */
    let haltedReason: string | null = null;
    let aborted = false;
    /** Decision Brain loop state: evaluations so far, last result, last failure. */
    // Counts Decision Brain beforeTool invocations (one per gated tool call),
    // not Claude Code conversation turns / num_turns.
    let brainTurnCount = 0;
    let lastBrainToolResult: { ok: boolean; output: string } | null = null;
    let lastBrainError: string | null = null;
    /** ProgressWatchdog loop state: tool_use id -> tool name, turn count. */
    let watchdogTurnCount = 0;
    const watchdogToolNames = new Map<string, string>();

    // Role switching: a validated set_role call aborts this invocation (via an
    // internal signal the manager never sees) so the run can resume with the
    // new role's phase. `pendingSwitch` holds the phase to hand back to the
    // caller in the outcome.
    const switchAbort = new AbortController();
    // A policy halt must stop the claude child now, not when it happens to
    // finish: the VM would otherwise keep burning tokens after a denial.
    const haltAbort = new AbortController();
    const halt = (reason: string): void => {
      if (haltedReason !== null) return;
      haltedReason = reason;
      if (!haltAbort.signal.aborted) haltAbort.abort();
    };
    // Mutable holder: pendingSwitch is assigned from inside chained gate
    // closures, so a plain let would be narrowed to `never` by flow analysis.
    const pendingSwitch: { phase: RolePhase | null } = { phase: null };

    const abortForSwitch = () => {
      if (!switchAbort.signal.aborted) switchAbort.abort();
    };

    const resolveSwitch = async (
      request: RoleSwitchRequest,
      resolver: NonNullable<RunRequest["onRoleSwitch"]>,
    ): Promise<RolePhase | null> => {
      try {
        const phase = await resolver(request);
        return phase && phase.roleId === request.toRoleId ? phase : null;
      } catch {
        // The runtime's validator failed (e.g. store read error): reject the
        // switch; the MCP server's own response already reported it to the agent.
        return null;
      }
    };

    const emit = (event: TelemetryEvent) => onEvent(event);

    if (packer) {
      // Surface the L1 budget ledger line in telemetry. It rides on the
      // existing capability.changed event (the union already covers "context"
      // capability changes) so no new event type is needed.
      emit({
        type: "capability.changed",
        tool: "context",
        ok: true,
        detail: packer.logLine,
        why: `context packer ${packer.mode} (invocation-level)`,
      });
    }

    /**
     * Emit the final `result` usage totals once, when the stream never
     * carried per-message usage. Real Claude Code builds put the cumulative
     * run usage on the final `result` event; older/other builds attach
     * per-message usage to each assistant event — emitting the result totals
     * only when no assistant usage arrived means tokens are never counted
     * twice.
     */
    let resultUsageEmitted = false;
    const emitResultUsage = (): void => {
      if (resultUsageEmitted) return;
      resultUsageEmitted = true;
      const finalUsage = resultUsage as UsageTotals | null;
      if (finalUsage && !sawAssistantUsage) {
        emit({ type: "usage", ...finalUsage });
      }
    };

    /**
     * Close the L1 loop on this invocation's outcome: record the turn in
     * the ledger (step summary from the final result text, last error on
     * failure) and hand the snapshot plus the edited files back in the
     * outcome, so the caller can pack the next turn from them. A non-L1
     * invocation returns the outcome untouched. Runs at most once: every
     * call site returns its result immediately.
     */
    const withL1 = (outcome: RunOutcome): RunOutcome => {
      if (!l1) return outcome;
      const { ledger, turn } = l1;
      const failure =
        firstErrorMessage ??
        haltedReason ??
        (finalMeta?.isError
          ? `result reported an error${finalMeta.subtype ? ` (${finalMeta.subtype})` : ""}`
          : undefined);
      const summaryText = summarizeTurnResult(lastResultText ?? "");
      const summary =
        summaryText ||
        (outcome.roleSwitch
          ? `turn ${turn}: role switch to ${outcome.roleSwitch.toRoleId}`
          : failure
            ? `turn ${turn} failed: ${failure}`
            : outcome.aborted
              ? `turn ${turn} aborted by caller`
              : `turn ${turn} finished (exit ${outcome.exitCode})`);
      ledger.recordStep(turn, summary);
      const error =
        failure ??
        (outcome.aborted
          ? "run aborted by caller"
          : outcome.exitCode !== 0
            ? `claude exited with code ${outcome.exitCode}${
                stderrTail.trim() ? `: ${redact(stderrTail.trim().slice(0, 500))}` : ""
              }`
            : undefined);
      ledger.setError(error);
      return {
        ...outcome,
        stateLedger: ledger.toJSON(),
        ...(editedFiles.size > 0 ? { editedFiles: [...editedFiles] } : {}),
      };
    };

    /**
     * Terminal success: the agent produced its final result. The run is
     * finished with its cost even if the process was then reaped (e.g. exit
     * 137) while a leftover background child kept stdout open — the kill of
     * that child is not the run's outcome.
     */
    const emitFinished = (): RunOutcome => {
      emitResultUsage();
      const reason = finalReasonFor(finalMeta?.subtype);
      // Lightweight deliverable gate: a run that changed files but never ran a
      // real check gets an explicit reminder on the stream before it finishes.
      // Advisory only — the run still finishes; the user just sees that the
      // deliverable was not verified instead of trusting an unverified "done".
      const check = assessDeliverableCheck([...changedFiles], verifiedSinceChange);
      if (check) emit({ type: "run.deliverableCheck", ...check });
      emit({
        type: "run.finished",
        exitCode: 0,
        sessionId: finalMeta?.sessionId ?? lastSessionId ?? request.sessionId ?? "",
        costUsd: finalMeta?.costUsd,
        durationMs: finalMeta?.durationMs,
        numTurns: finalMeta?.numTurns,
        ...(reason ? { reason } : {}),
      });
      return withL1({ exitCode: 0, aborted: false, malformedLines });
    };

    const startRun = (init?: Record<string, unknown>) => {
      if (started) return;
      started = true;
      emit({
        type: "run.started",
        sessionId: typeof init?.session_id === "string" ? init.session_id : request.sessionId,
        model: typeof init?.model === "string" ? init.model : request.model,
        provider: request.provider,
        startedAt: Date.now(),
      });
    };

    /**
     * Gates run through a GateQueue (each ask waits for the previous
     * decision) and the final terminal handling drains the queue, so a run never finalizes while
     * an approval is still pending. Normal allow-path lines are processed
     * synchronously from the exec callbacks — exactly like the original
     * synchronous parser — while gated lines are handled asynchronously.
     */
    const gates = new GateQueue();
    // A throwing gate must halt the run, never poison the queue: every
    // enqueue below reports through here so one failure cannot silently
    // skip all later gates. System-1 / Decision-Brain hooks already fail
    // open internally; the approval calls inside them still fail closed.
    const haltOnGateError = (err: unknown): void => {
      if (haltedReason === null) {
        haltedReason = `Gate error: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    const handleLine = (raw: unknown): void => {
      if (!isObject(raw)) return;
      if (haltedReason !== null) return;
      if (!started) startRun(raw);
      if (typeof raw.session_id === "string") lastSessionId = raw.session_id;

      switch (raw.type) {
        case "assistant": {
          const message = isObject(raw.message) ? raw.message : null;
          if (!message) break;
          const content = Array.isArray(message.content) ? message.content : [];
          for (const block of content) {
            if (!isObject(block)) continue;
            if (block.type === "text" && typeof block.text === "string") {
              emit({ type: "assistant.text", text: redact(block.text) });
            } else if (block.type === "tool_use") {
              const name = typeof block.name === "string" ? block.name : "";
              const input = block.input;
              const toolId = typeof block.id === "string" ? block.id : undefined;
              if (toolId) {
                watchdogToolNames.set(toolId, name);
              }
              emit({
                type: "tool.call",
                name,
                input: redactValue(input, redact),
                id: toolId,
              });

              // Track file mutations for the deliverable check (every run) and
              // for the L1 packer's working set. A later real verification
              // (tests/build/lint, re-reading the file, inspecting the UI)
              // clears the reminder; any new edit re-arms it.
              const mutatedPath = mutationFilePath(name, input);
              if (mutatedPath) {
                changedFiles.add(mutatedPath);
                verifiedSinceChange = false;
              } else if (changedFiles.size > 0 && isVerificationToolCall(name, input)) {
                verifiedSinceChange = true;
              }

              // L1 packer: remember which files this turn edited so the
              // caller can feed their contents back as the next turn's
              // working set / skeleton.
              if (l1 && mutatedPath) editedFiles.add(mutatedPath);

              // A Bash call that backgrounds its work will not stream output
              // into the terminal, and the run may end before the work
              // finishes (the count-to-200 QA case: the loop was detached,
              // the agent replied "it'll take about 3 minutes", and the
              // terminal never showed the numbers). Flag it on the stream so
              // the user sees it live instead of wondering where the output
              // went; the prompt tail (see lib/roles.ts) tells the agent to
              // run user-visible work in the foreground.
              if (name === "Bash" && isObject(input) && typeof input.command === "string" && isBackgroundedCommand(input.command)) {
                emit({
                  type: "tool.backgrounded",
                  name,
                  command: redact(input.command).slice(0, 500),
                  hint: "Backgrounded work does not stream into the terminal and the run may end before it finishes. Run work the user asked to watch in the foreground, or report the background PID and log path and keep tailing the log until it finishes.",
                });
              }

              // Self-management: the live allowlist rejects tools the current
              // role (clamped to the run policy ceiling) does not include.
              if (request.selfManage && !request.selfManage.toolAllowed(name) && haltedReason === null) {
                const reason = `tool ${name} is outside the current allowlist`;
                halt(reason);
                emit({ type: "tool.blocked", name, reason });
              }

              if (request.selfManage && isMetaTool(name) && haltedReason === null) {
                const meta = request.selfManage.apply(name, input);
                if (meta.audit.why !== undefined || meta.injection) {
                  emit({
                    type: "capability.changed",
                    tool: name,
                    ok: meta.ok,
                    detail: meta.injection,
                    ...(meta.audit.why ? { why: meta.audit.why } : {}),
                  });
                }
                if (meta.resumePhase && pendingSwitch.phase === null) {
                  pendingSwitch.phase = meta.resumePhase;
                  abortForSwitch();
                }
              }

              // Desktop (computer-mcp / playwright-mcp) actions emit a
              // human-readable computer.action event for the activity strip.
              // The input is deep-redacted first so no secret — whole or
              // truncated in a summary — can escape in the event.
              if (isDesktopMcpCall(name)) {
                emit(computerActionEvent(name, redactValue(input, redact)));
              }

              // With the synchronous in-VM approval hook, the tool has
              // already been classified by the harness before the CLI could
              // run it (vm-image/hooks/pre-tool-use.mjs -> the approval
              // endpoint). Classifying stdout here after the fact could only
              // relabel a run whose call was already blocked/allowed, so the
              // hook path is authoritative and the legacy post-hoc gate is
              // skipped. It remains for CLIs/runs without the hook.
              if (!request.approvalHook) {
                const decision = classifyToolCall(name, input);
                // Desktop (computer-mcp / playwright-mcp) calls that pass the
                // synchronous gate get a DNS-aware re-check: a hostname that
                // resolves into private/loopback/metadata space halts the run
                // just like a synchronous denial.
                if (decision.level === "allow" && isDesktopMcpCall(name)) {
                  void gates.enqueue(async () => {
                    if (haltedReason !== null) return;
                    const asyncDecision = await classifyDesktopToolCallAsync(name, input);
                    if (asyncDecision && asyncDecision.level === "deny" && haltedReason === null) {
                      halt(asyncDecision.reason);
                      emit({ type: "tool.blocked", name, reason: asyncDecision.reason });
                    }
                  }, { onError: haltOnGateError });
                }
                if (
                  decision.level === "ask" &&
                  request.autoApprove === true &&
                  !isIrreversibleExternal(name, input, decision.reason)
                ) {
                  // Full-auto without the in-VM hook (legacy CLI): routine
                  // in-VM asks need no human, but irreversible external work
                  // still goes through the approval path below.
                } else if (decision.level === "ask" && request.approvalGateway) {
                  void gates.enqueue(async () => {
                    const verdict = await this.gateApproval(request, {
                      toolName: name,
                      action: describeAction(name, input),
                      reason: decision.reason,
                    }, emit, redact);
                    if (verdict !== "approved" && haltedReason === null) {
                      halt(verdict === "expired" ? "approval timed out" : "approval denied by user");
                    }
                  }, { onError: haltOnGateError });
                } else if (decision.level === "deny" && haltedReason === null) {
                  halt(decision.reason);
                  emit({ type: "tool.blocked", name, reason: decision.reason });
                }

                // System-1 adds a pre-check for calls the ordinary risk gate
                // allowed. A deny is never dropped silently: it goes through
                // the same visible approval pause. SystemOneHooks already
                // fails open; the extra catch keeps the run path safe even if
                // constructing or calling a hook throws.
                if (systemOne && decision.level === "allow" && haltedReason === null) {
                  void gates.enqueue(async () => {
                    if (haltedReason !== null) return;
                    let s1: BeforeToolVerdict | undefined;
                    try {
                      s1 = await systemOne.beforeTool(name, input);
                    } catch {
                      s1 = undefined;
                    }
                    if (!s1 || (s1.action !== "ask" && s1.action !== "reject")) return;
                    const reason = s1.action === "ask" ? s1.reason : s1.message;
                    if (request.approvalGateway) {
                      const userVerdict = await this.gateApproval(request, {
                        toolName: name,
                        action: describeAction(name, input),
                        reason,
                      }, emit, redact);
                      if (userVerdict !== "approved" && haltedReason === null) {
                        halt(userVerdict === "expired" ? "approval timed out" : "approval denied by user");
                      }
                    } else if (haltedReason === null) {
                      halt(reason);
                      emit({ type: "tool.blocked", name, reason });
                    }
                  }, { onError: haltOnGateError });
                }

                // Decision Brain loop control, evaluated for calls the
                // ordinary risk gate allowed. Fail-open like System-1: a
                // throwing router proceeds, and every verdict goes through
                // the same visible mechanisms (approval pause / halt).
                // `retry` halts with a distinct marker — the runner cannot
                // rewind the CLI, so a manager-level re-drive keys on it.
                if (brain && decision.level === "allow" && haltedReason === null) {
                  void gates.enqueue(async () => {
                    if (haltedReason !== null) return;
                    brainTurnCount += 1;
                    const snapshot: AgentSnapshot = {
                      goal: request.prompt,
                      lastToolCall: { name, args: snapshotToolArgs(input) },
                      lastToolResult: lastBrainToolResult,
                      error: firstErrorMessage ?? lastBrainError,
                      turnCount: brainTurnCount,
                      budgetLeft: {
                        turnsRemaining: Math.max(0, brain.settings.maxTurns - brainTurnCount),
                        // No run token budget is configured; the heuristic
                        // exhausts turns only. The sentinel keeps the
                        // snapshot shape stable for model routers.
                        tokensRemaining: 1_000_000,
                      },
                    };
                    let verdict: BrainVerdict | undefined;
                    try {
                      verdict = await brain.beforeTool(snapshot);
                    } catch {
                      verdict = undefined;
                    }
                    if (!verdict || verdict.action === "proceed") return;
                    if (verdict.action === "ask" && request.approvalGateway) {
                      const userVerdict = await this.gateApproval(request, {
                        toolName: name,
                        action: describeAction(name, input),
                        reason: verdict.reason,
                      }, emit, redact);
                      if (userVerdict !== "approved" && haltedReason === null) {
                        halt(userVerdict === "expired" ? "approval timed out" : "approval denied by user");
                      }
                    } else if (verdict.action === "retry") {
                      if (haltedReason === null) {
                        const reason = `decision brain requested retry: ${verdict.reason}`;
                        halt(reason);
                        emit({ type: "tool.blocked", name, reason });
                      }
                    } else if (haltedReason === null) {
                      // `ask` without a gateway, or `stop`: halt with the reason.
                      halt(verdict.reason);
                      emit({ type: "tool.blocked", name, reason: verdict.reason });
                    }
                  }, { onError: haltOnGateError });
                }
              }

              // ask_user: pause the run until the user answers. The answer is
              // written back into the VM by the runtime (see ask-mcp.ts), so
              // the agent receives it as this tool call's result. Persisted by
              // the question store before the event is emitted, so a page
              // reload can still restore the pending card.
              if (isAskUserTool(name) && request.questionGateway && haltedReason === null) {
                const ask = parseAskUserArguments(input);
                if (ask) {
                  void gates.enqueue(async () => {
                    if (haltedReason !== null) return;
                    await this.gateQuestion(request, ask, emit, redact);
                  }, { onError: haltOnGateError });
                }
              }

              // ask_human_desktop: pause the run and hand the VM desktop to the
              // user (shadow-to-takeover handoff). The UI opens an inline
              // Take-the-Wheel canvas; the resolution (with a post-handoff
              // state summary) is written back into the VM by the runtime so
              // the agent receives it as this tool call's result.
              if (isDesktopHandoffTool(name) && request.handoffGateway && haltedReason === null) {
                const handoff = parseDesktopHandoffArguments(input);
                if (handoff) {
                  void gates.enqueue(async () => {
                    if (haltedReason !== null) return;
                    await this.gateHandoff(request, handoff, emit, redact);
                  }, { onError: haltOnGateError });
                }
              }

              // Agent-initiated role switch (set_role from the roles MCP server).
              // list_roles is read-only and needs no harness involvement.
              if (
                !isRoleListTool(name) &&
                isRoleSwitchTool(name) &&
                request.onRoleSwitch &&
                pendingSwitch.phase === null &&
                haltedReason === null
              ) {
                void gates.enqueue(async () => {
                  if (pendingSwitch.phase !== null || haltedReason !== null) return;
                  const resolver = request.onRoleSwitch;
                  if (!resolver) return;
                  const toRoleId =
                    typeof input === "object" && input !== null
                      ? String((input as Record<string, unknown>).role_id ?? "").trim()
                      : "";
                  if (!toRoleId) return;
                  const reason =
                    typeof input === "object" && input !== null
                      ? String((input as Record<string, unknown>).reason ?? "").trim()
                      : undefined;
                  const phase = await resolveSwitch({
                    fromRoleId: request.rolePhase?.roleId ?? "",
                    toRoleId,
                    ...(reason ? { reason } : {}),
                  }, resolver);
                  if (!phase) return; // rejected by the runtime: no switch, no event
                  const fromName = request.rolePhase?.roleName ?? request.rolePhase?.roleId ?? "agent";
                  emit({
                    type: "role.changed",
                    from: { id: request.rolePhase?.roleId ?? "", name: fromName },
                    to: { id: phase.roleId, name: phase.roleName ?? phase.roleId },
                    ...(reason ? { reason } : {}),
                  });
                  pendingSwitch.phase = phase;
                  abortForSwitch();
                }, { onError: haltOnGateError });
              }
            }
          }
          const usage = parseUsage(message.usage);
          if (usage) {
            sawAssistantUsage = true;
            // The assistant message names the model actually generating; carry
            // it on the usage event so summaries can fill a model gap left by
            // a run.started that arrived without one.
            const usageModel = typeof message.model === "string" && message.model ? message.model : undefined;
            emit({ type: "usage", ...usage, ...(usageModel ? { model: usageModel } : {}) });
          }
          break;
        }
        case "user": {
          const message = isObject(raw.message) ? raw.message : null;
          if (!message) break;
          const content = Array.isArray(message.content) ? message.content : [];
          for (const block of content) {
            if (!isObject(block) || block.type !== "tool_result") continue;
            const resultId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
            const rawOutput = renderToolOutput(block, redact);
            // Live turn compaction (core-07): the same shared helper the
            // gateway applies to model-bound history, here for the harness
            // event stream. Opt-in via request.autoCondenseLogs; the raw
            // output is untouched when the switch is off.
            const output =
              request.autoCondenseLogs === true
                ? compactToolResultText(rawOutput, {
                    thresholdChars: AUTO_CONDENSE_THRESHOLD_CHARS,
                    maxInlineChars: AUTO_CONDENSE_MAX_CHARS,
                  })
                : rawOutput;
            const ok = block.is_error !== true;
            emit({
              type: "tool.result",
              id: resultId,
              ok,
              truncated: isTruncated(block),
              output,
            });
            // The Brain's loop state: the last result (bounded) and the
            // last failure. A success clears a stale failure — the loop
            // recovered, so the next decision must not retry on it.
            lastBrainToolResult = { ok, output: output.slice(0, 2000) };
            lastBrainError = ok ? null : output.slice(0, 500);
            // A successful tool result must not keep poisoning Decision Brain
            // snapshots with a stale stream-json error from earlier in the run.
            if (ok) firstErrorMessage = undefined;

            // ProgressWatchdog: observe the result synchronously (pure
            // detection, no I/O). A pathology halts the run with a rewind
            // marker for a manager-level re-drive — the runner cannot
            // rewind the CLI. Checkpointing is best-effort and async, so
            // it never blocks the stream.
            if (watchdog) {
              const resultId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
              const toolName = resultId ? watchdogToolNames.get(resultId) : undefined;
              if (resultId) watchdogToolNames.delete(resultId);
              watchdogTurnCount += 1;
              const signal: TurnSignal = {
                turn: watchdogTurnCount,
                toolName,
                readOnly: isReadTool(toolName),
                edited: isMutatingTool(toolName),
                ...(ok ? {} : { errorSignature: errorSignature(output.slice(0, 2000)) }),
                ...(isReadTool(toolName)
                  ? { symbolsDiscovered: extractDiscoveredSymbols(output.slice(0, 2000)) }
                  : {}),
              };
              const verdict = watchdog.observe(signal);
              void watchdog.maybeCheckpoint(signal).catch(() => {});
              if (verdict.action !== "none" && haltedReason === null) {
                const checkpoint = verdict.checkpoint?.treeHash;
                const disposition =
                  verdict.action === "rewind" && checkpoint
                    ? `rewind to ${checkpoint}`
                    : verdict.action === "rewind"
                      ? "no checkpoint to rewind to, escalate"
                      : "rewind cap reached, escalate";
                haltedReason =
                  `progress watchdog: ${verdict.pathology}; ${disposition}` +
                  ` (rewinds ${verdict.rewindsUsed}/${verdict.maxRewinds})` +
                  (verdict.failedHypotheses.length ? `; ${verdict.failedHypotheses.join(" ")}` : "");
                emit({ type: "tool.blocked", name: toolName ?? "unknown", reason: haltedReason });
              }
            }
          }
          break;
        }
        case "result": {
          // Keep the final result text: the L1 ledger records it as this
          // turn's step summary (summarized by withL1 at the return site).
          if (typeof raw.result === "string") lastResultText = raw.result;
          finalMeta = {
            sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
            // Claude Code reports `total_cost_usd`; keep accepting the older `cost_usd`.
            costUsd:
              typeof raw.total_cost_usd === "number"
                ? raw.total_cost_usd
                : typeof raw.cost_usd === "number"
                  ? raw.cost_usd
                  : undefined,
            durationMs: typeof raw.duration_ms === "number" ? raw.duration_ms : undefined,
            numTurns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
            subtype: typeof raw.subtype === "string" ? raw.subtype : undefined,
            isError: raw.is_error === true,
          };
          resultUsage = parseUsage(raw.usage);
          break;
        }
        case "error": {
          if (typeof raw.message === "string" && firstErrorMessage === undefined) {
            // A stream-json error that is only a known benign warning (e.g.
            // the unrecognized_model notice) is not an error at all.
            const cleaned = stripBenignWarnings(raw.message);
            if (cleaned) firstErrorMessage = redact(cleaned);
          }
          break;
        }
        default:
          break;
      }
    };

    const onAbort = () => {
      aborted = true;
    };
    if (request.signal) {
      if (request.signal.aborted) {
        aborted = true;
      } else {
        request.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {

    const parser = createStreamJsonParser({
      onLine: (raw, line) => {
        if (aborted) return;
        try {
          handleLine(raw);
        } catch (error) {
          if (haltedReason === null) {
            const message = error instanceof Error ? error.message : String(error);
            emit({ type: "run.error", message: redact(message), sessionId: lastSessionId });
            halt("internal harness error");
          }
        }
      },
      onMalformed: () => {
        malformedLines += 1;
      },
    });

    const execOpts: VmExecOpts = {
      cwd: request.cwd,
      env: request.env,
      signal: request.signal
        ? AbortSignal.any([request.signal, switchAbort.signal, haltAbort.signal])
        : AbortSignal.any([switchAbort.signal, haltAbort.signal]),
      ...(request.pgidFile ? { pgidFile: request.pgidFile } : {}),
      onStdout: (chunk) => parser.push(chunk),
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      },
    };

    let exitCode = -1;
    try {
      const result = await request.vm.exec(argv, execOpts);
      exitCode = result.exitCode;
      streamTruncated = result.truncated === true;
    } catch (error) {
      // A trailing line without a newline may hold the result event; parse it
      // before deciding the outcome so a run that already finished is not
      // reported as an error (e.g. the max-duration quota reaping the process
      // group while a background child kept stdout open).
      parser.flush();
      // Real exec drivers reject when the abort signal fires. A role switch or
      // a policy halt is a normal outcome, not an exec failure: settle the
      // gates and return the same shape the non-throwing path returns.
      await gates.drain();
      if (pendingSwitch.phase) {
        return withL1({
          exitCode,
          aborted: false,
          malformedLines,
          roleSwitch: { toRoleId: pendingSwitch.phase.roleId, sessionId: lastSessionId ?? request.sessionId },
        });
      }
      if (haltedReason !== null) {
        emit({
          type: "run.error",
          message: `Halted by harness risk policy: ${haltedReason}`,
          exitCode,
          sessionId: lastSessionId,
        });
        return withL1({ exitCode, aborted: false, malformedLines });
      }
      if (!request.signal?.aborted && finalMeta && resultSucceeded(finalMeta)) {
        return emitFinished();
      }
      const message = error instanceof Error ? error.message : String(error);
      const cleaned = stripBenignWarnings(message);
      emit({
        type: "run.error",
        message: redact(cleaned ? cleaned : "claude exec failed"),
        sessionId: lastSessionId,
      });
      return withL1({ exitCode, aborted: request.signal?.aborted === true, malformedLines });
    }

    // Flush the last partial line before gates run: a gated tool call or the
    // final result may arrive without a trailing newline, and the gate must
    // still be awaited and enforced.
    if (!request.signal?.aborted) parser.flush();

    // Wait for any outstanding approval/switch decisions so the run never
    // finalizes while a gate is still pending.
    await gates.drain();

    if (pendingSwitch.phase) {
      return withL1({
        exitCode,
        aborted: false,
        malformedLines,
        roleSwitch: { toRoleId: pendingSwitch.phase.roleId, sessionId: lastSessionId ?? request.sessionId },
      });
    }

    if (request.signal?.aborted) {
      emit({ type: "run.error", message: "Run aborted by caller.", exitCode, sessionId: lastSessionId });
      return withL1({ exitCode, aborted: true, malformedLines });
    }

    if (haltedReason !== null) {
      emit({
        type: "run.error",
        message: `Halted by harness risk policy: ${haltedReason}`,
        exitCode,
        sessionId: lastSessionId,
      });
      return withL1({ exitCode, aborted: false, malformedLines });
    }

    // A trailing line without a newline is still a real line at EOF.
    parser.flush();
    emitResultUsage();

    // The agent already produced its final result: the run finished with its
    // cost, whatever the process exit code says afterwards. A leftover
    // background child being reaped (exit 137) must not turn a completed
    // run into an error with a null cost.
    if (finalMeta && resultSucceeded(finalMeta)) {
      return emitFinished();
    }

    // OutputCap appends a marker and drops the rest of the stream. If that cut
    // off Claude's final result, a generic "no result" or exit-code error hides
    // the actionable cause. A complete successful result received before the
    // cap still finishes normally above.
    if (streamTruncated) {
      const message =
        "Claude Code stream-json output was truncated by the VM agent output quota, " +
        "so a successful final result could not be confirmed. Increase " +
        "SWARM_VM_AGENT_MAX_OUTPUT_BYTES or reduce tool output, then retry.";
      emit({ type: "run.error", message, exitCode, sessionId: lastSessionId });
      return withL1({ exitCode, aborted: false, malformedLines });
    }

    if (exitCode !== 0) {
      const rawDetail = firstErrorMessage ?? (stderrTail.trim() ? stderrTail.trim() : undefined);
      const cleaned = rawDetail === undefined ? undefined : stripBenignWarnings(rawDetail);
      const detail = cleaned ? redact(cleaned) : undefined;
      const message = isSignalKillExitCode(exitCode)
        ? detail
          ? `${describeKill(exitCode, stderrTail)} ${detail}`
          : describeKill(exitCode, stderrTail)
        : `claude exited with code ${exitCode}${detail ? `: ${detail}` : ""}`;
      emit({
        type: "run.error",
        message: redact(message),
        exitCode,
        sessionId: lastSessionId,
      });
      return withL1({ exitCode, aborted: false, malformedLines });
    }

    if (!finalMeta) {
      emit({
        type: "run.error",
        message: "claude exited 0 but produced no result event.",
        exitCode: 0,
        sessionId: lastSessionId,
      });
      return withL1({ exitCode: 0, aborted: false, malformedLines });
    }

    return emitFinished();
    } finally {
      // The run settled: the abort listener is no longer needed. Detach it
      // so a long-lived request signal does not keep this run's closure alive.
      if (request.signal) request.signal.removeEventListener("abort", onAbort);
    }
  }

  private async gateApproval(
    request: RunRequest,
    approval: ApprovalRequest,
    emit: (event: TelemetryEvent) => void,
    redact: (text: string) => string,
  ): Promise<"approved" | "denied" | "expired"> {
    const gateway = request.approvalGateway!;
    let ticket: ApprovalTicket;
    try {
      ticket = await gateway({ ...approval, id: approval.id ?? `appr_${randomUUID()}` });
    } catch {
      // Gateway failure is treated as a denial; the terminal run.error
      // (Halted by harness risk policy) reports it.
      return "denied";
    }

    emit({
      type: "approval.required",
      approval: {
        id: ticket.id,
        tool: approval.toolName,
        action: redact(approval.action),
        reason: redact(approval.reason),
        riskLevel: "ask",
        expiresAt: ticket.expiresAt,
      },
    });

    // Wait for the human decision, or for the run to be aborted/cancelled.
    const verdict = await raceAgainstAbort(ticket.verdict, request.signal, "expired");
    // An "expired" verdict from the TTL is a timeout; one caused by a
    // cancellation is not. Tickets without the probe keep the historical
    // behaviour (expired means timed out).
    if (
      verdict === "expired" &&
      !request.signal?.aborted &&
      (ticket.timedOut === undefined || ticket.timedOut())
    ) {
      emit({
        type: "approval.timeout",
        id: ticket.id,
        tool: approval.toolName,
        action: redact(approval.action),
        reason: redact(approval.reason),
        expiresAt: ticket.expiresAt,
      });
    }
    emit({ type: "approval.resolved", id: ticket.id, verdict });
    return verdict;
  }

  private async gateQuestion(
    request: RunRequest,
    question: QuestionRequest,
    emit: (event: TelemetryEvent) => void,
    redact: (text: string) => string,
  ): Promise<void> {
    const gateway = request.questionGateway!;
    let ticket: QuestionTicket;
    try {
      ticket = await gateway(question);
    } catch {
      emit({ type: "question.resolved", id: `q_${randomUUID()}`, status: "cancelled" });
      return;
    }

    emit({
      type: "question.required",
      question: {
        id: ticket.id,
        question: redact(ticket.question),
        ...(ticket.options.length > 0 ? { options: ticket.options.map((option) => redact(option)) } : {}),
        allowFreeText: ticket.allowFreeText,
        ...(ticket.expiresAt !== undefined ? { expiresAt: ticket.expiresAt } : {}),
      },
    });

    // A question outlives the agent's tool call, but never the run: a cancel
    // resolves the waiter with "cancelled" so finalization cannot hang.
    const outcome = await raceAgainstAbort(ticket.outcome, request.signal, { status: "cancelled" as const });

    emit({
      type: "question.resolved",
      id: ticket.id,
      status: outcome.status,
      ...(outcome.status === "answered" ? { answer: redact(outcome.answer) } : {}),
    });
  }

  private async gateHandoff(
    request: RunRequest,
    handoff: HandoffRequest,
    emit: (event: TelemetryEvent) => void,
    redact: (text: string) => string,
  ): Promise<void> {
    const gateway = request.handoffGateway!;
    let ticket: HandoffTicket;
    try {
      ticket = await gateway(handoff);
    } catch {
      emit({ type: "handoff.resolved", id: `h_${randomUUID()}`, status: "cancelled" });
      return;
    }

    emit({
      type: "handoff.required",
      handoff: {
        id: ticket.id,
        reason: redact(ticket.reason),
        ...(ticket.description.length > 0 ? { description: redact(ticket.description) } : {}),
        ...(ticket.expiresAt !== undefined ? { expiresAt: ticket.expiresAt } : {}),
      },
    });

    // The handoff outlives the agent's tool call, but never the run: a cancel
    // resolves the waiter with "cancelled" so finalization cannot hang.
    const outcome = await raceAgainstAbort(ticket.outcome, request.signal, { status: "cancelled" as const });

    emit({
      type: "handoff.resolved",
      id: ticket.id,
      status: outcome.status,
    });
  }

  /**
   * Resolve this invocation's packer: an explicit per-run override wins, then
   * the runner setting, then the active role's default, then "claude-code"
   * (resolveContextPacker owns the last two steps).
   */
  private resolvePackerMode(request: RunRequest): ContextPackerMode {
    return resolveContextPacker({
      run: (request as RunRequestWithPacker).contextPacker ?? this.contextPacker,
      roleId: request.rolePhase?.roleId,
      roles: this.roleContextPackers,
    });
  }

  private buildArgv(request: RunRequest): { argv: string[]; packer?: AppliedContextPacker; l1?: AppliedL1Turn } {
    const mode = this.resolvePackerMode(request);
    let effective = request;
    let packer: AppliedContextPacker | undefined;
    let l1: AppliedL1Turn | undefined;
    const systemPacker = request.systemPacker;
    const wantOrder = systemPacker?.cacheFriendlyOrder === true;

    if (mode === "l1") {
      // One invocation is one L1 turn: the prompt is rebuilt fresh from the
      // ledger (hydrated from RunRequest.stateLedger when the caller passes
      // a persisted snapshot, so a resumed or retried run inherits its
      // negative constraints instead of starting fresh), the AST skeleton
      // of the files in scope and the working set of the files being
      // edited — all supplied by the caller, since the harness never reads
      // files. run() records this turn into the ledger at the end of the
      // invocation and returns the snapshot in the outcome, so the next
      // invocation packs from the accumulated ledger. toPackedRunRequest
      // also drops --resume: an L1 turn is stateless, so replaying the
      // whole CLI session would defeat the budget.
      const ledger = request.stateLedger ? StateLedger.fromJSON(request.stateLedger) : new StateLedger(request.prompt);
      const turn = ledger.nextTurn();
      const packed = new ContextGovernor().pack({
        turn,
        ledger,
        skeletonFiles: request.skeletonFiles ?? [],
        workingSet: request.workingSet ?? [],
        systemExtras: wantOrder
          ? orderSystemSections(
              systemSectionsFrom({
                agentCard: request.agentCard,
                rolePrompt: request.rolePhase?.appendSystemPrompt,
                memoryContext: request.memoryContext,
              }),
            ).map((s) => s.text)
          : systemExtrasFrom(request),
      });
      effective = toPackedRunRequest(request, packed);
      packer = { mode, logLine: packed.logLine };
      l1 = { ledger, turn };
    }

    // Keep -p (print/non-interactive). Pass the prompt after `--` so values that
    // begin with '-' are treated as text, never as CLI flags.
    const argv: string[] = [this.bin, "-p", "--output-format", "stream-json", "--verbose"];
    if (effective.sessionId) argv.push("--resume", effective.sessionId);
    if (effective.model) argv.push("--model", effective.model);
    const maxTurns = resolveMaxTurns(effective.maxTurns);
    if (maxTurns !== undefined) argv.push("--max-turns", String(maxTurns));
    // The agent card, the active role's prompt and the account's long-term
    // memory ride as one appended system prompt, one argv element per value —
    // never interpolated into a shell string.
    const role = effective.rolePhase;
    if (role?.toolsDisabled === true) {
      argv.push("--tools", "");
    } else if (role) {
      // Empty values must not produce a bare flag: the CLI would consume the
      // following flag name as the value (e.g. "--mcp-config" as a tool).
      if (role.allowedTools.length > 0) argv.push("--allowedTools", ...role.allowedTools);
      if (role.mcpConfigPath) argv.push("--mcp-config", role.mcpConfigPath);
    }
    const appended = this.appendedSystemPrompt(effective, role?.appendSystemPrompt, mode, (applied) => {
      packer = applied;
    });
    if (appended) argv.push("--append-system-prompt", appended);
    argv.push("--", effective.prompt);
    return { argv, packer, l1 };
  }

  /**
   * The appended system prompt for one invocation. Default path: the agent
   * card, role prompt and memory joined untouched — byte-identical to
   * before the system packer existed. When the run's token-efficiency
   * options ask for it (claude-code mode only; L1 packs its own header),
   * the sections are optionally reordered stable-first for prompt caches
   * and packed to the token budget, lowest-value sections truncated
   * first. Any packer failure falls back to the legacy join: a packing
   * bug must never change what the agent is told.
   */
  private appendedSystemPrompt(
    effective: RunRequest,
    rolePrompt: string | undefined,
    mode: ContextPackerMode,
    onApplied: (applied: AppliedContextPacker) => void,
  ): string {
    const playbook = buildDomainPlaybook(effective.prompt);
    const legacy = [effective.agentCard, rolePrompt, effective.memoryContext, playbook.text]
      .filter(Boolean)
      .join("\n\n");
    const options = effective.systemPacker;
    if (mode === "l1" || !options || (options.pack !== true && options.cacheFriendlyOrder !== true)) {
      return legacy;
    }
    try {
      const memoryWithPlaybook = [effective.memoryContext, playbook.text].filter(Boolean).join("\n\n") || undefined;
      const sections = systemSectionsFrom({
        agentCard: effective.agentCard,
        rolePrompt,
        memoryContext: memoryWithPlaybook,
      });
      const ordered = options.cacheFriendlyOrder === true ? orderSystemSections(sections) : sections;
      if (options.pack === true) {
        const packed = packSystemSections(ordered, options.budgetTokens);
        onApplied({ mode, logLine: packed.logLine });
        return packed.text;
      }
      onApplied({
        mode,
        logLine: `system-packer order=cache-friendly sections=${ordered.map((s) => s.id).join(",")}`,
      });
      return joinSystemSections(ordered);
    } catch {
      return legacy;
    }
  }
}

/**
 * Strip single- and double-quoted segments so `&` inside quotes or URL query
 * strings does not look like a shell background operator.
 */
function stripQuotedSegments(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && i + 1 < command.length) {
        i += 1; // skip escaped char inside quotes
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * True when a shell command detaches work from the foreground: a background
 * operator (`&` — not `&&`, and not the `&>` / `>&` redirections), `nohup` /
 * `setsid`, `disown`, or a detached tmux/screen session. Quoted segments are
 * stripped before matching so `&` inside single/double-quoted strings or URL
 * query strings does not false-positive. Heuristic for a harness warning, not
 * a security gate.
 */
export function isBackgroundedCommand(command: string): boolean {
  if (typeof command !== "string" || command.trim() === "") return false;
  const unquoted = stripQuotedSegments(command);
  return BACKGROUND_PATTERNS.some((pattern) => pattern.test(unquoted));
}

/**
 * The file a mutating tool call writes or edits, or null. Only Edit, Write and
 * NotebookEdit carry a file path; Bash edits are deliberately not tracked
 * (they cannot be attributed to one deliverable reliably).
 */
export function mutationFilePath(name: string, input: unknown): string | null {
  if (!isObject(input)) return null;
  if (name === "Edit" || name === "Write") {
    return typeof input.file_path === "string" ? input.file_path : null;
  }
  if (name === "NotebookEdit") {
    return typeof input.notebook_path === "string" ? input.notebook_path : null;
  }
  return null;
}

/** Commands that count as actually verifying code: test/build/lint/typecheck. */
const VERIFICATION_COMMAND_RE =
  /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|build|lint|typecheck|check|verify)\b|\b(?:pytest|vitest|jest|mocha|tsc|playwright|cypress)\b|\b(?:go|cargo|make)\s+(?:test|build|check|vet)\b|\bnode\s+\S*(?:verify|check)\S*/i;

/** Desktop/browser tools that inspect the rendered result of a UI change. */
const VERIFICATION_TOOL_NAMES = new Set([
  "describe_screen",
  "screenshot",
  "browser_snapshot",
  "browser_take_screenshot",
]);

/**
 * Does a tool call actually verify the work? Re-reading a file, running the
 * real tests/build/lint, or inspecting the desktop/browser output all count;
 * `echo`, `ls` and `cat` do not. Heuristic for the deliverable reminder, not a
 * security gate.
 */
export function isVerificationToolCall(name: string, input: unknown): boolean {
  if (name === "Read") return true;
  const parts = name.split("__");
  const tool = parts[parts.length - 1];
  if (VERIFICATION_TOOL_NAMES.has(tool)) return true;
  if (name === "Bash" && isObject(input) && typeof input.command === "string") {
    return VERIFICATION_COMMAND_RE.test(input.command);
  }
  return false;
}

/**
 * The reminder emitted just before run.finished when files changed and no
 * verification ran afterwards. Returns null when the check passed (or nothing
 * changed), so a verified run finishes exactly as before.
 */
export function assessDeliverableCheck(
  changedFiles: readonly string[],
  verifiedSinceChange: boolean,
): { ok: boolean; message: string; files?: string[] } | null {
  if (changedFiles.length === 0 || verifiedSinceChange) return null;
  const files = changedFiles.slice(0, 10);
  return {
    ok: false,
    message:
      "Files changed but no verification ran afterwards. Run the real tests/build/lint, re-read or open the " +
      "deliverable, and say what you verified before calling this done.",
    ...(files.length > 0 ? { files } : {}),
  };
}

const BACKGROUND_PATTERNS: readonly RegExp[] = [
  // nohup / setsid at the start of a command or pipeline segment.
  /(^|[|;]\s*)(nohup|setsid)\b/,
  /\bdisown\b/,
  // Detached tmux session: `tmux new-session -d`, `tmux new -ds name`, …
  /\btmux\b[^\n;|]*\b(new-session|new)\b[^\n;|]*-[A-Za-z]*d/,
  // Detached screen session: `screen -dmS name cmd`, `screen -d -m cmd`.
  /\bscreen\b[^\n;|]*-[A-Za-z]*dm/,
  /\bscreen\b[^\n;|]*\s-d\s+[^\n;|]*\s-m\b/,
  // A lone `&` background operator: not `&&`, not a `&>` / `>&` redirect,
  // and not preceded by `&` (the second half of `&&`). Matches a trailing
  // `&` and a mid-command `cmd & cmd2`.
  /(^|[^&>])&(?![&>])\s*(;|$|\S)/,
];

/** Summarize the action being approved (a command, path, or URL). */
function describeAction(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === "string") return obj.command;
    if (typeof obj.file_path === "string") return obj.file_path;
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.url === "string") return obj.url;
    if (typeof obj.notebook_path === "string") return obj.notebook_path;
  }
  return name;
}

/**
 * Render one tool_result block's content as the event-stream text.
 * Image blocks are NOT inlined: a screenshot's base64 payload would flood
 * the SSE stream (and every consumer) with megabytes per event. They are
 * replaced by a short marker naming the media type and approximate size.
 */
function imageOutputMarker(item: Record<string, unknown>): string {
  const source = isObject(item.source) ? item.source : {};
  const mediaType = typeof source.media_type === "string" ? source.media_type : "image";
  const data = typeof source.data === "string" ? source.data : "";
  const approxBytes = Math.floor((data.length * 3) / 4);
  return `[image output (${mediaType}, ~${approxBytes} bytes) omitted from event stream]`;
}

function renderToolOutput(block: Record<string, unknown>, redact: (text: string) => string): string {
  const content = block.content;
  if (typeof content === "string") return redact(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (isObject(item)) {
        if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
        else if (item.type === "image") parts.push(imageOutputMarker(item));
        else parts.push(JSON.stringify(item));
      }
    }
    return redact(parts.join("\n"));
  }
  return redact(JSON.stringify(content ?? ""));
}

function isTruncated(block: Record<string, unknown>): boolean {
  if (block.truncated === true) return true;
  const content = block.content;
  const texts: string[] = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") texts.push(item);
      else if (isObject(item) && typeof item.text === "string") texts.push(item.text);
    }
  }
  return texts.some((t) => /\[output truncated\]|output truncated/i.test(t));
}
