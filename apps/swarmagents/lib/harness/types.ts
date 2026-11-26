/**
 * Core contracts for running Claude Code as the agent inside a user's VM.
 *
 * This module deliberately defines its own minimal "driver" interface instead of
 * importing from lib/vm: lib/vm is being built in parallel and this harness must
 * not depend on it. Any VmDriver-like implementation (real or in tests) that
 * satisfies VmExec can be plugged in.
 */

import type { StateLedgerSnapshot } from "./context/contextGovernor";
import type { SourceFile, WorkingSetItem } from "./context/astSlicer";
import type { RiskLevel } from "./risk";
import type { PlanStep } from "../run-plan";
import type { DecisionBrainHooksOptions } from "./decision-brain/hooks";

/** Minimal exec interface, modeled on VmDriver. Implementations manage the actual process tree. */
export interface VmExecOpts {
  cwd?: string;
  /**
   * Merged into the child process environment. Provider keys must travel here —
   * never in argv — because argv is visible to anything that can read the
   * process table, while env is private to the child.
   */
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  /**
   * In-container path of the process-group marker file for this exec (see
   * ExecOptions.pgidFile): the driver's setsid group is recorded here so the
   * caller can kill exactly this exec's group later.
   */
  pgidFile?: string;
}

export interface VmExec {
  exec(
    cmd: string[],
    opts?: VmExecOpts,
  ): Promise<{ exitCode: number; truncated?: boolean }>;
}

/**
 * Canonical, UI-facing telemetry events normalized from
 * `claude --output-format stream-json`.
 *
 * Raw claude stream-json events (system/assistant/user/result) are mapped onto
 * this smaller union so the UI never has to understand the CLI's wire format.
 * "usage" events carry the latest snapshot seen from the stream; the final
 * cumulative cost arrives on run.finished.
 */

export type TelemetryEvent =
  | { type: "run.started"; sessionId?: string; model?: string; provider?: string; startedAt: number }
  | { type: "assistant.text"; text: string }
  | { type: "tool.call"; name: string; input: unknown; id?: string }
  /**
   * The agent's plan changed (TodoWrite / TaskCreate / TaskUpdate folded
   * by lib/run-plan.ts). Carries the whole list; emitted only on change.
   */
  | { type: "run.plan"; steps: PlanStep[] }
  /**
   * Emitted by the synchronous approval channel (the in-VM PreToolUse hook)
   * once a call is cleared to execute. It is deliberately distinct from
   * `tool.call`: the CLI reports the `tool_use` block before it asks for
   * permission, so `tool.call` is not proof the command ran. `tool.started`
   * marks the moment the gate returned allow.
   */
  | { type: "tool.started"; name: string; id?: string }
  | { type: "tool.result"; id?: string; ok: boolean; truncated: boolean; output: string }
  /**
   * Token usage. Normally one per assistant message. `final: true` marks the
   * end-of-run top-up to the CLI's result totals (not a model turn).
   */
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens?: number; model?: string; final?: boolean }
  | {
      type: "run.finished";
      exitCode: number;
      sessionId: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      /** Why the invocation ended (e.g. "max_turns" when the turn ceiling was hit). */
      reason?: string;
    }
  | { type: "run.error"; message: string; exitCode?: number; sessionId?: string }
  /**
   * Emitted just before `run.finished` when the run changed files but never
   * ran a real verification (tests/build/lint, re-read the changed file, or
   * inspected the resulting UI). Advisory only: the run still finishes, but
   * the user sees that the deliverable check was skipped instead of trusting
   * an unverified "done". `files` names the changed paths (redacted, capped).
   */
  | { type: "run.deliverableCheck"; ok: boolean; message: string; files?: string[] }
  /**
   * Emitted when a tool call classifies as "ask": the run pauses until the
   * user resolves the approval (POST /api/runtime/approvals/{id}).
   */
  | {
      type: "approval.required";
      approval: {
        id: string;
        tool: string;
        /** Human-readable summary of the flagged action (e.g. the shell command). */
        action: string;
        reason: string;
        /** Risk level the classifier assigned (see ./risk.ts). */
        riskLevel: RiskLevel;
        /** Epoch ms at which an unanswered approval auto-denies itself. */
        expiresAt?: number;
        /** "tool" (default) for a flagged tool call; "role_escalation" for a switch. */
        kind?: "tool" | "role_escalation";
        /** Role escalation: the role the agent is switching from. */
        fromRole?: { id: string; name: string };
        /** Role escalation: the role the agent is switching to. */
        toRole?: { id: string; name: string };
        /** Role escalation: capabilities the target adds over the run baseline. */
        addedPermissions?: string[];
        addedTools?: string[];
        addedMcpServers?: string[];
      };
    }
  /**
   * Emitted by the synchronous approval channel as soon as the in-VM hook's
   * request reaches the harness, i.e. *before* the tool can execute. The
   * payload is identical to `approval.required` (kept for the existing UI);
   * the ordering guarantee is the point: `approval.requested` precedes
   * `tool.started` and no `tool.started` is emitted on deny/timeout.
   */
  | {
      type: "approval.requested";
      approval: {
        id: string;
        tool: string;
        action: string;
        reason: string;
        riskLevel: RiskLevel;
        expiresAt?: number;
      };
    }
  /** Emitted when a paused run's approval is decided or expires. */
  | { type: "approval.resolved"; id: string; verdict: "approved" | "denied" | "expired" }
  /** Emitted when nobody answered before the approval TTL; the run auto-denies. */
  | {
      type: "approval.timeout";
      id: string;
      tool?: string;
      action?: string;
      reason?: string;
      expiresAt?: number;
    }
  /** Emitted when a tool call classifies as "deny" and the run is halted. */
  | { type: "tool.blocked"; name: string; reason: string }
  /** Emitted when a user clicks/types on the live desktop and pauses A1. */
  | { type: "run.user_takeover"; startedAt: number }
  /** Emitted when the user hands desktop control back to A1. */
  | { type: "run.user_handback"; durationSec: number; note: string }
  /**
   * Emitted when an ask-classified tool call is cleared to execute and the
   * auto-checkpoint hook snapshotted the VM first (F1 time travel).
   * `stepSeq` is the step the checkpoint precedes — the bus overwrites `seq`
   * with its own sequence, so the step number lives here. `label` is the
   * display label (`auto-pre-step-<stepSeq>`); `vmLabel` is the per-run
   * namespaced snapshot label the fork API restores from.
   */
  | {
      type: "checkpoint.created";
      label: string;
      vmLabel: string;
      stepSeq: number;
      /** Tool about to execute once the checkpoint is taken. */
      tool: string;
      /** Why the classifier asked for approval. */
      reason: string;
      createdAt: number;
    }
  /**
   * Emitted when the auto-checkpoint snapshot failed. The run continues
   * regardless — a checkpoint failure must never block the agent's work —
   * but it is visible in the timeline instead of silent, so a missing
   * checkpoint is noticed rather than assumed.
   */
  | {
      type: "checkpoint.failed";
      label: string;
      vmLabel: string;
      stepSeq: number;
      tool: string;
      reason: string;
      error: string;
    }
  /** Emitted on a forked run once its seed snapshot has been restored. */
  | {
      type: "checkpoint.restored";
      label: string;
      vmLabel: string;
      stepSeq: number;
      /** Run the checkpoint came from. */
      sourceRunId: string;
    }
  /**
   * Emitted when a Bash tool call backgrounds its work (`&`, `nohup`,
   * `setsid`, `disown`, detached tmux/screen). Backgrounded output does not
   * stream into the terminal and the run may end before the work finishes,
   * so the event names the command and reminds the agent (and the user) to
   * run user-visible work in the foreground, or report the background PID
   * and log path and keep tailing it. `command` is redacted like every
   * other tool input.
   */
  | { type: "tool.backgrounded"; name: string; command: string; hint: string }
  /**
   * Emitted when the agent switches role via set_role. The switch applies from
   * the next continuation (the runner resumes with the new role's tools/MCP/
   * instructions). `from`/`to` are public role shapes (id + name, no secrets).
   */
  | {
      type: "role.changed";
      from: { id: string; name: string };
      to: { id: string; name: string };
      reason?: string;
    }
  /**
   * Emitted when the agent loads or drops a capability mid-run (role, skill,
   * MCP server, or context). `detail` is the injection sent back to the session.
   */
  | {
      type: "capability.changed";
      tool: string;
      ok: boolean;
      detail: string;
      why?: string;
    }
  /**
   * Emitted when the agent performs a desktop (computer-use / on-screen
   * browser) action. `action` is a short human-readable summary rendered by
   * the activity strip (e.g. "Clicking Sign in", "Opening github.com");
   * the optional fields carry the structured target of the action.
   */
  | {
      type: "computer.action";
      action: string;
      target?: string;
      text?: string;
      x?: number;
      y?: number;
      url?: string;
    }
  /**
   * Emitted when the agent asks the user a question (ask_user). The run is
   * paused inside the tool call until the user answers; `id` is the persisted
   * question id used by POST /api/runtime/questions.
   */
  | {
      type: "question.required";
      question: {
        id: string;
        question: string;
        options?: string[];
        allowFreeText: boolean;
        expiresAt?: number;
      };
    }
  /** Emitted when a pending question is answered, cancelled, or expires. */
  | {
      type: "question.resolved";
      id: string;
      status: "answered" | "cancelled" | "expired";
      /** Present when status is "answered" (already redacted by the runner). */
      answer?: string;
    }
  /**
   * Emitted when the agent asks the user to take the desktop wheel
   * (ask_human_desktop). The run is paused inside the tool call until the user
   * clicks "Hand Back to Agent"; `id` is the persisted handoff id used by
   * POST /api/runtime/handoffs.
   */
  | {
      type: "handoff.required";
      handoff: {
        id: string;
        reason: string;
        description?: string;
        expiresAt?: number;
      };
    }
  /** Emitted when a handoff is handed back, cancelled, or expires. */
  | {
      type: "handoff.resolved";
      id: string;
      status: "answered" | "cancelled" | "expired";
    };

/** An ask-classified tool call awaiting a human decision. */
export interface ApprovalRequest {
  /** Populated by the harness when the approval is created. */
  id?: string;
  runId?: string;
  userId?: string;
  toolName: string;
  /** Human-readable summary of the flagged action (e.g. the shell command). */
  action: string;
  reason: string;
}

export interface ApprovalTicket {
  id: string;
  /** Epoch ms at which an unanswered approval auto-denies itself. */
  expiresAt?: number;
  /**
   * Optional probe telling the harness whether an "expired" verdict came from
   * the TTL (true) rather than a cancellation/manual expiry (false).
   */
  timedOut?: () => boolean;
  /** Resolves when the approval is decided (or expires). */
  verdict: Promise<"approved" | "denied" | "expired">;
}

/**
 * Optional hook wired by the runtime: called when a tool call classifies as
 * "ask". The harness emits approval.required, pauses further processing, and
 * awaits the returned ticket's verdict before resuming (approved) or halting
 * (denied/expired). Absent when no approval flow is configured — ask-classified
 * calls then proceed like "allow".
 */
export type ApprovalGateway = (request: ApprovalRequest) => Promise<ApprovalTicket> | ApprovalTicket;

/** A validated ask_user tool call awaiting the user's answer. */
export interface QuestionRequest {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

export interface QuestionTicket {
  /** Id shared with the pending-question file written into the VM. */
  id: string;
  question: string;
  options: string[];
  allowFreeText: boolean;
  /** Epoch ms at which an unanswered question expires and the run resumes. */
  expiresAt?: number;
  /** Resolves when the user answers, the run is cancelled, or the TTL passes. */
  outcome: Promise<
    | { status: "answered"; answer: string }
    | { status: "cancelled" }
    | { status: "expired" }
  >;
}

/**
 * Optional hook wired by the runtime: called when the agent uses ask_user.
 * The runner emits question.required, pauses further processing, and awaits
 * the ticket's outcome. The runtime is responsible for writing the pending
 * question and its answer through the VM driver.
 */
export type QuestionGateway = (request: QuestionRequest) => Promise<QuestionTicket> | QuestionTicket;

/** A validated ask_human_desktop tool call awaiting a human at the wheel. */
export interface HandoffRequest {
  /** Why the desktop needs a human (a phrase, e.g. "CAPTCHA present"). */
  reason: string;
  /** Optional free-text detail on what to solve and what to do afterwards. */
  description: string;
}

export interface HandoffTicket {
  /** Id shared with the pending-handoff file written into the VM. */
  id: string;
  reason: string;
  description: string;
  /** Epoch ms at which an unresolved handoff expires and the run resumes. */
  expiresAt?: number;
  /** Resolves when the user hands the desktop back, the run is cancelled, or the TTL passes. */
  outcome: Promise<
    | { status: "answered" }
    | { status: "cancelled" }
    | { status: "expired" }
  >;
}

/**
 * Optional hook wired by the runtime: called when the agent uses
 * ask_human_desktop. The runner emits handoff.required, pauses further
 * processing, and awaits the ticket's outcome. The runtime is responsible for
 * writing the pending handoff and its resolution (with a post-handoff state
 * summary) through the VM driver.
 */
export type HandoffGateway = (request: HandoffRequest) => Promise<HandoffTicket> | HandoffTicket;

/**
 * The role configuration applied to one claude invocation. The runtime builds
 * this from a user's role (built-in or custom) and passes it via argv — never
 * as a shell string.
 */
export interface RolePhase {
  roleId: string;
  /** Display name, for telemetry (falls back to roleId when absent). */
  roleName?: string;
  /** Claude Code permission strings for --allowedTools (role tool whitelist). */
  allowedTools: string[];
  /** Absolute path (inside the VM) of the --mcp-config JSON for this role. */
  mcpConfigPath: string;
  /** Role instructions appended after the run prompt (--append-system-prompt). */
  appendSystemPrompt?: string;
  /**
   * Plain-chat mode: the model cannot call tools, so the runner passes no
   * --allowedTools or --mcp-config and the agent gets no tool surface.
   */
  toolsDisabled?: boolean;
}

/** A validated agent-initiated role switch request (from a set_role call). */
export interface RoleSwitchRequest {
  fromRoleId: string;
  toRoleId: string;
  reason?: string;
}

export interface RunRequest {
  prompt: string;
  /**
   * Persisted L1 state ledger for this run (StateLedgerSnapshot, see
   * lib/harness/context/contextGovernor.ts). When the run uses the "l1"
   * packer, the runner hydrates the ledger from this snapshot instead of
   * starting fresh, so a resumed or retried run inherits its negative
   * constraints (failed attempts). The harness never reads files; the
   * caller owns persisting the snapshot next to the run and passing it
   * back on the next turn.
   */
  stateLedger?: StateLedgerSnapshot;
  /**
   * Files in scope for the L1 packer's AST skeleton, as `{ path, content }`
   * (repo-relative paths). Only read when the "l1" packer is active; the
   * harness never reads files itself, so the caller supplies the contents
   * (read from the VM, the codebase store, or tests). Empty/absent means
   * the skeleton section stays empty, as before.
   */
  skeletonFiles?: SourceFile[];
  /**
   * Files the agent is editing, for the L1 packer's working set (numbered
   * line windows around `focus`, most important first). Same caller-owned
   * rule as `skeletonFiles`: the harness renders what it is handed and
   * never opens a file.
   */
  workingSet?: WorkingSetItem[];
  /**
   * The agent card text — the user's own description of who the agent is and
   * what it should focus on. Passed to claude as `--append-system-prompt` so
   * it is treated as part of the system prompt, never as an instruction
   * inside the user prompt. Same argv rules as prompt: a separate element,
   * never shell-interpolated.
   */
  agentCard?: string;
  /**
   * The account's long-term memory for this run (the most relevant facts,
   * rendered by the memory store). Appended to the system prompt so the
   * agent starts the run already knowing what it remembered last time.
   */
  memoryContext?: string;
  /**
   * Token-efficiency options for this invocation's appended system prompt
   * (see lib/harness/context/system-packer.ts). Absent — or both flags
   * false — means today's behaviour: the sections are joined untouched,
   * byte-identical. The runtime fills this from the account's
   * tokenEfficiency settings; the harness never reads settings itself.
   */
  systemPacker?: {
    /** Pack sections to the token budget, truncating lowest-value first. */
    pack?: boolean;
    /** Estimated-token cap for the appended system prompt when packing. */
    budgetTokens?: number;
    /** Emit sections stable-first so provider prompt caches hit. */
    cacheFriendlyOrder?: boolean;
  };
  /** Resume a prior session instead of starting fresh (passed as --resume). */
  sessionId?: string;
  model?: string;
  /**
   * Filter/condense oversized `tool.result` output (> 4000 chars) via
   * `filterObservation` (lib/harness/observation-filter.ts) before emitting/storing.
   * Disabled by default; runtime fills this from the account's settings.
   */
  autoCondenseLogs?: boolean;
  /**
   * Turn ceiling for this invocation, passed to claude as `--max-turns`.
   * The runner caps it at SWARM_MAX_TURNS (see resolveMaxTurns). Absent
   * means no flag — the CLI's own default applies, as today.
   */
  maxTurns?: number;
  /** Stable provider id the run is pointed at (from the router selection). */
  provider?: string;
  env: Record<string, string>;
  /**
   * In-container path of the process-group marker file for the agent exec
   * (see VmExecOpts.pgidFile). The manager picks one stable path per run so
   * its cancel backstop can kill the run's own process group afterwards.
   */
  pgidFile?: string;
  /**
   * Extra secrets to scrub from every emitted event (e.g. provider pool keys
   * that did not make it into `env`). Values are added to the redactor built
   * from `env`, never placed on the command line.
   */
  redactSecrets?: Iterable<string>;
  vm: VmExec;
  signal?: AbortSignal;
  cwd?: string;
  /** When set, ask-classified tool calls pause for a human decision. */
  approvalGateway?: ApprovalGateway;
  /**
   * True when the CLI is running with the in-VM PreToolUse approval hook
   * (vm-image/managed-settings.json). The hook blocks every tool call until
   * the harness returns allow/deny, so the runner must not classify-and-halt
   * from stdout after the fact: a deny there would relabel a run whose tool
   * was already blocked synchronously. The hook emits the approval telemetry.
   */
  approvalHook?: boolean;
  /**
   * Auto-approve mode: ask-classified calls proceed without a human. Deny
   * decisions (including the unconditional VM-only policy) still halt.
   * Safe only because every tool executes through the VM driver.
   */
  autoApprove?: boolean;
  /** When set, ask_user calls pause the run until the user answers. */
  questionGateway?: QuestionGateway;
  /**
   * When set, ask_human_desktop calls pause the run until the user hands the
   * desktop back (shadow-to-takeover handoff).
   */
  handoffGateway?: HandoffGateway;
  /**
   * Per-run Decision Brain loop control. When set (and its settings enable
   * it), the runner evaluates each risk-allowed tool call through the brain
   * before it proceeds: `ask` pauses via the approval gateway, `stop` halts,
   * `retry` halts with a distinct marker. Wins over the runner-level
   * `decisionBrain` constructor option. Absent or disabled → the brain is
   * never constructed and the run path is byte-identical to one without it.
   * The runtime wires the user's saved settings plus an `emit` sink that
   * publishes `brain.decision` / `brain.error` to the telemetry bus.
   */
  decisionBrain?: DecisionBrainHooksOptions;
  /**
   * The role configuration for this invocation (--allowedTools / --mcp-config
   * / --append-system-prompt). When absent the run uses the default toolset.
   */
  rolePhase?: RolePhase;
  /**
   * Resolves an agent-initiated set_role request. Return the phase to switch
   * to (the runner emits role.changed and resumes with it), or null to leave
   * the current role untouched. Absent when role switching is not enabled —
   * set_role calls then behave like any other tool call.
   */
  onRoleSwitch?: (request: RoleSwitchRequest) => Promise<RolePhase | null> | RolePhase | null;
  /**
   * Live self-management session. When set, meta-tool calls are applied here
   * (skills, MCP, role, context budget) and the resulting allowlist is enforced
   * on later tool calls in this invocation.
   */
  selfManage?: {
    apply(toolName: string, input: unknown): {
      ok: boolean;
      error?: string;
      injection: string;
      audit: { why?: string };
      resumePhase?: RolePhase;
    };
    toolAllowed(name: string): boolean;
  };
}

export interface RunOutcome {
  exitCode: number;
  aborted: boolean;
  /** Count of unparseable stream-json lines that were safely skipped. */
  malformedLines: number;
  /**
   * Set when a validated agent-initiated role switch halted this invocation:
   * the caller should resume with the new role's phase and this session id.
   */
  roleSwitch?: { toRoleId: string; sessionId?: string };
  /**
   * L1 packer only: the state ledger after this invocation — the step just
   * run recorded (and the last error set on failure). The caller owns
   * persisting it next to the run and passing it back as
   * `RunRequest.stateLedger` on the next invocation, so each turn packs
   * from the accumulated ledger instead of starting fresh. Absent when
   * the packer was not "l1".
   */
  stateLedger?: StateLedgerSnapshot;
  /**
   * L1 packer only: repo-relative paths of files this invocation edited
   * (Edit/Write/NotebookEdit tool calls observed on the stream), in first-
   * seen order, deduped. The caller reads their contents for the next
   * invocation's `workingSet`/`skeletonFiles`. Absent (or empty) when the
   * packer was not "l1" or nothing was edited.
   */
  editedFiles?: string[];
}
