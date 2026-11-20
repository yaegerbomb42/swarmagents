/**
 * Synchronous tool-approval coordinator.
 *
 * The in-VM Claude Code CLI runs with a managed PreToolUse hook
 * (vm-image/hooks/pre-tool-use.mjs). The hook POSTs every tool call to
 * /api/runtime/approvals/hook and *blocks* the CLI until this module returns
 * allow/deny. That is what makes the verdict synchronous with execution:
 * nothing runs before the classifier (and, for ask, the user's decision)
 * comes back; a deny/timeout means the tool never executes.
 *
 * Telemetry contract:
 *   - approve path:  approval.requested -> ... -> approval.resolved -> tool.started
 *   - deny path:     tool.blocked (no tool.started)
 *   - ask timeout:   approval.timeout -> approval.resolved -> tool.blocked
 *
 * `tool.started` is emitted here, not from the stream parser: the CLI prints
 * the `tool_use` block *before* the hook decision, so `tool.call` is not
 * evidence the command ran.
 */

import type { ApprovalTicket, TelemetryEvent } from "./types";
import { classifyToolCallAsync } from "./risk";
import type { RiskDecision } from "./risk";
import type { CheckpointOutcome } from "../runtime/checkpoints";

export interface ToolApprovalDecision {
  decision: "allow" | "deny";
  /** Human-readable reason, forwarded to the model on deny. */
  reason?: string;
  /** The approval card id when the decision required a human. */
  approvalId?: string;
}

export interface CreateToolApproval {
  (ask: { toolName: string; action: string; reason: string }): ApprovalTicket;
}

export interface EvaluateToolApprovalOptions {
  toolName: string;
  input: unknown;
  /** Called before the decision is returned (and before any tool executes). */
  emit: (event: TelemetryEvent) => void;
  /**
   * Creates the approval record + verdict promise for an ask. Without it an
   * ask fails closed: there is no way to get a human decision synchronously.
   */
  createApproval?: CreateToolApproval;
  /** g9 full-auto: auto-allow in-VM asks, deny hard-deny and external effects. */
  fullAuto?: boolean;
  /**
   * F1 time travel: called when an ask-classified call is cleared to execute,
   * before the tool runs, so the VM can be snapshotted first
   * (`auto-pre-step-<seq>`). Emits `checkpoint.created` on success and
   * `checkpoint.failed` on failure. A failure (rejection or `{ok:false}`) is
   * surfaced in telemetry and never blocks the tool: the approval decision
   * stands, so a checkpoint failure can never halt the agent's work.
   */
  takeCheckpoint?: (info: { toolName: string; reason: string }) => Promise<CheckpointOutcome>;
  /** Run cancellation: a pending approval resolves as deny/expired. */
  signal?: AbortSignal;
  /** Scrubs secrets from the action text before it reaches the UI/model. */
  redact?: (text: string) => string;
  /** Injectable classifier for tests. */
  classify?: (name: string, input: unknown) => Promise<RiskDecision>;
}

const ALLOW: ToolApprovalDecision = { decision: "allow" };

/** Summarize the action being approved (a command, path, or URL). */
export function describeToolAction(name: string, input: unknown): string {
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
 * Ask-classified actions full-auto must still refuse: anything that leaves the
 * VM (remote push/publish, deploy, network egress) or touches credential
 * material, plus catastrophic root deletions. These are irreversible (or
 * exfiltrate) and cannot be undone by a later prompt. Everything else an ask
 * fires for is routine inside the agent's own throwaway VM, so full-auto
 * auto-approves it.
 */
const IRREVERSIBLE_EXTERNAL_PATTERNS: readonly RegExp[] = [
  // Remote git/package/docker writes: visible outside the VM.
  /\bgit\s+push\b/i,
  /\b(npm|yarn|pnpm)\s+publish\b/i,
  /\bdocker\s+push\b/i,
  /\b(kubectl|helm)\b/i,
  // Deploy tooling.
  /\b(deploy|terraform\s+apply|flyctl\s+deploy|vercel\s+--prod)\b/i,
  // Remote shell/file copy and generic egress clients.
  /\b(ssh|scp|sftp|rsync|telnet|nc|netcat)\b/i,
  /\b(curl|wget|fetch)\b/i,
  // Credential material: reading it can exfiltrate, writing it plant keys.
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /\b(id_rsa|id_ed25519|id_ecdsa|credentials|\.npmrc|\.netrc|\.pgpass)\b/i,
  /(^|[\\/])\.env([\\/]|$)/i,
  // Block devices / disk destruction.
  /\b(mkfs|fdisk|parted|wipefs|shred|blkdiscard)\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
];

/** True when an ask-classified call must not be auto-approved in full-auto. */
export function isIrreversibleExternal(
  toolName: string,
  input: unknown,
  reason = "",
): boolean {
  if (toolName === "WebFetch") return true;
  // The classifier's own catastrophic category stays blocked even in-VM.
  if (/destructive root deletion|system credential files/i.test(reason)) return true;
  const action = describeToolAction(toolName, input);
  return IRREVERSIBLE_EXTERNAL_PATTERNS.some((pattern) => pattern.test(action));
}

/** Race the verdict against run cancellation; cancellation is a denial, not a timeout. */
async function awaitVerdict(
  ticket: ApprovalTicket,
  signal: AbortSignal | undefined,
): Promise<"approved" | "denied" | "expired"> {
  if (!signal) return ticket.verdict;
  return Promise.race([
    ticket.verdict,
    new Promise<"approved" | "denied" | "expired">((resolve) => {
      if (signal.aborted) return resolve("expired");
      signal.addEventListener("abort", () => resolve("expired"), { once: true });
    }),
  ]);
}

/**
 * F1: snapshot the VM before an ask-classified call executes, and emit the
 * checkpoint telemetry. Never throws and never blocks the tool: a failed
 * snapshot emits `checkpoint.failed` and the caller proceeds with the
 * approval decision it already made.
 */
async function checkpointBeforeExecution(
  takeCheckpoint: NonNullable<EvaluateToolApprovalOptions["takeCheckpoint"]>,
  toolName: string,
  reason: string,
  emit: (event: TelemetryEvent) => void,
): Promise<void> {
  let outcome: CheckpointOutcome;
  try {
    outcome = await takeCheckpoint({ toolName, reason });
  } catch (error) {
    // A throwing hook has no label/seq to report (the contract is
    // outcome-based); the failure is still visible, attached to the tool.
    emit({
      type: "checkpoint.failed",
      label: "",
      vmLabel: "",
      stepSeq: 0,
      tool: toolName,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (outcome.ok) {
    emit({
      type: "checkpoint.created",
      label: outcome.label,
      vmLabel: outcome.vmLabel,
      stepSeq: outcome.stepSeq,
      tool: toolName,
      reason,
      createdAt: outcome.createdAt,
    });
    return;
  }
  emit({
    type: "checkpoint.failed",
    label: outcome.label,
    vmLabel: outcome.vmLabel,
    stepSeq: outcome.stepSeq,
    tool: toolName,
    reason,
    error: outcome.error,
  });
}

/** Evaluate one tool call synchronously with execution. */
export async function evaluateToolApproval(
  options: EvaluateToolApprovalOptions,
): Promise<ToolApprovalDecision> {
  const { toolName, input, emit } = options;
  const redact = options.redact ?? ((text: string) => text);
  const classify = options.classify ?? classifyToolCallAsync;

  const risk = await classify(toolName, input);

  if (risk.level === "deny") {
    const reason = redact(risk.reason);
    emit({ type: "tool.blocked", name: toolName, reason });
    return { decision: "deny", reason };
  }

  if (risk.level === "allow") {
    emit({ type: "tool.started", name: toolName });
    return ALLOW;
  }

  // ask: full-auto may auto-approve, but never for irreversible/external work.
  if (options.fullAuto) {
    if (isIrreversibleExternal(toolName, input, risk.reason)) {
      const reason = `Blocked by full-auto policy: ${redact(risk.reason)}`;
      emit({ type: "tool.blocked", name: toolName, reason });
      return { decision: "deny", reason };
    }
    // Auto-approved ask: checkpoint first, so the mutation it precedes has a
    // branch point even when no human ever saw the approval card.
    if (options.takeCheckpoint) {
      await checkpointBeforeExecution(options.takeCheckpoint, toolName, redact(risk.reason), emit);
    }
    emit({ type: "tool.started", name: toolName });
    return ALLOW;
  }

  // A synchronous gate with no way to ask a human must fail closed: letting
  // the call through is exactly the vulnerability this channel closes.
  if (!options.createApproval) {
    const reason = "no approval channel is configured for this run";
    emit({ type: "tool.blocked", name: toolName, reason });
    return { decision: "deny", reason };
  }

  const action = redact(describeToolAction(toolName, input));
  const reason = redact(risk.reason);
  const ticket = options.createApproval({ toolName, action, reason });
  const approval = {
    id: ticket.id,
    tool: toolName,
    action,
    reason,
    riskLevel: "ask" as const,
    expiresAt: ticket.expiresAt,
  };

  // The card is published before the CLI can possibly execute the tool.
  emit({ type: "approval.requested", approval });
  // The pre-existing UI event carries the same payload.
  emit({ type: "approval.required", approval });

  const verdict = await awaitVerdict(ticket, options.signal);

  if (
    verdict === "expired" &&
    !options.signal?.aborted &&
    (ticket.timedOut === undefined || ticket.timedOut())
  ) {
    emit({
      type: "approval.timeout",
      id: ticket.id,
      tool: toolName,
      action,
      reason,
      expiresAt: ticket.expiresAt,
    });
  }
  emit({ type: "approval.resolved", id: ticket.id, verdict });

  if (verdict === "approved") {
    // The approval is granted and the tool is about to execute: this is the
    // last moment the pre-mutation state exists, so checkpoint here.
    if (options.takeCheckpoint) {
      await checkpointBeforeExecution(options.takeCheckpoint, toolName, reason, emit);
    }
    emit({ type: "tool.started", name: toolName });
    return { ...ALLOW, approvalId: ticket.id };
  }

  const denyReason = verdict === "expired" ? "approval timed out" : "approval denied by user";
  emit({ type: "tool.blocked", name: toolName, reason: denyReason });
  return { decision: "deny", reason: denyReason, approvalId: ticket.id };
}
