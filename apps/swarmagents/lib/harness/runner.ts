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
import { createStreamJsonParser } from "./stream-json";
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
import { isRoleListTool, isRoleSwitchTool, ROLE_MCP_CONFIG_PATH } from "./role-mcp";
import { isAskUserTool, parseAskUserArguments } from "./ask-mcp";
import { isDesktopHandoffTool, parseDesktopHandoffArguments } from "./desktop-handoff-mcp";
import { classifyDesktopToolCallAsync, computerActionEvent, isDesktopMcpCall } from "./computer-mcp";
import {
  ContextGovernor,
  StateLedger,
  resolveContextPacker,
  systemExtrasFrom,
  toPackedRunRequest,
  type ContextPackerMode,
} from "./context/contextGovernor";

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
   * Honest limit: one run() is one CLI invocation and the turns happen inside
   * the CLI, so the packer governs the invocation/resume prompt only — not
   * turns inside the CLI.
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
}

/** What buildArgv applied when the L1 packer ran, for the telemetry line. */
interface AppliedContextPacker {
  mode: ContextPackerMode;
  logLine: string;
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

export class ClaudeCodeRunner {
  private readonly bin: string;
  /** Runner-level packer selection; undefined means "use the role default". */
  private readonly contextPacker: unknown;
  /** Per-role packer defaults, e.g. { coder: "l1" }. */
  private readonly roleContextPackers: Record<string, unknown> | undefined;
  private readonly systemOneOptions: SystemOneHooksOptions | undefined;
  private readonly decisionBrainOptions: DecisionBrainHooksOptions | undefined;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.bin = options.bin ?? process.env.CLAUDE_BIN ?? "claude";
    this.contextPacker = options.contextPacker;
    this.roleContextPackers = options.roleContextPackers;
    this.systemOneOptions = options.systemOne;
    this.decisionBrainOptions = options.decisionBrain;
  }

  /**
   * Run one claude CLI invocation in the VM and stream normalized telemetry.
   * Resolves when the process exits; emits run.finished / run.error as the
   * final event. The caller's onEvent may be called synchronously from within
   * exec callbacks, so it must be cheap and must not await.
   */
  async run(request: RunRequest, onEvent: (event: TelemetryEvent) => void): Promise<RunOutcome> {
    const redact = makeRedactor(request.env, request.redactSecrets);
    const { argv, packer } = this.buildArgv(request);
    // System-1 is entirely inert when disabled: no hooks object, no await,
    // no events — the run path is byte-identical to the one without it.
    const systemOne =
      this.systemOneOptions && resolveSystemOneSettings(this.systemOneOptions.settings).enabled
        ? new SystemOneHooks(this.systemOneOptions)
        : undefined;
    // The Decision Brain is inert on the same terms: no hooks object, no
    // await, no events unless its own settings enable it.
    const brain =
      this.decisionBrainOptions && resolveDecisionBrainSettings(this.decisionBrainOptions.settings).enabled
        ? new DecisionBrainHooks(this.decisionBrainOptions)
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
    let brainTurnCount = 0;
    let lastBrainToolResult: { ok: boolean; output: string } | null = null;
    let lastBrainError: string | null = null;

    // Role switching: a validated set_role call aborts this invocation (via an
    // internal signal the manager never sees) so the run can resume with the
    // new role's phase. `pendingSwitch` holds the phase to hand back to the
    // caller in the outcome.
    const switchAbort = new AbortController();
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
     * Terminal success: the agent produced its final result. The run is
     * finished with its cost even if the process was then reaped (e.g. exit
     * 137) while a leftover background child kept stdout open — the kill of
     * that child is not the run's outcome.
     */
    const emitFinished = (): RunOutcome => {
      emitResultUsage();
      emit({
        type: "run.finished",
        exitCode: 0,
        sessionId: finalMeta?.sessionId ?? lastSessionId ?? request.sessionId ?? "",
        costUsd: finalMeta?.costUsd,
        durationMs: finalMeta?.durationMs,
        numTurns: finalMeta?.numTurns,
      });
      return { exitCode: 0, aborted: false, malformedLines };
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
     * Gates are chained (each ask waits for the previous decision) and the
     * final terminal handling awaits the chain, so a run never finalizes while
     * an approval is still pending. Normal allow-path lines are processed
     * synchronously from the exec callbacks — exactly like the original
     * synchronous parser — while gated lines are handled asynchronously.
     */
    let gateChain = Promise.resolve();

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
              emit({
                type: "tool.call",
                name,
                input: redactValue(input, redact),
                id: toolId,
              });

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
                haltedReason = `tool ${name} is outside the current allowlist`;
                emit({ type: "tool.blocked", name, reason: haltedReason });
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
                  gateChain = gateChain.then(async () => {
                    if (haltedReason !== null) return;
                    const asyncDecision = await classifyDesktopToolCallAsync(name, input);
                    if (asyncDecision && asyncDecision.level === "deny" && haltedReason === null) {
                      haltedReason = asyncDecision.reason;
                      emit({ type: "tool.blocked", name, reason: asyncDecision.reason });
                    }
                  });
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
                  gateChain = gateChain.then(async () => {
                    const verdict = await this.gateApproval(request, {
                      toolName: name,
                      action: describeAction(name, input),
                      reason: decision.reason,
                    }, emit, redact);
                    if (verdict !== "approved" && haltedReason === null) {
                      haltedReason = verdict === "expired" ? "approval timed out" : "approval denied by user";
                    }
                  });
                } else if (decision.level === "deny" && haltedReason === null) {
                  haltedReason = decision.reason;
                  emit({ type: "tool.blocked", name, reason: decision.reason });
                }

                // System-1 adds a pre-check for calls the ordinary risk gate
                // allowed. A deny is never dropped silently: it goes through
                // the same visible approval pause. SystemOneHooks already
                // fails open; the extra catch keeps the run path safe even if
                // constructing or calling a hook throws.
                if (systemOne && decision.level === "allow" && haltedReason === null) {
                  gateChain = gateChain.then(async () => {
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
                        haltedReason = userVerdict === "expired" ? "approval timed out" : "approval denied by user";
                      }
                    } else if (haltedReason === null) {
                      haltedReason = reason;
                      emit({ type: "tool.blocked", name, reason });
                    }
                  });
                }

                // Decision Brain loop control, evaluated for calls the
                // ordinary risk gate allowed. Fail-open like System-1: a
                // throwing router proceeds, and every verdict goes through
                // the same visible mechanisms (approval pause / halt).
                // `retry` halts with a distinct marker — the runner cannot
                // rewind the CLI, so a manager-level re-drive keys on it.
                if (brain && decision.level === "allow" && haltedReason === null) {
                  gateChain = gateChain.then(async () => {
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
                        haltedReason = userVerdict === "expired" ? "approval timed out" : "approval denied by user";
                      }
                    } else if (verdict.action === "retry") {
                      if (haltedReason === null) {
                        haltedReason = `decision brain requested retry: ${verdict.reason}`;
                        emit({ type: "tool.blocked", name, reason: haltedReason });
                      }
                    } else if (haltedReason === null) {
                      // `ask` without a gateway, or `stop`: halt with the reason.
                      haltedReason = verdict.reason;
                      emit({ type: "tool.blocked", name, reason: haltedReason });
                    }
                  });
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
                  gateChain = gateChain.then(async () => {
                    if (haltedReason !== null) return;
                    await this.gateQuestion(request, ask, emit, redact);
                  });
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
                  gateChain = gateChain.then(async () => {
                    if (haltedReason !== null) return;
                    await this.gateHandoff(request, handoff, emit, redact);
                  });
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
                gateChain = gateChain.then(async () => {
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
                });
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
            const output = renderToolOutput(block, redact);
            const ok = block.is_error !== true;
            emit({
              type: "tool.result",
              id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
              ok,
              truncated: isTruncated(block),
              output,
            });
            // The Brain's loop state: the last result (bounded) and the
            // last failure. A success clears a stale failure — the loop
            // recovered, so the next decision must not retry on it.
            lastBrainToolResult = { ok, output: output.slice(0, 2000) };
            lastBrainError = ok ? null : output.slice(0, 500);
          }
          break;
        }
        case "result": {
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

    if (request.signal) {
      if (request.signal.aborted) {
        aborted = true;
      } else {
        request.signal.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
      }
    }

    const parser = createStreamJsonParser({
      onLine: (raw, line) => {
        if (aborted) return;
        try {
          handleLine(raw);
        } catch (error) {
          if (haltedReason === null) {
            const message = error instanceof Error ? error.message : String(error);
            emit({ type: "run.error", message: redact(message), sessionId: lastSessionId });
            haltedReason = "internal harness error";
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
      signal: request.signal ? AbortSignal.any([request.signal, switchAbort.signal]) : switchAbort.signal,
      ...(request.pgidFile ? { pgidFile: request.pgidFile } : {}),
      onStdout: (chunk) => parser.push(chunk),
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      },
    };

    let exitCode: number;
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
      if (
        !request.signal?.aborted &&
        haltedReason === null &&
        pendingSwitch.phase === null &&
        finalMeta &&
        resultSucceeded(finalMeta)
      ) {
        return emitFinished();
      }
      const message = error instanceof Error ? error.message : String(error);
      const cleaned = stripBenignWarnings(message);
      emit({
        type: "run.error",
        message: redact(cleaned ? cleaned : "claude exec failed"),
        sessionId: lastSessionId,
      });
      return { exitCode: -1, aborted: request.signal?.aborted === true, malformedLines };
    }

    // Wait for any outstanding approval/switch decisions so the run never
    // finalizes while a gate is still pending.
    await gateChain;

    if (pendingSwitch.phase) {
      return {
        exitCode,
        aborted: false,
        malformedLines,
        roleSwitch: { toRoleId: pendingSwitch.phase.roleId, sessionId: lastSessionId ?? request.sessionId },
      };
    }

    if (request.signal?.aborted) {
      emit({ type: "run.error", message: "Run aborted by caller.", exitCode, sessionId: lastSessionId });
      return { exitCode, aborted: true, malformedLines };
    }

    if (haltedReason !== null) {
      emit({
        type: "run.error",
        message: `Halted by harness risk policy: ${haltedReason}`,
        exitCode,
        sessionId: lastSessionId,
      });
      return { exitCode, aborted: false, malformedLines };
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
      return { exitCode, aborted: false, malformedLines };
    }

    if (exitCode !== 0) {
      const rawDetail = firstErrorMessage ?? (stderrTail.trim() ? stderrTail.trim() : undefined);
      const cleaned = rawDetail === undefined ? undefined : stripBenignWarnings(rawDetail);
      const detail = cleaned ? cleaned : undefined;
      const message = isSignalKillExitCode(exitCode)
        ? detail
          ? `${describeKill(exitCode, stderrTail)} ${detail}`
          : describeKill(exitCode, stderrTail)
        : `claude exited with code ${exitCode}${detail ? `: ${detail}` : ""}`;
      emit({
        type: "run.error",
        message,
        exitCode,
        sessionId: lastSessionId,
      });
      return { exitCode, aborted: false, malformedLines };
    }

    if (!finalMeta) {
      emit({
        type: "run.error",
        message: "claude exited 0 but produced no result event.",
        exitCode: 0,
        sessionId: lastSessionId,
      });
      return { exitCode: 0, aborted: false, malformedLines };
    }

    return emitFinished();
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
        reason: approval.reason,
        riskLevel: "ask",
        expiresAt: ticket.expiresAt,
      },
    });

    // Wait for the human decision, or for the run to be aborted/cancelled.
    const wait = async (): Promise<"approved" | "denied" | "expired"> => {
      if (!request.signal) return ticket.verdict;
      return Promise.race([
        ticket.verdict,
        new Promise<"approved" | "denied" | "expired">((resolve) => {
          if (request.signal!.aborted) return resolve("expired");
          const onAbort = () => resolve("expired");
          request.signal!.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    };

    const verdict = await wait();
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
        reason: approval.reason,
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
        question: ticket.question,
        ...(ticket.options.length > 0 ? { options: ticket.options } : {}),
        allowFreeText: ticket.allowFreeText,
        ...(ticket.expiresAt !== undefined ? { expiresAt: ticket.expiresAt } : {}),
      },
    });

    // A question outlives the agent's tool call, but never the run: a cancel
    // resolves the waiter with "cancelled" so finalization cannot hang.
    const signal = request.signal;
    const outcome = signal
      ? await Promise.race([
          ticket.outcome,
          new Promise<{ status: "cancelled" }>((resolve) => {
            if (signal.aborted) resolve({ status: "cancelled" });
            else signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
          }),
        ])
      : await ticket.outcome;

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
    _redact: (text: string) => string,
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
        reason: ticket.reason,
        ...(ticket.description.length > 0 ? { description: ticket.description } : {}),
        ...(ticket.expiresAt !== undefined ? { expiresAt: ticket.expiresAt } : {}),
      },
    });

    // The handoff outlives the agent's tool call, but never the run: a cancel
    // resolves the waiter with "cancelled" so finalization cannot hang.
    const signal = request.signal;
    const outcome = signal
      ? await Promise.race([
          ticket.outcome,
          new Promise<{ status: "cancelled" }>((resolve) => {
            if (signal.aborted) resolve({ status: "cancelled" });
            else signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
          }),
        ])
      : await ticket.outcome;

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

  private buildArgv(request: RunRequest): { argv: string[]; packer?: AppliedContextPacker } {
    const mode = this.resolvePackerMode(request);
    let effective = request;
    let packer: AppliedContextPacker | undefined;

    if (mode === "l1") {
      // One invocation, one prompt: the request prompt is the ledger goal and
      // the agent card / role prompt / memory become the packed system header.
      // File windows and the AST skeleton are empty here because the runner has
      // no filesystem view of the user's VM; a caller with file state can feed
      // them in later. toPackedRunRequest also drops --resume: an L1 turn is
      // stateless, so replaying the whole CLI session would defeat the budget.
      const packed = new ContextGovernor().pack({
        turn: 0,
        ledger: new StateLedger(request.prompt),
        skeletonFiles: [],
        workingSet: [],
        systemExtras: systemExtrasFrom(request),
      });
      effective = toPackedRunRequest(request, packed);
      packer = { mode, logLine: packed.logLine };
    }

    // Keep -p (print/non-interactive). Pass the prompt after `--` so values that
    // begin with '-' are treated as text, never as CLI flags.
    const argv: string[] = [this.bin, "-p", "--output-format", "stream-json", "--verbose"];
    if (effective.sessionId) argv.push("--resume", effective.sessionId);
    if (effective.model) argv.push("--model", effective.model);
    // The agent card, the active role's prompt and the account's long-term
    // memory ride as one appended system prompt, one argv element per value —
    // never interpolated into a shell string.
    const role = effective.rolePhase;
    if (role && role.toolsDisabled !== true) {
      argv.push("--allowedTools", ...role.allowedTools);
      argv.push("--mcp-config", role.mcpConfigPath);
    }
    const appended = [effective.agentCard, role?.appendSystemPrompt, effective.memoryContext]
      .filter(Boolean)
      .join("\n\n");
    if (appended) argv.push("--append-system-prompt", appended);
    argv.push("--", effective.prompt);
    return { argv, packer };
  }
}

/**
 * True when a shell command detaches work from the foreground: a background
 * operator (`&` — not `&&`, and not the `&>` / `>&` redirections), `nohup` /
 * `setsid`, `disown`, or a detached tmux/screen session. A quoted ampersand
 * (e.g. `echo "a & b"`) can false-positive; the check is a heuristic for the
 * harness warning, not a security gate, so it errs toward flagging.
 */
export function isBackgroundedCommand(command: string): boolean {
  if (typeof command !== "string" || command.trim() === "") return false;
  return BACKGROUND_PATTERNS.some((pattern) => pattern.test(command));
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

function renderToolOutput(block: Record<string, unknown>, redact: (text: string) => string): string {
  const content = block.content;
  if (typeof content === "string") return redact(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (isObject(item)) {
        if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
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
