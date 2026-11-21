/**
 * In-memory runtime control plane for the per-user VM agent loop.
 *
 * Wiring: VmManager (lib/vm) -> ClaudeCodeRunner (lib/harness) ->
 * TelemetryBus (lib/telemetry). POST /api/runtime/tasks calls start();
 * every emitted event is published to the bus and streams to clients at
 * /api/runtime/stream/[runId].
 *
 * Invariant: at most ONE run may be active per user at a time. Starting a
 * new run while one is active queues it (up to SWARM_MAX_QUEUED, default 3)
 * and the next queued run starts when the active one finishes. DELETE
 * cancels the active run and/or removes queued items. State is per-process;
 * server restarts lose it.
 */

import { randomUUID } from "node:crypto";
import { vaultProxyEnv } from "../secrets/inject";
import { revokeVaultToken } from "../secrets/token";
import { ClaudeCodeRunner, isSignalKillExitCode } from "../harness/runner";
import { makeRedactor } from "../harness/redact";
import type {
  ApprovalGateway,
  QuestionGateway,
  QuestionRequest,
  HandoffGateway,
  HandoffRequest,
  RolePhase,
  RunOutcome,
  TelemetryEvent as HarnessEvent,
} from "../harness/types";
import {
  aggregateFailureSummary,
  classifyClaudeRunError,
  createRouter,
  isClaudeFailoverEligible,
} from "../providers";
import { routerProviders, userCooldownFilePath, userProvidersSignature } from "../providers/store";
import { readUserSettings } from "../providers/settings";
import {
  CONSERVATIVE_CAPABILITIES,
  mergedModelCapabilities,
  runModeForCapabilities,
  type RunModeInfo,
} from "../providers/capabilities";
import type { RunMode } from "../providers/types";
import { orderLlmCandidates } from "./llm-gateway";
import { isTeamRunActive, ownsTeamRun } from "../team/store";
import { serverMode } from "../auth";
import type {
  AttemptInfo,
  ClaudeSelection,
  ProviderErrorKind,
  Router,
} from "../providers";
import { getApprovalStore } from "../harness/approvals";
import { evaluateToolApproval, type ToolApprovalDecision } from "../harness/tool-approval";
import {
  checkpointDisplayLabel,
  checkpointVmLabel,
  resolveCheckpointStepSeq,
  takeRunCheckpoint,
  type CheckpointOutcome,
  type ForkInfo,
  type ResumePoint,
} from "./checkpoints";
import { requestRegisteredApproval } from "./tool-approval-bridge";
import { getQuestionStore, type QuestionOutcome } from "../harness/questions";
import { ASK_QUESTIONS_DIR, questionPaths } from "../harness/ask-mcp";
import {
  getHandoffStore,
  type HandoffOutcome,
} from "../harness/handoffs";
import {
  DESKTOP_HANDOFF_DIR,
  handoffPaths,
  type DesktopHandoffArguments,
} from "../harness/desktop-handoff-mcp";
import { buildHandoffSummary } from "./handoff-summary";
import { captureDesktopScreenshot } from "./run-report";
import { getGlobalDesktopProxy } from "../desktop-proxy/proxy";
import type { RfbFilterMode } from "../desktop-proxy/rfb-filter";
import { noteProjectRunEvent } from "../projects/recorder";
import { getBudgetGate } from "./budget-gate";
import { telemetryBus, type TelemetryBus } from "../telemetry/index";
import { getBrowserManager } from "../browser/manager";
import { bindExec, VmManager, vmManager } from "../vm/manager";
import { DockerVmDriver, buildPgidKillCommand, execPgidPath } from "../vm/docker-driver";
import { startVmIdleSweeper } from "../vm/idle-sweeper";
import { startTestDriveSweeper } from "../library/test-drive-sweeper";
import { getRun, recoverOrphanedRuns, recoverRunOnRestart } from "./run-store";
import {
  RunStateStore,
  type PersistedActiveRun,
  type PersistedQueuedRun,
  type PersistedRuntimeState,
  type PersistedUserState,
} from "./durable-queue";
import type { RunCompute } from "../computers/compute";
import { readReportMeta } from "./run-report";
import type { ReportCardMeta, RunVerificationMeta } from "./run-report-types";
import { RunReporter } from "./run-reporter";
import { getLastSession, setLastSession, clearLastSession } from "./session-store";
import { revokeRunToken, signRunToken } from "./run-token";
import {
  BUILTIN_ROLES,
  DEFAULT_ROLE_ID,
  buildRunRolePolicy,
  hasRoleEscalation,
  normalizeRoleDefinition,
  resolveRoleSwitch,
  roleCapabilityDelta,
  type RoleDefinition,
  type RunRolePolicy,
} from "../roles";
import { userRoleCatalog } from "../roles-store";
import {
  MAX_ROLE_PHASES,
  ROLE_MCP_CONFIG_PATH,
  desktopModeEnabled,
  roleContinuationPrompt,
  roleMcpConfigJson,
  rolePhase,
  roleSeedFiles,
} from "../harness/role-mcp";
import { resolveCodebaseInjection, wrapCodebasePack } from "../codebase/inject";
import { getCodebaseHotspots, recordAgentTouches, selectedCodebaseRepo } from "../codebase/store";
import { extractTouchedPaths } from "../codebase/touches";
import { createVmScanner } from "../codebase/vm-scanner";
import type { CodebaseScanner } from "../codebase/types";
import {
  SHADOW_VERIFIER_MAX_ROUNDS,
  bounceRemediationPrompt,
  isShadowVerificationEnabled,
  shadowVerifyRound,
  type ShadowExec,
  type ShadowVerifierDeps,
  type ShadowVerificationSummary,
} from "../verification/shadow-verifier";
import { runDiffHygieneGate } from "../verification/diff-hygiene-gate";
import { createCheapCallLLM } from "../verification/llm-caller";
import { writeRunVerification } from "../verification/store";
import { WORKSPACE_ROOT } from "../vm/files";
import { applyWarmGoldenSnapshot, type HotspotHint } from "../vm/warm-snapshots";
import {
  cleanupLibrarySeedFiles,
  libraryAllowedToolPermissions,
  libraryMcpEntries,
  librarySeedFiles,
} from "../library/run-seed";
import { awaitRoleEscalation, createRoleEscalationApproval } from "../harness/role-escalation";
import { startMemoryBridge } from "../memory/bridge";
import { memoryContextForPrompt } from "../memory/store";
import { buildMemoryPrompt } from "../memory/prompt";
import { runMemoryTool } from "../memory/tools";

/**
 * Only the variables Claude Code needs are forwarded into a user's VM. The server env also holds
 * session secrets, deploy tokens and unrelated provider keys, which must never reach agent-controlled code.
 * Extra names can be allowed with SWARM_VM_ENV_ALLOW (comma-separated).
 */
const ENV_ALLOW = /^(ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|DISABLE_TELEMETRY|DISABLE_ERROR_REPORTING)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HISTORY_LIMIT = 20;
const SUMMARY_PROMPT_LEN = 300;
const DEFAULT_MAX_QUEUED = 3;
/**
 * Watchdog thresholds for stuck runs. A run that is active but never emits
 * run.started within START_GRACE_MS — or goes entirely silent for SILENCE_MS
 * after starting — is declared stuck: it is finalized as an error and its
 * process tree aborted so the per-thread slot always frees. Both are
 * deliberately generous: VM cold boots can take minutes, and a single long
 * tool call (e.g. an agent sleeping in a loop) legitimately produces no
 * telemetry for a while. A wedged docker exec or a run whose process exited
 * without releasing the exec stream is what they exist to break.
 */
const DEFAULT_START_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_SILENCE_MS = 30 * 60 * 1000;

export type RunStatus = "queued" | "running" | "finished" | "error" | "cancelled";

export interface RunSummary {
  runId: string;
  userId: string;
  status: RunStatus;
  prompt: string;
  sessionId?: string;
  /** Provider serving the run, from the router selection (unknown while queued). */
  provider?: string;
  model?: string;
  /** Where the run executes. Cloud runs are served by the server VM pool. */
  compute?: RunCompute;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  /** Present when a run was cancelled rather than finishing naturally. */
  cancelledReason?: "user" | "superseded" | "shutdown";
  /** "shell" for one-shot terminal commands (POST /api/runtime/vm/exec). */
  kind?: "agent" | "shell";
  /** Capability-selected run mode ("gui" desktop, "text", or "chat"). */
  mode?: RunMode;
  /** Human-readable explanation of the mode, shown as a badge tooltip. */
  modeReason?: string;
  /** 1-based queue position while status is "queued". */
  position?: number;
  lastSeq: number;
  /** Compact report-card counts; present once the run's report exists. */
  report?: ReportCardMeta;
  /** Shadow-verifier gate result, when one ran for this run. */
  verification?: RunVerificationMeta;
  /** F1: which run + checkpoint this run was forked from, if it is a fork. */
  forkedFrom?: ForkInfo;
}

interface QueuedRun {
  runId: string;
  userId: string;
  prompt: string;
  /** The user's agent card text (appended system prompt), per-run snapshot. */
  agentCard?: string;
  sessionId?: string;
  model?: string;
  /** The role driving this run (undefined = legacy un-role'd run). */
  role?: RoleDefinition;
  /**
   * Explicit per-run role policy: the starting role, the roles it may switch
   * to without asking (subsets + the user's pre-grants), and those pre-grants.
   * Computed once when the run is accepted, so a later settings change cannot
   * widen a run that is already in flight.
   */
  rolePolicy: RunRolePolicy;
  /** Project this run belongs to (g5); absent for loose threads. */
  projectId?: string;
  /** "Previously…" block, injected only when this run starts a fresh thread. */
  projectContext?: string;
  /** Compute target chosen for this run (cloud only; BYOC runs go to the remote manager). */
  compute?: RunCompute;
  /** g9 full-auto approval mode for this prompt. */
  fullAuto?: boolean;
  /**
   * F14 ambient watcher: exact PreToolUse tool names this run may execute.
   * Unset means the normal classifier. A set list denies every other tool
   * before the classifier runs, and also intersects the CLI --allowedTools.
   */
  toolAllowlist?: readonly string[];
  /** F14 rule that woke this run, when it was started by a watcher. */
  ambientRuleId?: string;
  /** Capability mode resolved when the run was accepted. */
  runMode?: RunModeInfo;
  /** F1 fork seed: VM snapshot label restored when this run starts. */
  seedSnapshotLabel?: string;
  /** F1 fork provenance: the run + checkpoint this run was forked from. */
  forkedFrom?: ForkInfo;
  /** F1 fork: start a fresh conversation instead of resuming the last session. */
  freshSession?: boolean;
  createdAt: number;
}

export interface StartResult {
  accepted: boolean;
  runId: string;
  queued: boolean;
  position?: number;
  /** The configured queue depth when `accepted` is false. */
  limit?: number;
  /** Set when a request was refused (e.g. an unknown role id). */
  error?: string;
}

interface ActiveRun {
  runId: string;
  userId: string;
  controller: AbortController;
  prompt: string;
  /**
   * In-container path of this run's process-group marker file
   * (`/tmp/.swarm-exec-<runId>.pgid`). Every agent exec for the run is
   * spawned in its own session (setsid) with its pgid recorded there, so
   * the cancel backstop can kill exactly this run's group — never PID 1's
   * children (the desktop daemons in desktop VMs).
   */
  pgidFile: string;
  /**
   * The user's original prompt, never overwritten: role switches replace
   * `prompt` with the phase continuation prompt (which is what claude is
   * resumed with), but history and summaries must keep showing the ask.
   */
  initialPrompt: string;
  /** The user's agent card text (appended system prompt), per-run snapshot. */
  agentCard?: string;
  /**
   * The account's long-term memory for this run, rendered into the system
   * prompt at the start of the run (the facts the agent should remember).
   */
  memoryContext?: string;
  sessionId?: string;
  /** Provider serving the run, from the router selection. */
  provider?: string;
  model?: string;
  /** The role driving this run (undefined = legacy un-role'd run). */
  role?: RoleDefinition;
  /**
   * Explicit per-run role policy (see QueuedRun.rolePolicy). Survives the
   * queue and is never widened by a later catalog or settings change.
   */
  rolePolicy: RunRolePolicy;
  /** Project this run belongs to (g5); absent for loose threads. */
  projectId?: string;
  /**
   * The "Previously…" project digest, prepended to the prompt for a fresh
   * thread only. Kept out of `prompt` so thread history shows the user's ask.
   */
  contextPrefix?: string;
  /** Compute target for this run. Cloud runs are executed by this manager. */
  compute?: RunCompute;
  /** Capability mode for this run; may be refined when a provider is picked. */
  runMode?: RunModeInfo;
  createdAt: number;
  startedAt?: number;
  /** Epoch ms of the last telemetry this run produced; heartbeat for the watchdog. */
  lastActivityAt: number;
  /** True once the codebase context pack was prepended to this run. */
  codebaseContextInjected?: boolean;
  /** g9 full-auto: the synchronous approval hook auto-allows in-VM asks. */
  fullAuto?: boolean;
  /** F14: exact tool names the PreToolUse hook may allow. */
  toolAllowlist?: readonly string[];
  /** F14 rule id, when this run was started by an ambient watcher. */
  ambientRuleId?: string;
  /** Completed shadow-verifier attempts (bounds the bounce-back loop). */
  shadowAttempts?: number;
  /** F1 fork seed: VM snapshot label restored when this run starts. */
  seedSnapshotLabel?: string;
  /** F1 fork provenance: the run + checkpoint this run was forked from. */
  forkedFrom?: ForkInfo;
  /** Latest recorded resume point for this run (from auto-checkpoint). */
  resumePoint?: ResumePoint;
}

/** A one-shot terminal command run (POST /api/runtime/vm/exec). */
interface ShellRun {
  runId: string;
  userId: string;
  controller: AbortController;
  prompt: string;
  createdAt: number;
}

interface UserState {
  active: ActiveRun | null;
  /** Prompts waiting for the active run to finish, in FIFO order. */
  queue: QueuedRun[];
  /** In-flight shell execs. Unlike agent runs there is no one-per-user cap. */
  shellRuns: Map<string, ShellRun>;
  history: RunSummary[];
}

/** Queue depth from SWARM_MAX_QUEUED (default 3); invalid values fall back. */
function maxQueuedFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWARM_MAX_QUEUED?.trim();
  if (!raw) return DEFAULT_MAX_QUEUED;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return DEFAULT_MAX_QUEUED;
  return n;
}

interface TerminalPatch {
  status: "finished" | "error" | "cancelled";
  exitCode?: number;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  cancelledReason?: "user" | "superseded" | "shutdown";
  /** Shadow-verifier gate result, when one ran for this finished run. */
  verification?: RunVerificationMeta;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function isUnknownSessionError(message: string): boolean {
  return /unknown[- ]?session|session[- ]?not[- ]?found|invalid[- ]?session/i.test(message);
}

interface FailoverRecord {
  sel: ClaudeSelection;
  message: string;
  kind?: ProviderErrorKind;
  status?: number;
}

/** Env for the legacy single-provider mode (host ANTHROPIC_* passthrough). */
/** Credential-shaped env names (never forwarded from the host in server mode). */
const HOST_CREDENTIAL = /(API_KEY|AUTH_TOKEN|_TOKEN|_SECRET|_KEY)$/;

/**
 * Kill escalation windows for a cancelled agent run. The first abort signal
 * propagates to the exec driver, which terminates the docker CLI and sends a
 * best-effort SIGTERM to the in-container process tree. The slot frees
 * immediately, but if the container's leftover processes are still standing
 * after KILL_GRACE_MS (TERM ignored, or detached children of the agent's
 * shell) and no successor run has taken the slot, a hard SIGKILL is sent to
 * the container's children of PID 1 within the promised ~3s window.
 */
const KILL_GRACE_MS = 3000;
const KILL_TIMEOUT_MS = 3000;

/**
 * Base URL of the server-side LLM translation endpoint, reachable from the
 * VM. Set with SWARM_VM_LLM_BASE_URL; in server mode it defaults to the
 * public site origin (SWARM_PUBLIC_ORIGIN). When null, provider env points
 * straight at the provider (legacy local behavior).
 */
export function resolveLlmBaseUrl(): string | null {
  const explicit = process.env.SWARM_VM_LLM_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (serverMode()) {
    const origin = process.env.SWARM_PUBLIC_ORIGIN?.trim();
    if (origin) return origin.replace(/\/+$/, "");
  }
  return null;
}

/** Path the VM's PreToolUse hook POSTs tool calls to. */
export const APPROVAL_HOOK_PATH = "/api/runtime/approvals/hook";

/**
 * Base URL the VM uses to reach the synchronous approval endpoint. Defaults
 * to the same origin the LLM proxy uses (both are reached from inside the VM),
 * and can be overridden with SWARM_VM_APPROVAL_BASE_URL.
 */
export function resolveApprovalBaseUrl(): string | null {
  const explicit = process.env.SWARM_VM_APPROVAL_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return resolveLlmBaseUrl();
}

/**
 * Return an actionable startup error when any real Docker run would start
 * the managed PreToolUse hook without any way to reach or authenticate to its
 * approval endpoint. Never fall back to the legacy post-hoc stdout gate here:
 * the managed hook has already denied the tool before stdout could be gated.
 */
export function localDockerApprovalConfigurationError(vm: VmManager): string | null {
  if (!(vm.driver instanceof DockerVmDriver)) return null;
  const missing: string[] = [];
  if (!resolveApprovalBaseUrl()) missing.push("SWARM_VM_APPROVAL_BASE_URL");
  if (!process.env.SWARM_SESSION_SECRET?.trim()) missing.push("SWARM_SESSION_SECRET");
  if (missing.length === 0) return null;
  return (
    `Docker VM startup configuration error: ${missing.join(" and ")} must be configured. ` +
    "The managed VM image always enables its PreToolUse approval hook, so running without " +
    "a reachable authenticated approval endpoint would deny every non-allowlisted tool. " +
    "Set SWARM_VM_APPROVAL_BASE_URL to an origin reachable from inside the VM and " +
    "SWARM_SESSION_SECRET to sign its per-run token. Do not use the VM's 127.0.0.1 or " +
    "localhost for the host app: Docker Desktop normally uses host.docker.internal, while " +
    "Linux normally uses the Docker bridge gateway IP. See README.md for listener requirements."
  );
}

/** Throw the local Docker approval startup error, if one applies. */
export function assertLocalDockerApprovalConfiguration(vm: VmManager): void {
  const message = localDockerApprovalConfigurationError(vm);
  if (message) throw new Error(message);
}

/**
 * How long the in-VM hook waits for a verdict. Kept a few seconds above the
 * harness approval TTL so the harness's deny (the authoritative default)
 * arrives before the hook's last-resort local timeout.
 */
export function approvalHookTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  // Mirror ApprovalStore's TTL resolution (seconds first, then the legacy ms
  // variable) so the harness's deny always lands before the hook's own guard.
  const sec = Number(env.SWARM_APPROVAL_TIMEOUT_SEC);
  let ttlMs = 300_000;
  if (Number.isFinite(sec) && sec > 0) ttlMs = sec * 1000;
  else {
    const ms = Number(env.SWARM_APPROVAL_TIMEOUT_MS);
    if (Number.isFinite(ms) && ms > 0) ttlMs = ms;
  }
  return Math.min(Math.floor(ttlMs + 5_000), 3_500_000);
}

/**
 * Env the in-VM PreToolUse hook needs: where to call and the per-run token it
 * authenticates with. The token is the same short-lived run token the LLM
 * proxy uses, so it dies when the run finalizes.
 */
export function approvalHookEnv(baseUrl: string, runToken: string): Record<string, string> {
  return {
    SWARM_APPROVAL_URL: `${baseUrl}${APPROVAL_HOOK_PATH}`,
    SWARM_APPROVAL_TOKEN: runToken,
    SWARM_APPROVAL_TIMEOUT_MS: String(approvalHookTimeoutMs()),
  };
}

/**
 * Drop host credentials from a child environment, keeping the ones the
 * provider selection supplied. The server env holds session secrets, deploy
 * tokens and unrelated provider keys; none of them may reach agent-controlled
 * code in a user's VM. Every path that builds a runner env goes through this
 * helper (the runtime and the team lanes alike), so the rule stays in one
 * place.
 */
export function scrubHostCredentials(
  env: Record<string, string>,
  keep: Record<string, string> = {},
): Record<string, string> {
  const out = { ...env };
  for (const name of Object.keys(out)) {
    if (HOST_CREDENTIAL.test(name) && !(name in keep)) delete out[name];
  }
  return out;
}

/**
 * Env for a run with no provider selection. Local mode forwards the host
 * ANTHROPIC_* env untouched (legacy single-provider behaviour: the machine
 * belongs to its one user). Server mode strips host credentials, so an
 * account without providers of its own can never run on the host's keys.
 */
export function envFallback(): Record<string, string> {
  const env = buildRunnerEnv();
  if (!serverMode()) return env;
  return scrubHostCredentials(env);
}

/**
 * Point a provider selection's Claude env at the server-side LLM translation
 * endpoint when proxy mode is active. The provider's real key is replaced by
 * the per-run token — the raw key never enters the VM.
 */
export function safeVaultEnv(userId: string, runId: string, baseUrl: string | null): Record<string, string> {
  try {
    return vaultProxyEnv(userId, runId, baseUrl);
  } catch {
    return {};
  }
}

export function applyLlmProxyEnv(
  selection: ClaudeSelection,
  llmBaseUrl: string | null,
  runToken: string | null,
): Record<string, string> {
  if (!llmBaseUrl || !runToken) return selection.env;
  return {
    ...selection.env,
    // Claude Code appends /v1/messages itself, so the base stops at the token.
    ANTHROPIC_BASE_URL: `${llmBaseUrl}/api/runtime/llm/${runToken}`,
    ANTHROPIC_AUTH_TOKEN: runToken,
    ANTHROPIC_API_KEY: "",
  };
}

/** Build an AttemptInfo for one failed run attempt, for the failure summary. */
function recordToAttempt(record: FailoverRecord): AttemptInfo {
  return {
    provider: record.sel.provider,
    model: record.sel.model,
    keyId: record.sel.keyId,
    ok: false,
    kind: record.kind ?? "unknown",
    status: record.status,
    error: record.message,
    latencyMs: 0,
  };
}

/** Forward only the allowlisted provider env into the VM (valid POSIX names only). */
export function buildRunnerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const extra = new Set((env.SWARM_VM_ENV_ALLOW ?? "").split(",").map((n) => n.trim()).filter(Boolean));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!ENV_NAME.test(name) || name.startsWith("SWARM_")) continue;
    if (!ENV_ALLOW.test(name) && !extra.has(name)) continue;
    out[name] = value;
  }
  return out;
}

export class RuntimeManager {
  private readonly vm: VmManager;
  private readonly bus: TelemetryBus;
  private readonly reporter: RunReporter;
  /** Reads and builds codebase maps inside the user's own VM. */
  private readonly codebaseScanner: CodebaseScanner;
  private readonly runner = new ClaudeCodeRunner();
  private readonly users = new Map<string, UserState>();
  /**
   * Test override for the provider router Claude Code is pointed at. When
   * unset, each user gets a router over their own providers (see
   * effectiveRouter). `null` disables provider selection and falls back to
   * the host env (credentials stripped in server mode).
   */
  private readonly routerOverride: Router | null | undefined;
  /** Per-user routers, rebuilt when that user's saved providers change. */
  private readonly routers = new Map<string, { signature: string; router: Router }>();
  private readonly maxQueuedOverride: number | undefined;
  private readonly startGraceMs: number;
  private readonly silenceMs: number;
  private readonly watchdogSweepMs: number = 30_000;
  /**
   * Durable snapshot of active+queued work. Null in direct constructions
   * (unit tests stay isolated); the process-wide manager supplies the real
   * store so a restart restores the queue.
   */
  private readonly stateStore: RunStateStore | null;
  /**
   * Runs whose controller was aborted but whose execute promise has not yet
   * settled (their in-container process may still be dying). Kill escalation
   * keys on this; execute()'s finally removes entries. Never holds a slot.
   */
  private readonly cancelling = new Map<string, { userId: string; pgidFile?: string }>();

  constructor(opts: {
    vm?: VmManager;
    bus?: TelemetryBus;
    router?: Router | null;
    maxQueued?: number;
    /**
     * Watchdog thresholds, ms. Overridable so tests can exercise stuck runs
     * quickly; production uses the conservative defaults.
     */
    startGraceMs?: number;
    silenceMs?: number;
    /** Watchdog sweep cadence, ms (default 30s; minimum 20ms in tests). */
    watchdogSweepMs?: number;
    /** Test hook: inject the run-report reporter. */
    reporter?: RunReporter;
    /** Test hook: inject the codebase scanner (default: the user's VM). */
    codebaseScanner?: CodebaseScanner;
    /**
     * Durable active+queue snapshot. Omitted/null keeps this manager
     * memory-only (tests); the process-wide singleton passes the real store.
     */
    stateStore?: RunStateStore | null;
  } = {}) {
    this.vm = opts.vm ?? vmManager;
    this.bus = opts.bus ?? telemetryBus;
    this.reporter = opts.reporter ?? new RunReporter({ vm: this.vm, bus: this.bus });
    this.codebaseScanner = opts.codebaseScanner ?? createVmScanner(this.vm);
    this.routerOverride = opts.router === undefined ? undefined : opts.router;
    this.maxQueuedOverride = opts.maxQueued;
    this.startGraceMs = opts.startGraceMs ?? DEFAULT_START_GRACE_MS;
    this.silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
    this.watchdogSweepMs = Math.max(20, opts.watchdogSweepMs ?? 30_000);
    this.stateStore = opts.stateStore ?? null;

    // A previous process may have died mid-run; its persisted runs would
    // otherwise stay "running" forever. Finalize them as errors now, with a
    // run.error event appended to each orphaned run's log. Recovery writes
    // straight to the log (not via this.bus, whose per-process seq would
    // restart at 1 and corrupt the persisted ordering). It must never break
    // startup, so a failure here is logged and swallowed.
    let epochRecovered: string[] = [];
    try {
      epochRecovered = recoverOrphanedRuns();
    } catch (error) {
      console.error("[runtime] could not recover orphaned runs:", error);
    }
    // Any approval owned by a run the epoch sweep just killed is explicitly
    // expired (never silently reclassified as a denial).
    for (const runId of epochRecovered) {
      getApprovalStore().expireForRunRestart(runId);
    }
    // Restore the durable queue and abort the previous process's active run
    // (see design: resume is unsafe without a checkpoint; queued work is not
    // lost). This also covers runs the epoch sweep cannot prove are stale.
    this.restorePersistedState();

    // Stuck-run watchdog: periodically sweep active runs for ones that never
    // started or have gone entirely silent, and finalize them so the slot
    // always frees. unref'd so it never keeps the process alive by itself.
    const sweep = setInterval(() => this.scanWatchdogs(), this.watchdogSweepMs);
    sweep.unref();
  }

  /**
   * The router for one user's runs: only that user's providers and keys.
   * Routers are long-lived per user (key rotation and cooldowns carry across
   * runs) and their cooldown state is persisted to the user's own file, so a
   * restart does not hammer a rate-limited key and users never share state.
   */
  private effectiveRouter(userId: string): Router | null {
    if (this.routerOverride !== undefined) return this.routerOverride;
    const signature = `${userProvidersSignature(userId)}|${serverMode() ? "server" : "local"}|free:${readUserSettings(userId).preferFreeProviders}`;
    const cached = this.routers.get(userId);
    if (cached && cached.signature === signature) return cached.router;
    // Free-first: the router ranks providers by `rank`; orderLlmCandidates
    // puts the user's free providers first when their setting is on (rank stays
    // the order inside each group). Key rotation, cooldowns and budgets are the
    // router's, unchanged.
    //
    // The ordered position must BECOME the rank: Router re-sorts its
    // candidates by `rank`, so passing the reordered configs through
    // unchanged would undo the free-first order inside createRouter and the
    // toggle would still change nothing. (With the setting off the order is
    // already by rank, so stamping the position is a no-op.)
    const providers = orderLlmCandidates(routerProviders(userId), undefined, {
      preferFree: readUserSettings(userId).preferFreeProviders,
    }).map((candidate, index) => ({ ...candidate.config, rank: index }));
    const router = createRouter({
      providers,
      persistCooldowns: true,
      cooldownFile: userCooldownFilePath(userId),
    });
    this.routers.set(userId, { signature, router });
    return router;
  }

  /** The VM manager backing this runtime (used to wire the idle sweeper). */
  get vmManager(): VmManager {
    return this.vm;
  }

  /**
   * The provider router for one user (the same long-lived router the runs
   * use, so key cooldowns and budgets are shared). The LLM translation proxy
   * resolves providers through this; returns null when no router is
   * configured for the user.
   */
  routerForUser(userId: string): Router | null {
    return this.effectiveRouter(userId);
  }

  private state(userId: string): UserState {
    let s = this.users.get(userId);
    if (!s) {
      s = { active: null, queue: [], shellRuns: new Map(), history: [] };
      this.users.set(userId, s);
    }
    return s;
  }

  private maxQueued(): number {
    return this.maxQueuedOverride ?? maxQueuedFromEnv();
  }

  private activeToPersisted(active: ActiveRun): PersistedActiveRun {
    return {
      runId: active.runId,
      userId: active.userId,
      prompt: active.prompt,
      ...(active.agentCard ? { agentCard: active.agentCard } : {}),
      ...(active.sessionId ? { sessionId: active.sessionId } : {}),
      ...(active.model ? { model: active.model } : {}),
      ...(active.role ? { role: active.role } : {}),
      rolePolicy: active.rolePolicy,
      ...(active.projectId ? { projectId: active.projectId } : {}),
      ...(active.contextPrefix ? { contextPrefix: active.contextPrefix } : {}),
      ...(active.compute ? { compute: active.compute } : {}),
      ...(active.fullAuto !== undefined ? { fullAuto: active.fullAuto } : {}),
      ...(active.runMode ? { runMode: active.runMode } : {}),
      createdAt: active.createdAt,
      ...(active.startedAt !== undefined ? { startedAt: active.startedAt } : {}),
      ...(active.resumePoint ? { resumePoint: active.resumePoint } : {}),
    };
  }

  private queuedToPersisted(run: QueuedRun): PersistedQueuedRun {
    return {
      runId: run.runId,
      userId: run.userId,
      prompt: run.prompt,
      ...(run.agentCard ? { agentCard: run.agentCard } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(run.role ? { role: run.role } : {}),
      rolePolicy: run.rolePolicy,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      ...(run.projectContext ? { projectContext: run.projectContext } : {}),
      ...(run.compute ? { compute: run.compute } : {}),
      ...(run.fullAuto !== undefined ? { fullAuto: run.fullAuto } : {}),
      ...(run.runMode ? { runMode: run.runMode } : {}),
      createdAt: run.createdAt,
    };
  }

  /**
   * Snapshot every user with live work. Synchronous: a queue transition is
   * only acknowledged after its durable copy exists. Best-effort so an
   * unwritable volume never blocks a run.
   */
  private persistState(): void {
    if (!this.stateStore) return;
    const users: Record<string, PersistedUserState> = Object.create(null) as Record<
      string,
      PersistedUserState
    >;
    for (const [userId, st] of this.users) {
      if (!st.active && st.queue.length === 0) continue;
      users[userId] = {
        active: st.active ? this.activeToPersisted(st.active) : null,
        queue: st.queue.map((run) => this.queuedToPersisted(run)),
      };
    }
    this.stateStore.save(users);
  }

  /**
   * Restore the previous process's queue and resolve its active run.
   *
   * Active run: safe-abort-and-notify. A restart kills the VM exec and there
   * is no reliable checkpoint of side effects already performed, so re-running
   * the prompt could duplicate them. The run is finalized as an error with the
   * shared "server restarted" reason (visible in run history), and any pending
   * approval it owned is explicitly expired with reason "server_restart".
   *
   * Queued prompts: fully preserved and drained through the normal one-at-a-
   * time path, so nothing accepted before the restart disappears.
   */
  private restorePersistedState(): void {
    if (!this.stateStore) return;
    let persisted: PersistedRuntimeState;
    try {
      persisted = this.stateStore.load();
    } catch (error) {
      console.error("[runtime] could not read persisted run state:", error);
      return;
    }
    for (const [userId, row] of Object.entries(persisted.users)) {
      const st = this.state(userId);
      for (const queued of row.queue) {
        if (st.queue.some((run) => run.runId === queued.runId)) continue;
        // A prompt that actually reached a terminal state before the process
        // died must not be replayed (the snapshot write may lag a finish).
        const status = getRun(queued.runId)?.summary.status;
        if (status && status !== "queued" && status !== "running") continue;
        st.queue.push({
          runId: queued.runId,
          userId,
          prompt: queued.prompt,
          ...(queued.agentCard ? { agentCard: queued.agentCard } : {}),
          ...(queued.sessionId ? { sessionId: queued.sessionId } : {}),
          ...(queued.model ? { model: queued.model } : {}),
          ...(queued.role ? { role: queued.role } : {}),
          rolePolicy: queued.rolePolicy,
          ...(queued.projectId ? { projectId: queued.projectId } : {}),
          ...(queued.projectContext ? { projectContext: queued.projectContext } : {}),
          ...(queued.compute ? { compute: queued.compute } : {}),
          ...(queued.fullAuto !== undefined ? { fullAuto: queued.fullAuto } : {}),
          ...(queued.runMode ? { runMode: queued.runMode } : {}),
          createdAt: queued.createdAt,
        });
      }
      if (row.active) {
        try {
          recoverRunOnRestart(row.active.runId, {
            userId,
            prompt: row.active.prompt,
            compute: row.active.compute,
            createdAt: row.active.createdAt,
            resumePoint: row.active.resumePoint,
          });
        } catch (error) {
          console.error(`[runtime] could not finalize interrupted run ${row.active.runId}:`, error);
        }
        // The run is dead; a pending approval for it can never be actioned.
        // Record the explicit restart outcome instead of letting the TTL
        // silently deny it later.
        getApprovalStore().expireForRunRestart(row.active.runId);
      }
      if (!st.active && st.queue.length > 0) this.startNext(userId);
    }
    // Normalize the file (drop terminal queue entries, clear the aborted
    // active run) so the next restart sees a clean snapshot.
    this.persistState();
  }

  /** Refresh a run's heartbeat (called on any telemetry it produces). */
  private touchActivity(active: ActiveRun): void {
    active.lastActivityAt = Date.now();
  }

  /**
   * Watchdog sweep: finalize active runs that are stuck. A run is stuck when
   * it never emitted run.started within startGraceMs, or when it has been
   * entirely silent (no telemetry at all) for silenceMs after starting. Both
   * are generous so a long single tool call (e.g. an agent looping with
   * sleep) is never mistaken for a hang; they exist to break a wedged exec
   * stream or a process that exited without releasing the slot.
   */
  private scanWatchdogs(): void {
    const now = Date.now();
    for (const [userId, st] of this.users) {
      const active = st.active;
      if (!active) continue;
      const elapsed = now - active.lastActivityAt;
      const neverStarted = active.startedAt === undefined;
      const stuck =
        (neverStarted && elapsed >= this.startGraceMs) ||
        (!neverStarted && elapsed >= this.silenceMs);
      if (!stuck) continue;
      const reason = neverStarted
        ? "run did not start and was stopped by the watchdog"
        : "run was silent for too long and was stopped by the watchdog";
      const errorEvent: { type: "run.error"; message: string } = {
        type: "run.error",
        message: reason,
      };
      this.bus.publish(active.runId, errorEvent);
      this.finalize(active.runId, { status: "error", error: reason });
      active.controller.abort();
      this.recordCancelling(userId, active.runId, active.pgidFile);
    }
  }

  /**
   * Remember a run whose process tree may still be dying after abort. The
   * slot itself is freed immediately (finalize ran before the abort), so this
   * only guards the process side: if after the grace period nothing has taken
   * the slot, the container's leftover processes can only belong to the
   * cancelled run and are hard-killed. When a successor run already started,
   * the wedge is broken and killing anything would risk the wrong process.
   */
  private recordCancelling(userId: string, runId: string, pgidFile?: string): void {
    this.cancelling.set(runId, { userId, pgidFile });
    const timer = setTimeout(() => {
      const entry = this.cancelling.get(runId);
      if (!entry) return;
      this.cancelling.delete(runId);
      if (this.users.get(userId)?.active !== null) return;
      void this.killRunTree(entry.userId, entry.pgidFile);
    }, KILL_GRACE_MS);
    timer.unref();
  }

  /**
   * Hard-kill leftover processes of one cancelled run — its own process
   * group only. The agent exec runs in its own session (setsid) with its
   * pgid recorded in the run's marker file, so this SIGKILLs exactly that
   * group. It never targets children of PID 1: in desktop VMs PID 1 is
   * supervisord, whose children are XFCE/x11vnc/noVNC/Chromium — the old
   * `pkill -KILL -P 1` killed the user's entire desktop session on every
   * cancel. When the marker file is already gone the group died with the
   * abort (or the exec never started) and there is nothing to kill.
   *
   * Residual gap, stated plainly: a process that ignored the abort-time
   * SIGTERM has its marker removed by the abort cleanup, and a process the
   * agent detached from its own group (re-parented to PID 1) is
   * indistinguishable from a desktop daemon — neither is reaped here.
   */
  private async killRunTree(userId: string, pgidFile?: string): Promise<void> {
    // No recorded group: there is nothing safe to target, so do nothing
    // rather than fall back to a broad kill.
    if (!pgidFile) return;
    try {
      if (this.users.get(userId)?.active !== null) return;
      await this.vm.ensure(userId);
      if (this.users.get(userId)?.active !== null) return;
      await this.vm.exec(userId, buildPgidKillCommand(pgidFile), {
        timeoutMs: KILL_TIMEOUT_MS,
        signal: AbortSignal.timeout(KILL_TIMEOUT_MS),
      });
    } catch {
      // Best-effort only; the watchdog finalization already freed the slot.
    }
  }

  /**
   * Resolve the role a run should start under. Omitted or "main" resolves to
   * the user's Main Agent role; any other id must exist in the user's catalog
   * (built-ins + their custom roles). Unknown ids are rejected — this is the
   * user-facing half of the role validation; agent-initiated switches go
   * through resolveRoleSwitch with the same catalog.
   */
  private resolveRole(userId: string, roleId?: string): RoleDefinition {
    const catalog = userRoleCatalog(userId);
    const requested = roleId && roleId.trim() ? roleId.trim() : DEFAULT_ROLE_ID;
    const role = catalog.find((candidate) => candidate.id === requested);
    if (!role) {
      throw new Error(`Unknown role "${requested}".`);
    }
    return normalizeRoleDefinition(role) ?? role;
  }

  /**
   * Resolve how this run should behave before the VM is touched. The first
   * routed provider/model decides; if no provider is configured we stay
   * conservative (text mode, no desktop tools) and the run will surface the
   * usual "no providers" error later.
   */
  private modeFor(userId: string, model?: string): RunModeInfo {
    let provider: string | undefined;
    let modelId: string | undefined = model;
    let capabilities = CONSERVATIVE_CAPABILITIES;
    try {
      const settings = readUserSettings(userId);
      const candidates = orderLlmCandidates(routerProviders(userId), model, {
        preferFree: settings.preferFreeProviders,
      });
      const first = candidates[0];
      if (first) {
        provider = first.config.id;
        modelId = first.model;
        capabilities = mergedModelCapabilities(first.config, first.model);
      }
    } catch {
      // A broken provider store must not block the run-mode badge.
    }
    return runModeForCapabilities(capabilities, {
      desktopEnabled: desktopModeEnabled(),
      ...(provider ? { provider } : {}),
      ...(modelId ? { model: modelId } : {}),
    });
  }

  private publishMode(runId: string, info: RunModeInfo): void {
    this.bus.publish(runId, {
      type: "run.mode",
      data: {
        mode: info.mode,
        label: info.label,
        reason: info.reason,
        ...(info.provider ? { provider: info.provider } : {}),
        ...(info.model ? { model: info.model } : {}),
      },
    });
  }

  /**
   * Refine the run mode from the provider actually selected for an attempt.
   * Failover can move a run between models, so the mode is recomputed before
   * each phase and republished when it changes.
   */
  private modeForSelection(active: ActiveRun, provider?: string, model?: string): RunModeInfo {
    const fallback = active.runMode ?? this.modeFor(active.userId, active.model);
    if (!provider || !model) return fallback;
    const config = routerProviders(active.userId).find((c) => c.id === provider);
    if (!config) return fallback;
    const info = runModeForCapabilities(mergedModelCapabilities(config, model), {
      desktopEnabled: desktopModeEnabled(),
      provider,
      model,
    });
    if (
      !active.runMode ||
      active.runMode.mode !== info.mode ||
      active.runMode.reason !== info.reason
    ) {
      active.runMode = info;
      this.publishMode(active.runId, info);
    }
    return info;
  }

  /** The harness phase (argv config) for a role, plus account library MCP grants. */
  private rolePhaseFor(
    role: RoleDefinition,
    extraAllowedTools: readonly string[] = [],
    mode?: RunModeInfo,
    restrictTools?: readonly string[],
  ): RolePhase {
    const gui = mode === undefined || mode.mode === "gui";
    const phase = rolePhase(role, {
      desktopMode: desktopModeEnabled() && gui,
      tools: mode === undefined || mode.mode !== "chat",
    });
    if (restrictTools) {
      const allow = new Set(restrictTools);
      phase.allowedTools = phase.allowedTools.filter((tool) => allow.has(tool));
    } else if (extraAllowedTools.length > 0) {
      phase.allowedTools = [...new Set([...phase.allowedTools, ...extraAllowedTools])];
    }
    return phase;
  }

  /**
   * Freeze the per-run role policy. The baseline is the run's starting role
   * (or the Main Agent for legacy un-role'd runs); pre-grants are intersected
   * with the user's own catalog.
   */
  private rolePolicyFor(
    userId: string,
    role: RoleDefinition | undefined,
    grantedRoleIds?: readonly string[],
  ): RunRolePolicy {
    const catalog = userRoleCatalog(userId);
    const baseline =
      role ??
      catalog.find((candidate) => candidate.id === DEFAULT_ROLE_ID) ??
      BUILTIN_ROLES.find((candidate) => candidate.id === DEFAULT_ROLE_ID) ??
      BUILTIN_ROLES[0];
    return buildRunRolePolicy(catalog, baseline, grantedRoleIds ?? []);
  }

  /** The harness phase for the default Main Agent role (used when no role is set). */
  private defaultRolePhase(
    extraAllowedTools: readonly string[] = [],
    mode?: RunModeInfo,
    restrictTools?: readonly string[],
  ): RolePhase {
    const main = BUILTIN_ROLES.find((role) => role.id === DEFAULT_ROLE_ID) ?? BUILTIN_ROLES[0];
    return this.rolePhaseFor(main, extraAllowedTools, mode, restrictTools);
  }

  /**
   * The account's long-term memory for one run: the facts most relevant to
   * the prompt, rendered as the block that rides in the system prompt.
   * Returns an empty string when the account has no memory yet.
   */
  private async memoryContextFor(userId: string, prompt: string): Promise<string> {
    try {
      const context = await memoryContextForPrompt(userId, prompt);
      return buildMemoryPrompt(context);
    } catch {
      // A memory lookup must never break a run.
      return "";
    }
  }

  /**
   * Seed the role-switch MCP server script, the role catalog JSON and the
   * per-role --mcp-config into the user's VM before a role-driven run starts.
   * All writes go through the VM file API — never shell strings. The account's
   * installed Library is seeded too: skills into .claude/skills and custom
   * tools/MCP servers into the same --mcp-config.
   */
  private async seedRoleFiles(
    userId: string,
    catalog: readonly RoleDefinition[],
    allowedRoleIds: ReadonlySet<string>,
    initialPhase: RolePhase,
    extraMcpServers: Record<string, unknown>,
    mode?: RunModeInfo,
  ): Promise<void> {
    const gui = mode === undefined || mode.mode === "gui";
    // A run aborted mid-question leaves its .pending.json behind; the new
    // run's question gateway would otherwise adopt the orphan as its own
    // (waitForPendingQuestion takes the newest unseen pending file). Clear
    // them first. Best-effort: a missing dir already means "nothing to do"
    // (rm -f exits 0), and a failure here must never block the run.
    try {
      await this.vm.exec(userId, ["sh", "-c", `rm -f ${ASK_QUESTIONS_DIR}/*.pending.json`], {
        timeoutMs: 10_000,
      });
    } catch {
      // ignore: the gateway tolerates a leftover file via its seen set.
    }
    for (const file of roleSeedFiles(catalog, allowedRoleIds, initialPhase, {
      desktopMode: desktopModeEnabled() && gui,
      codebaseRepoRoot: WORKSPACE_ROOT,
      extraMcpServers,
    })) {
      await this.vm.writeFile(userId, file.path, file.content);
    }
    const libraryFiles = librarySeedFiles(userId);
    await cleanupLibrarySeedFiles(this.vm, userId, libraryFiles);
    for (const file of libraryFiles) {
      await this.vm.writeFile(userId, file.path, file.content);
    }
  }

  /** Rewrite the VM's --mcp-config for the given role phase. */
  private async writeRoleConfig(
    userId: string,
    role: RoleDefinition,
    allowedRoleIds: ReadonlySet<string>,
    extraAllowedTools: readonly string[],
    extraMcpServers: Record<string, unknown>,
    mode?: RunModeInfo,
    restrictTools?: readonly string[],
  ): Promise<void> {
    const gui = mode === undefined || mode.mode === "gui";
    await this.vm.writeFile(
      userId,
      ROLE_MCP_CONFIG_PATH,
      roleMcpConfigJson(this.rolePhaseFor(role, extraAllowedTools, mode, restrictTools), {
        allowedRoleIds,
        roleDef: role,
        desktopMode: desktopModeEnabled() && gui,
        codebaseRepoRoot: WORKSPACE_ROOT,
        extraMcpServers,
      }),
    );
  }

  /**
   * Start a run for a user. If the user already has an active run the prompt
   * is queued (FIFO) instead of superseding it, up to SWARM_MAX_QUEUED. A
   * queued prompt emits run.queued with its 1-based position and starts
   * automatically when the active run finishes. Returns the runId
   * immediately; execution proceeds in the background and events stream
   * through the telemetry bus.
   */
  start(
    userId: string,
    input: {
      prompt: string;
      agentCard?: string;
      sessionId?: string;
      model?: string;
      roleId?: string;
      /**
       * Roles the user explicitly pre-granted for this run (composer run
       * settings). Unknown ids (or ids outside the user's catalog) are
       * ignored, so this can never widen a run past the user's own roles.
       */
      grantedRoleIds?: string[];
      /** Project this run belongs to; its digest is injected on a fresh thread. */
      projectId?: string;
      projectContext?: string;
      /** "cloud" for the server VM pool (paired computers are dispatched separately). */
      computeTarget?: "cloud";
      /**
       * g9 full-auto: auto-approve in-VM asks but keep hard-deny and
       * irreversible-external actions blocked. Defaults to SWARM_FULL_AUTO=1.
       *
       * The minimal main page sends this as `autoApprove`: deny decisions,
       * including the unconditional VM-only policy, still halt the run.
       */
      fullAuto?: boolean;
      /** F14: exact PreToolUse tool names. Omit for the normal policy. */
      toolAllowlist?: readonly string[];
      /** F14 watcher rule that started this run. */
      ambientRuleId?: string;
      /**
       * F1 fork seed: VM snapshot label to restore when this run starts.
       * Only set by fork(); a run created any other way never restores.
       */
      seedSnapshotLabel?: string;
      /** F1 fork provenance: the run + checkpoint this run was forked from. */
      forkedFrom?: ForkInfo;
      /**
       * F1 fork: start a fresh conversation instead of resuming the user's
       * last session. A fork continues from a checkpoint's workspace, not
       * from the original run's later conversation, so resuming that session
       * would hand the agent history that contradicts the restored state.
       */
      freshSession?: boolean;
    },
  ): StartResult {
    const configurationError = localDockerApprovalConfigurationError(this.vm);
    if (configurationError) {
      return { accepted: false, runId: "", queued: false, error: configurationError };
    }
    const runId = `run_${randomUUID()}`;
    const st = this.state(userId);
    const fullAuto = input.fullAuto ?? process.env.SWARM_FULL_AUTO === "1";
    const runMode = this.modeFor(userId, input.model);

    let role: RoleDefinition | undefined;
    if (input.roleId !== undefined && input.roleId.trim() !== "") {
      try {
        role = this.resolveRole(userId, input.roleId);
      } catch (error) {
        return {
          accepted: false,
          runId: "",
          queued: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // The explicit per-run policy is frozen here: the starting role plus its
    // capability subsets, then the user's pre-grants (intersected with the
    // catalog). Nothing downstream can widen it except a user approval.
    const rolePolicy = this.rolePolicyFor(userId, role, input.grantedRoleIds);

    if (st.active) {
      const limit = this.maxQueued();
      if (st.queue.length >= limit) {
        return { accepted: false, runId: "", queued: false, limit };
      }
      const queued: QueuedRun = {
        runId,
        userId,
        prompt: input.prompt,
        agentCard: input.agentCard,
        sessionId: input.sessionId,
        model: input.model,
        role,
        rolePolicy,
        projectId: input.projectId,
        projectContext: input.projectContext,
        compute: { kind: "cloud" },
        fullAuto,
        toolAllowlist: input.toolAllowlist,
        ambientRuleId: input.ambientRuleId,
        runMode,
        seedSnapshotLabel: input.seedSnapshotLabel,
        forkedFrom: input.forkedFrom,
        freshSession: input.freshSession,
        createdAt: Date.now(),
      };
      st.queue.push(queued);
      const position = st.queue.length;
      this.bus.publish(runId, {
        type: "run.created",
        data: {
          prompt: truncate(input.prompt, SUMMARY_PROMPT_LEN),
          sessionId: input.sessionId,
          userId,
          ...(input.model ? { model: input.model } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
          compute: { kind: "cloud" },
          mode: runMode.mode,
          modeLabel: runMode.label,
          modeReason: runMode.reason,
        },
      });
      this.publishMode(runId, runMode);
      this.bus.publish(runId, {
        type: "run.queued",
        data: { position, prompt: truncate(input.prompt, SUMMARY_PROMPT_LEN), userId },
      });
      this.persistState();
      return { accepted: true, runId, queued: true, position };
    }

    const persistedSession =
      input.sessionId === undefined && !input.freshSession ? getLastSession(userId) : undefined;
    const sessionId = input.sessionId ?? persistedSession;
    const active: ActiveRun = {
      runId,
      userId,
      controller: new AbortController(),
      prompt: input.prompt,
      pgidFile: execPgidPath(runId),
      initialPrompt: input.prompt,
      agentCard: input.agentCard,
      sessionId,
      model: input.model,
      role,
      rolePolicy,
      projectId: input.projectId,
      // Resume only on a genuinely fresh thread: continuing a session already
      // carries the project context in its own history.
      contextPrefix: sessionId ? undefined : input.projectContext,
      compute: { kind: "cloud" },
      runMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      fullAuto,
      toolAllowlist: input.toolAllowlist,
      ambientRuleId: input.ambientRuleId,
      seedSnapshotLabel: input.seedSnapshotLabel,
      forkedFrom: input.forkedFrom,
    };
    st.active = active;

    this.bus.publish(runId, {
      type: "run.created",
      data: {
        prompt: truncate(input.prompt, SUMMARY_PROMPT_LEN),
        sessionId: input.sessionId,
        userId,
        ...(input.model ? { model: input.model } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
        compute: { kind: "cloud" },
        mode: runMode.mode,
        modeLabel: runMode.label,
        modeReason: runMode.reason,
      },
    });
    this.publishMode(runId, runMode);
    this.persistState();

    void this.execute(active);
    return { accepted: true, runId, queued: false };
  }

  /**
   * F1 "Fork Run from Here": spawn a new run seeded from one of
   * `sourceRunId`'s auto-checkpoints (`auto-pre-step-<seq>`).
   *
   * The fork is a genuinely new run — own runId, fresh conversation (see
   * `freshSession`), own snapshot lineage — so the original run's telemetry
   * and artifacts are untouched: the fork writes only to its own run log,
   * and its checkpoints land under its own runId-prefixed VM labels.
   *
   * The seed restore does NOT happen here: it waits until the fork actually
   * starts (in executeInner), so forking a still-running run only queues
   * behind it and never clobbers the VM under the original. A missing
   * checkpoint is refused up front rather than failing at start time.
   */
  async fork(
    userId: string,
    input: {
      sourceRunId: string;
      /** Step seq (number) or display label ("auto-pre-step-12"). */
      checkpoint: number | string;
      prompt: string;
      model?: string;
      fullAuto?: boolean;
    },
  ): Promise<StartResult & { sourceRunId?: string; checkpointLabel?: string }> {
    const refused = (error: string): StartResult => ({ accepted: false, runId: "", queued: false, error });
    if (!input.prompt.trim()) return refused("prompt is required");
    if (!this.ownsRun(userId, input.sourceRunId)) return refused("Run not found.");
    const stepSeq = resolveCheckpointStepSeq(input.checkpoint);
    if (stepSeq === null) {
      return refused("checkpoint must be a step number or an auto-pre-step-<n> label");
    }
    const checkpointLabel = checkpointDisplayLabel(stepSeq);
    const vmLabel = checkpointVmLabel(input.sourceRunId, stepSeq);
    let snapshots: { label: string }[];
    try {
      snapshots = await this.vm.listSnapshots(userId);
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error));
    }
    if (!snapshots.some((snapshot) => snapshot.label === vmLabel)) {
      return refused(`Checkpoint ${checkpointLabel} not found for run ${input.sourceRunId}.`);
    }
    const started = this.start(userId, {
      prompt: input.prompt,
      model: input.model,
      fullAuto: input.fullAuto,
      seedSnapshotLabel: vmLabel,
      forkedFrom: { runId: input.sourceRunId, checkpointLabel, stepSeq },
      freshSession: true,
    });
    if (!started.accepted) return started;
    return { ...started, sourceRunId: input.sourceRunId, checkpointLabel };
  }

  /** Move the next queued prompt into the active slot and execute it. */
  private startNext(userId: string): void {
    const st = this.users.get(userId);
    if (!st || st.active) return;
    const next = st.queue.shift();
    if (!next) return;
    const persistedSession =
      next.sessionId === undefined && !next.freshSession ? getLastSession(userId) : undefined;
    const sessionId = next.sessionId ?? persistedSession;
    const active: ActiveRun = {
      runId: next.runId,
      userId,
      controller: new AbortController(),
      prompt: next.prompt,
      pgidFile: execPgidPath(next.runId),
      initialPrompt: next.prompt,
      agentCard: next.agentCard,
      sessionId,
      model: next.model,
      role: next.role,
      rolePolicy: next.rolePolicy,
      projectId: next.projectId,
      // The active run may have just created the session this prompt continues.
      contextPrefix: sessionId ? undefined : next.projectContext,
      compute: next.compute ?? { kind: "cloud" },
      runMode: next.runMode,
      createdAt: next.createdAt,
      lastActivityAt: Date.now(),
      fullAuto: next.fullAuto,
      toolAllowlist: next.toolAllowlist,
      ambientRuleId: next.ambientRuleId,
      seedSnapshotLabel: next.seedSnapshotLabel,
      forkedFrom: next.forkedFrom,
    };
    st.active = active;
    this.persistState();
    if (next.runMode) this.publishMode(next.runId, next.runMode);
    void this.execute(active);
  }

  /** All runs for a user: active agent run, queued prompts, shell runs, then history. */
  list(userId: string): RunSummary[] {
    const st = this.state(userId);
    const out: RunSummary[] = [];
    if (st.active) {
      out.push({ ...this.baseSummary(st.active), status: "running", lastSeq: this.bus.latestSeq(st.active.runId) });
    }
    st.queue.forEach((run, index) => {
      out.push({
        runId: run.runId,
        userId,
        status: "queued",
        prompt: run.prompt,
        sessionId: run.sessionId,
        model: run.model,
        compute: run.compute ?? { kind: "cloud" },
        createdAt: run.createdAt,
        lastSeq: this.bus.latestSeq(run.runId),
        kind: "agent",
        position: index + 1,
        ...(run.runMode
          ? { mode: run.runMode.mode, modeReason: run.runMode.reason }
          : {}),
        ...(run.forkedFrom ? { forkedFrom: run.forkedFrom } : {}),
      });
    });
    for (const run of st.shellRuns.values()) {
      out.push({
        runId: run.runId,
        userId,
        status: "running",
        prompt: run.prompt,
        createdAt: run.createdAt,
        lastSeq: this.bus.latestSeq(run.runId),
        kind: "shell",
      });
    }
    for (const h of st.history) {
      out.push({
        ...h,
        lastSeq: this.bus.latestSeq(h.runId),
        // Compact report-card counts when the run's report already exists (it
        // is created asynchronously when the run reaches its terminal state).
        report: readReportMeta(h.runId) ?? undefined,
      });
    }
    return out;
  }

  /**
   * True when `runId` belongs to `userId`. Checks the live in-memory state
   * first (agent runs and in-flight shell runs), then the durable run log so
   * ownership survives a restart.
   */
  ownsRun(userId: string, runId: string): boolean {
    const st = this.users.get(userId);
    if (st?.active?.runId === runId) return true;
    if (st?.queue.some((run) => run.runId === runId)) return true;
    if (st?.shellRuns.has(runId)) return true;
    if (st?.history.some((run) => run.runId === runId)) return true;
    if (ownsTeamRun(userId, runId)) return true;
    return getRun(runId)?.summary.userId === userId;
  }

  /**
   * True when `runId` is the user's currently running (active) run. Browser
   * control is only available for live runs — the browser exists for the
   * agent, not as a standalone tool.
   */
  isActiveRun(userId: string, runId: string): boolean {
    const st = this.users.get(userId);
    if (st?.active?.runId === runId) return true;
    return isTeamRunActive(runId) && ownsTeamRun(userId, runId);
  }

  /**
   * Decide one tool call synchronously for the in-VM PreToolUse hook.
   *
   * This is the authoritative gate: the CLI is blocked awaiting this answer,
   * so allow means the tool may execute and deny means it never does. Ask
   * creates the same approval record the UI renders (and waits for
   * POST /api/runtime/approvals/{id}); the 300s TTL default is a deny.
   */
  async requestToolApproval(
    userId: string,
    runId: string,
    toolName: string,
    input: unknown,
  ): Promise<ToolApprovalDecision> {
    const active = this.users.get(userId)?.active;
    if (!active || active.runId !== runId) {
      // Team lanes own their own event stream and approval records; their
      // harness registers a handler for the life of the lane.
      const delegated = requestRegisteredApproval(userId, runId, toolName, input);
      if (delegated) return delegated;
      return { decision: "deny", reason: "run is not active" };
    }

    if (active.toolAllowlist && !active.toolAllowlist.includes(toolName)) {
      const reason = `Blocked by ambient watcher allowlist: ${toolName} is not permitted`;
      this.forwardEvent(active, { type: "tool.blocked", name: toolName, reason });
      return { decision: "deny", reason };
    }

    return evaluateToolApproval({
      toolName,
      input,
      emit: (event) => this.forwardEvent(active, event),
      fullAuto: active.fullAuto === true,
      signal: active.controller.signal,
      // Pattern-based scrubbing only: the run's secret env lives in the
      // runner, not here, and the action text is still redacted for shapes.
      redact: makeRedactor({}),
      // F1: an ask-classified call that is cleared to execute gets a
      // checkpoint first, so the mutation it precedes has a branch point.
      takeCheckpoint: () => this.takeAutoCheckpoint(userId, runId),
      createApproval: (ask) => {
        const approval = getApprovalStore().create({
          runId,
          userId,
          toolName: ask.toolName,
          action: ask.action,
          reason: ask.reason,
        });
        return {
          id: approval.id,
          expiresAt: approval.expiresAt,
          timedOut: () => getApprovalStore().get(approval.id)?.timedOut === true,
          verdict: getApprovalStore().waitFor(approval.id),
        };
      },
    });
  }

  /**
   * F1 auto-checkpoint: snapshot the VM right before an ask-classified
   * high-impact tool call executes. The label is `auto-pre-step-<seq>` where
   * `<seq>` is the bus sequence the checkpoint event itself will take, so the
   * checkpoint sits directly before the tool call it guards in the timeline.
   * Only ask-level verdicts reach this hook — allow-classified calls never
   * snapshot, keeping the checkpoint stream bounded to real branch points.
   *
   * Never throws: a snapshot failure is returned as `{ok:false}` so the run
   * continues and the failure surfaces as `checkpoint.failed` telemetry
   * instead of silently vanishing — or blocking the agent's work.
   *
   * Uses `snapshotDuringRun`, not `snapshot`: the gate runs inside the
   * agent's long-lived claude exec, which holds the VM read lock, so a
   * write-lock snapshot here would deadlock (see VmManager.snapshotDuringRun).
   * The outcome shaping lives in `takeRunCheckpoint` (lib/runtime/
   * checkpoints.ts), shared with team lanes — see `createCheckpointTaker`
   * for the lane-side hook, which counts its own steps because lanes never
   * publish to this manager's bus.
   */
  private async takeAutoCheckpoint(userId: string, runId: string): Promise<CheckpointOutcome> {
    const outcome = await takeRunCheckpoint(
      (vmLabel) => this.vm.snapshotDuringRun(userId, vmLabel),
      runId,
      this.bus.latestSeq(runId) + 1,
    );
    if (outcome.ok) {
      const active = this.users.get(userId)?.active;
      if (active && active.runId === runId) {
        active.resumePoint = {
          runId,
          checkpointLabel: outcome.label,
          stepSeq: outcome.stepSeq,
          ...(active.sessionId ? { sessionId: active.sessionId } : {}),
        };
        this.persistState();
      }
    }
    return outcome;
  }

  /**
   * Cancel the user's work. With runId omitted, cancels the running run (if
   * any) and every queued prompt behind it. With runId matching the active
   * run, cancels just that run — queued prompts stay and the next one starts
   * immediately once the slot frees. With runId matching a queued prompt,
   * removes just that item. Returns ok:false when there is nothing matching.
   * The optional reason is recorded on the cancelled runs (default "user").
   */
  cancel(
    userId: string,
    runId?: string,
    reason: "user" | "superseded" | "shutdown" = "user",
  ): { ok: boolean; runId?: string } {
    const st = this.state(userId);

    if (runId === undefined) {
      const queued = st.queue.splice(0, st.queue.length);
      for (const run of queued) {
        this.finalizeQueued(userId, run, { status: "cancelled", cancelledReason: reason });
      }
      const target = st.active;
      if (!target) return queued.length > 0 ? { ok: true, runId: queued[0].runId } : { ok: false };
      // Queue is empty, so finishing the active run cannot start another one.
      const pgidFile = target.pgidFile;
      this.finalize(target.runId, { status: "cancelled", cancelledReason: reason });
      target.controller.abort();
      this.recordCancelling(userId, target.runId, pgidFile);
      return { ok: true, runId: target.runId };
    }

    if (st.active?.runId === runId) {
      // Cancel only this run; leave the queue intact so the next queued
      // prompt starts the moment the slot frees (finalize -> startNext).
      const controller = st.active.controller;
      const pgidFile = st.active.pgidFile;
      this.finalize(runId, { status: "cancelled", cancelledReason: reason });
      controller.abort();
      this.recordCancelling(userId, runId, pgidFile);
      return { ok: true, runId };
    }

    const index = st.queue.findIndex((run) => run.runId === runId);
    if (index === -1) return { ok: false };
    const [removed] = st.queue.splice(index, 1);
    this.finalizeQueued(userId, removed, { status: "cancelled", cancelledReason: reason });
    return { ok: true, runId: removed.runId };
  }

  /** Finalize a prompt that never started as cancelled and add it to history. */
  private finalizeQueued(
    userId: string,
    run: QueuedRun,
    patch: { status: "cancelled"; cancelledReason: "user" | "superseded" | "shutdown" },
  ): void {
    const cancelledEvent: { type: "run.cancelled"; reason: "user" | "superseded" | "shutdown" } = {
      type: "run.cancelled",
      reason: patch.cancelledReason,
    };
    this.bus.publish(run.runId, cancelledEvent);
    const summary: RunSummary = {
      runId: run.runId,
      userId,
      status: patch.status,
      prompt: run.prompt,
      sessionId: run.sessionId,
      model: run.model,
      createdAt: run.createdAt,
      finishedAt: Date.now(),
      cancelledReason: patch.cancelledReason,
      lastSeq: this.bus.latestSeq(run.runId),
      kind: "agent",
      ...(run.runMode
        ? { mode: run.runMode.mode, modeReason: run.runMode.reason }
        : {}),
    };
    const st = this.users.get(userId);
    if (!st) return;
    st.history.unshift(summary);
    if (st.history.length > HISTORY_LIMIT) st.history.length = HISTORY_LIMIT;
    this.persistState();
  }

  /**
   * Cancel an in-flight terminal command. The run must be one of the user's
   * own active shell runs. Finalize before aborting so the exec rejection
   * cannot overwrite the explicit cancellation with a generic run.error.
   */
  cancelShell(userId: string, runId: string): { ok: boolean; runId?: string } {
    const run = this.users.get(userId)?.shellRuns.get(runId);
    if (!run) return { ok: false };
    this.finalizeShell(runId, { status: "cancelled", cancelledReason: "user" });
    run.controller.abort();
    return { ok: true, runId };
  }

  /**
   * Cancel every user's active run with the given reason (default
   * "shutdown"). Used by the graceful-shutdown handler so a SIGTERM during a
   * deploy drops no in-flight telemetry. Returns the cancelled runIds.
   */
  cancelAll(reason: "user" | "superseded" | "shutdown" = "shutdown"): string[] {
    const cancelled: string[] = [];
    for (const userId of [...this.users.keys()]) {
      if (reason === "shutdown") {
        // A deploy must not discard work the user already queued. Cancel only
        // the active run (reason "shutdown") and leave the queue in the
        // durable snapshot; the next process restores and drains it. The
        // normal finalize would immediately start the next prompt, which is
        // exactly what a process that is about to exit must not do.
        const st = this.users.get(userId);
        const target = st?.active;
        if (!st || !target) continue;
        this.finalize(target.runId, { status: "cancelled", cancelledReason: "shutdown" }, false);
        target.controller.abort();
        this.recordCancelling(userId, target.runId);
        cancelled.push(target.runId);
        continue;
      }
      const result = this.cancel(userId, undefined, reason);
      if (result.ok && result.runId) cancelled.push(result.runId);
    }
    return cancelled;
  }

  /** Wipe the user's VM (clear active agent runs and shell execs first). */
  async resetVm(userId: string): Promise<void> {
    this.cancel(userId);
    const st = this.users.get(userId);
    if (st) {
      for (const run of [...st.shellRuns.values()]) {
        this.finalizeShell(run.runId, { status: "error", error: "VM reset" });
        run.controller.abort();
      }
    }
    await this.vm.reset(userId);
  }

  async newThread(userId: string): Promise<void> {
    this.cancel(userId);
    await clearLastSession(userId);
  }

  /**
   * Run one terminal command in the user's VM (POST /api/runtime/vm/exec).
   *
   * Unlike start() there is no "one active run" invariant: shell execs are
   * short, user-initiated commands and may overlap with an agent run. Output
   * streams to the telemetry bus under the returned runId, which the terminal
   * consumes via /api/runtime/stream/[runId]. `source` is the line the user
   * typed (kept verbatim for display/audit); argv is what actually executes.
   */
  execShell(userId: string, cmd: string[], source?: string): { runId: string } {
    const runId = `run_${randomUUID()}`;
    const st = this.state(userId);
    const prompt = source && source.trim() ? source.trim() : cmd.join(" ");
    const run: ShellRun = {
      runId,
      userId,
      controller: new AbortController(),
      prompt,
      createdAt: Date.now(),
    };
    st.shellRuns.set(runId, run);

    // Redact the shell command before it hits the durable run log: a secret
    // typed into a terminal command must never be persisted verbatim. The
    // redactor reuses lib/harness/redact.ts (key shapes + known env values),
    // the same redaction applied to shell output in executeShell.
    const redact = makeRedactor({ ...process.env } as Record<string, string>);

    // `kind: "shell"` marks this as a direct terminal exec, not an agent
    // prompt: the thread lists agent runs only, so a typed command must
    // never show up there as a user message with an empty reply.
    this.bus.publish(runId, {
      type: "run.created",
      data: { prompt: truncate(redact(prompt), SUMMARY_PROMPT_LEN), userId, kind: "shell" },
    });
    const cmdEvent: { type: "shell.cmd"; data: { command: string; argv: string[] } } = {
      type: "shell.cmd",
      data: { command: redact(prompt), argv: cmd },
    };
    this.bus.publish(runId, cmdEvent);

    void this.executeShell(run, cmd);
    return { runId };
  }

  /**
   * Ensure the VM, exec `cmd`, and stream stdout/stderr as `shell.output`
   * events. A terminal event (run.finished / run.error) is emitted exactly
   * once, after which the run leaves the active set.
   */
  private async executeShell(run: ShellRun, cmd: string[]): Promise<void> {
    const { runId, userId } = run;
    const redact = makeRedactor({ ...process.env } as Record<string, string>);
    const startedAt = Date.now();

    this.bus.publish(runId, { type: "vm.starting", data: { userId } });
    try {
      await this.vm.ensure(userId);
      // Same disk-quota gate as agent runs: an over-quota user may not start
      // new shell execs either (they can free space via VM reset).
      if (this.vm.quotas.diskQuotaMb > 0) await this.vm.assertDiskQuota(userId);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      this.bus.publish(runId, { type: "vm.error", data: { message } });
      const errorEvent: { type: "run.error"; message: string } = { type: "run.error", message };
      this.bus.publish(runId, errorEvent);
      this.finalizeShell(runId, { status: "error", error: message });
      return;
    }
    if (run.controller.signal.aborted) return;
    this.bus.publish(runId, { type: "vm.ready", data: { ms: Date.now() - startedAt } });

    try {
      const result = await this.vm.exec(userId, cmd, {
        signal: run.controller.signal,
        onStdout: (text) =>
          this.bus.publish(runId, { type: "shell.output", data: { stream: "stdout", text } }),
        onStderr: (text) =>
          this.bus.publish(runId, { type: "shell.output", data: { stream: "stderr", text } }),
      });
      if (!this.isShellActive(runId, userId)) return; // aborted by reset; already finalized
      const durationMs = Date.now() - startedAt;
      const finishedEvent: {
        type: "run.finished";
        exitCode: number;
        durationMs: number;
        truncated: boolean;
      } = {
        type: "run.finished",
        exitCode: result.exitCode,
        durationMs,
        truncated: result.truncated === true,
      };
      this.bus.publish(runId, finishedEvent);
      this.finalizeShell(runId, { status: "finished", exitCode: result.exitCode, durationMs });
    } catch (error) {
      if (!this.isShellActive(runId, userId)) return; // aborted by reset; already finalized
      const message = redact(error instanceof Error ? error.message : String(error));
      const errorEvent: { type: "run.error"; message: string; exitCode: number } = {
        type: "run.error",
        message,
        exitCode: -1,
      };
      this.bus.publish(runId, errorEvent);
      this.finalizeShell(runId, { status: "error", error: message, exitCode: -1 });
    }
  }

  private isShellActive(runId: string, userId: string): boolean {
    return this.users.get(userId)?.shellRuns.has(runId) ?? false;
  }

  private finalizeShell(
    runId: string,
    patch: {
      status: "finished" | "error" | "cancelled";
      exitCode?: number;
      error?: string;
      durationMs?: number;
      cancelledReason?: "user" | "superseded";
    },
  ): void {
    for (const [userId, st] of this.users) {
      const run = st.shellRuns.get(runId);
      if (!run) continue;
      if (patch.status === "cancelled") {
        const cancelledEvent: { type: "run.cancelled"; reason: "user" | "superseded" } = {
          type: "run.cancelled",
          reason: patch.cancelledReason ?? "user",
        };
        this.bus.publish(runId, cancelledEvent);
      }
      const summary: RunSummary = {
        runId,
        userId,
        status: patch.status,
        prompt: run.prompt,
        createdAt: run.createdAt,
        finishedAt: Date.now(),
        exitCode: patch.exitCode,
        error: patch.error,
        durationMs: patch.durationMs,
        cancelledReason: patch.cancelledReason,
        lastSeq: this.bus.latestSeq(runId),
        kind: "shell",
      };
      st.shellRuns.delete(runId);
      st.history.unshift(summary);
      if (st.history.length > HISTORY_LIMIT) st.history.length = HISTORY_LIMIT;
      return;
    }
  }

  private baseSummary(a: ActiveRun): RunSummary {
    return {
      runId: a.runId,
      userId: a.userId,
      status: "running",
      // The original ask, not the role-continuation prompt a switch wrote
      // into `prompt` mid-run.
      prompt: a.initialPrompt ?? a.prompt,
      sessionId: a.sessionId,
      provider: a.provider,
      model: a.model,
      compute: a.compute ?? { kind: "cloud" },
      ...(a.runMode
        ? { mode: a.runMode.mode, modeReason: a.runMode.reason }
        : {}),
      ...(a.forkedFrom ? { forkedFrom: a.forkedFrom } : {}),
      createdAt: a.createdAt,
      startedAt: a.startedAt,
      lastSeq: 0,
    };
  }

  /**
   * Number of accounts with an active cloud run. The compute picker uses this
   * as the live cloud VM pool occupancy: a free-tier account defaults to BYOC
   * when the pool is at capacity.
   */
  cloudInUse(): number {
    let count = 0;
    for (const state of this.users.values()) if (state.active) count += 1;
    return count;
  }

  /**
   * Execute one run, failing over across providers from the router when a run
   * error indicates the selected provider/key is unusable (401/429/overloaded).
   * Provider env and redaction list come from the selection; a terminal event
   * is emitted exactly once, after all attempts are exhausted.
   *
   * The wrapper guarantees the per-thread slot always releases: any uncaught
   * error or forgotten terminal path still finalizes the run and starts the
   * next queued prompt, so the queue can never wedge.
   */
  private async execute(active: ActiveRun): Promise<void> {
    const { runId, userId } = active;
    try {
      await this.executeInner(active);
    } catch (error) {
      if (!this.isStillActive(runId, userId)) return;
      const redact = makeRedactor({ ...process.env } as Record<string, string>);
      const message = redact(error instanceof Error ? error.message : String(error));
      const errorEvent: { type: "run.error"; message: string } = {
        type: "run.error",
        message,
      };
      this.bus.publish(runId, errorEvent);
      this.finalize(runId, { status: "error", error: message });
    } finally {
      // Belt-and-braces: if the run is somehow still occupying the slot here,
      // release it so the queue keeps draining. Normally redundant (terminal
      // paths finalize before returning), but a run whose exec promise never
      // settles must not hold the thread hostage.
      this.cancelling.delete(runId);
      if (this.isStillActive(runId, userId)) {
        const errorEvent: { type: "run.error"; message: string } = {
          type: "run.error",
          message: "run ended without releasing its slot",
        };
        this.bus.publish(runId, errorEvent);
        this.finalize(runId, {
          status: "error",
          error: "run ended without releasing its slot",
        });
      }
    }
  }

  private async executeInner(active: ActiveRun): Promise<void> {
    const { runId, userId } = active;
    const redact = makeRedactor({ ...process.env } as Record<string, string>);

    // The run report (screenshots, artifact diff, timeline) watches this run's
    // telemetry and creates itself automatically when the run reaches a
    // terminal state. The starting role rides along so a role with a pinned
    // lens (e.g. Coder → security) auto-audits the run on completion.
    this.reporter.attach(runId, userId, active.role?.id);

    this.bus.publish(runId, { type: "vm.starting", data: { userId } });
    this.touchActivity(active);
    const ensureStartedAt = Date.now();
    try {
      await this.vm.ensure(userId);
      // Refuse new runs while the user is over their workspace disk quota
      // (SWARM_VM_DISK_QUOTA_MB): a run that fills the host disk is a
      // cross-user hazard, so the check happens before any agent work.
      if (this.vm.quotas.diskQuotaMb > 0) await this.vm.assertDiskQuota(userId);
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      this.bus.publish(runId, { type: "vm.error", data: { message } });
      const errorEvent: { type: "run.error"; message: string } = { type: "run.error", message };
      this.bus.publish(runId, errorEvent);
      this.finalize(runId, { status: "error", error: message });
      return;
    }

    if (active.controller.signal.aborted) return;
    const ensureMs = Date.now() - ensureStartedAt;
    this.touchActivity(active);
    this.bus.publish(runId, { type: "vm.ready", data: { ms: ensureMs, durationMs: ensureMs } });

    // Warm golden snapshot: boot a dependency image that matches the current
    // package.json / Dockerfile / requirements.txt. Fork seeds keep their
    // checkpoint; a warm failure never fails the run.
    if (!active.seedSnapshotLabel && !active.controller.signal.aborted) {
      try {
        const repo = await selectedCodebaseRepo(userId, this.codebaseScanner);
        let hotspots: HotspotHint[] = [];
        if (repo) {
          const rows = await getCodebaseHotspots(userId, this.codebaseScanner, repo, 40);
          hotspots = rows.map((row) => ({
            path: row.path,
            churn90d: row.churn90d,
            fanIn: row.fanIn,
          }));
        }
        await applyWarmGoldenSnapshot(this.vm, userId, hotspots);
      } catch {
        // A warm-snapshot failure must not fail the run. The agent continues
        // on the VM ensure() already started.
      }
    }

    // F1 fork seed: a forked run starts from its checkpoint's workspace, not
    // the live one. The restore runs here — after ensure, before any role
    // files or agent work — so the fork's agent sees exactly the checkpoint
    // state. It waits until the fork actually starts (not at fork time), so
    // a queued fork never clobbers the VM under a still-running original.
    // A failed restore fails the fork loudly: running on the wrong workspace
    // would silently do the wrong work.
    if (active.seedSnapshotLabel) {
      try {
        await this.vm.restore(userId, active.seedSnapshotLabel);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        this.bus.publish(runId, { type: "vm.error", data: { message } });
        const errorEvent: { type: "run.error"; message: string } = {
          type: "run.error",
          message: `Could not restore fork checkpoint ${active.seedSnapshotLabel}: ${message}`,
        };
        this.bus.publish(runId, errorEvent);
        this.finalize(runId, { status: "error", error: errorEvent.message });
        return;
      }
      const restoredEvent: Extract<HarnessEvent, { type: "checkpoint.restored" }> = {
        type: "checkpoint.restored",
        label: active.forkedFrom?.checkpointLabel ?? active.seedSnapshotLabel,
        vmLabel: active.seedSnapshotLabel,
        stepSeq: active.forkedFrom?.stepSeq ?? 0,
        sourceRunId: active.forkedFrom?.runId ?? "",
      };
      this.bus.publish(runId, restoredEvent);
    }

    // Runs seed the role-switch MCP server, the role catalog and the
    // per-role --mcp-config into the VM before the first claude spawn. Even a
    // legacy run (no roleId) runs under the default Main Agent phase, so the
    // files are always written; switches rewrite only the config.
    // The allowed set is the run's own frozen policy — never the whole
    // catalog. A runtime escalation approval adds its role to this set before
    // the config is rewritten for the next phase.
    const catalog = userRoleCatalog(userId);
    const policy = active.rolePolicy;
    const allowedRoleIds = new Set(policy.allowedRoleIds);
    const libraryPermissions = libraryAllowedToolPermissions(userId);
    const libraryServers = libraryMcpEntries(userId);
    const initialRole = active.role ?? policy.startingRole;
    const initialPhase = active.role
      ? this.rolePhaseFor(active.role, libraryPermissions, active.runMode, active.toolAllowlist)
      : this.defaultRolePhase(libraryPermissions, active.runMode, active.toolAllowlist);
    try {
      await this.seedRoleFiles(
        userId,
        catalog,
        allowedRoleIds,
        initialPhase,
        libraryServers,
        active.runMode,
      );
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      this.bus.publish(runId, { type: "vm.error", data: { message } });
      const errorEvent: { type: "run.error"; message: string } = { type: "run.error", message };
      this.bus.publish(runId, errorEvent);
      this.finalize(runId, { status: "error", error: message });
      return;
    }

    // The codebase context pack is prepended to the run's system prompt, once
    // per run: the agent starts with a map of the repository it works in.
    await this.maybeInjectCodebaseContext(active);

    // The account's long-term memory is injected at the start of the run: the
    // facts most relevant to this prompt, capped at the injection budget.
    // The store lives on the host (in the per-user data dir), so the memory
    // survives a VM reset.
    active.memoryContext = await this.memoryContextFor(userId, active.prompt);

    // Phase loop: each role switch continues the same conversation (--resume)
    // with the new role's phase. The provider failover loop runs per phase.
    for (let phaseIndex = 0; ; phaseIndex++) {
      const result = await this.executeOnePhase(active, active.role ?? null);
      if (!result.switched) return;

      const toRole = catalog.find((candidate) => candidate.id === result.toRoleId);
      if (!toRole || phaseIndex + 1 >= MAX_ROLE_PHASES) {
        const message =
          phaseIndex + 1 >= MAX_ROLE_PHASES
            ? `Too many role switches (max ${MAX_ROLE_PHASES}) in one run.`
            : `Role "${result.toRoleId}" is no longer available.`;
        const errorEvent: { type: "run.error"; message: string } = { type: "run.error", message };
        this.bus.publish(runId, errorEvent);
        this.finalize(runId, { status: "error", error: message });
        return;
      }

      const fromRole = active.role ?? initialRole;
      active.role = toRole;
      active.sessionId = result.sessionId ?? active.sessionId;
      active.prompt = roleContinuationPrompt(fromRole, toRole);
      if (toRole.model) active.model = toRole.model;
      try {
        await this.writeRoleConfig(
          userId,
          toRole,
          new Set(policy.allowedRoleIds),
          libraryAllowedToolPermissions(userId),
          libraryMcpEntries(userId),
          active.runMode,
          active.toolAllowlist,
        );
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        const errorEvent: { type: "run.error"; message: string } = { type: "run.error", message };
        this.bus.publish(runId, errorEvent);
        this.finalize(runId, { status: "error", error: message });
        return;
      }
    }
  }

  /**
   * Run one role phase: the full provider failover loop for one claude
   * invocation. Returns `{ switched: true }` when the agent validated a role
   * switch (the caller resumes with the new phase), or `{ switched: false }`
   * once the run reached a terminal state (success/error/cancel).
   */
  private async executeOnePhase(
    active: ActiveRun,
    role: RoleDefinition | null,
  ): Promise<{ switched: true; toRoleId: string; sessionId?: string } | { switched: false }> {
    const { runId, userId } = active;
    const router = this.effectiveRouter(userId);
    const exhausted = new Set<string>();
    const failovers: FailoverRecord[] = [];
    const llmBaseUrl = resolveLlmBaseUrl();
    const approvalBaseUrl = resolveApprovalBaseUrl();
    // Per-run token for the app's VM-facing endpoints (LLM proxy + approval
    // hook): the only credential the VM ever holds. It expires when the run
    // finalizes (revoked in finalize). Local Docker runs have already passed
    // startup validation; other runtimes retain the legacy stdout gate when
    // no signing secret is configured.
    let runToken: string | null = null;
    if (llmBaseUrl || approvalBaseUrl) {
      try {
        runToken = signRunToken(userId, runId);
      } catch {
        runToken = null;
      }
    }
    const hookBaseUrl = approvalBaseUrl && runToken ? approvalBaseUrl : null;
    const approvalEnv = hookBaseUrl && runToken ? approvalHookEnv(hookBaseUrl, runToken) : {};
    const approvalHook = Object.keys(approvalEnv).length > 0;
    const verificationEnabled = isShadowVerificationEnabled();

    while (true) {
      const selection = router
        ? router.selectForClaude({ model: active.model }, exhausted)
        : null;

      // No pool selection available. When providers were exhausted by
      // failover, end in error; otherwise fall back to forwarding the host
      // ANTHROPIC_* env untouched (legacy single-provider behaviour) — there
      // is nothing to fail over to.
      if (!selection) {
        if (failovers.length > 0) {
          const message = aggregateFailureSummary(failovers.map(recordToAttempt));
          // Cancelled runs already finalized as "cancelled": publishing
          // run.error here would overwrite that durable status with "error".
          if (this.isStillActive(runId, userId)) {
            const errorEvent: { type: "run.error"; message: string } = { type: "run.error", message };
            this.bus.publish(runId, errorEvent);
            this.finalize(runId, { status: "error", error: message });
          }
          return { switched: false };
        }
        const fallbackEnv = {
          ...envFallback(),
          ...approvalEnv,
          ...safeVaultEnv(userId, runId, approvalBaseUrl || llmBaseUrl),
        };
        const fallbackMode = this.modeForSelection(active);
        const fallbackPhase = role
          ? this.rolePhaseFor(role, libraryAllowedToolPermissions(userId), fallbackMode, active.toolAllowlist)
          : null;
        const { outcome, attemptError, finishEvent } = await this.runOnce(
          active,
          fallbackEnv,
          null,
          fallbackPhase,
          approvalHook,
          verificationEnabled,
        );
        if (outcome.roleSwitch) return { switched: true, ...outcome.roleSwitch };
        if (outcome.aborted) return { switched: false };
        if (!attemptError) {
          if (!verificationEnabled || !finishEvent) return { switched: false }; // success finalized via run.finished
          const gate = await this.runShadowGate(active, finishEvent);
          if (gate.outcome === "finalized") return { switched: false };
          active.prompt = bounceRemediationPrompt(gate.summary);
          active.shadowAttempts = (active.shadowAttempts ?? 0) + 1;
          continue;
        }
        // Same guard as the failovers-exhausted branch above: a run cancelled
        // while this attempt was unwinding must stay "cancelled", not "error".
        if (this.isStillActive(runId, userId)) {
          const errorEvent: { type: "run.error"; message: string; exitCode?: number } = {
            type: "run.error",
            message: attemptError.message,
            exitCode: attemptError.exitCode,
          };
          this.bus.publish(runId, errorEvent);
          this.finalize(runId, {
            status: "error",
            error: attemptError.message,
            exitCode: attemptError.exitCode,
          });
        }
        return { switched: false };
      }

      // OpenAI-format providers have no /v1/messages; route them through the
      // server-side translation endpoint instead of the provider's raw host.
      // The provider's real key stays on the server — the VM only gets the
      // per-run token.
      const proxiedEnv = applyLlmProxyEnv(selection, llmBaseUrl, runToken);

      // A pool selection supplies this run's auth itself. Drop any host
      // credential env the selection did not provide, so the host's keys
      // (e.g. ANTHROPIC_API_KEY) never leak into the VM when a pool provider
      // is active. The legacy no-pool path above keeps forwarding host env
      // untouched.
      const runEnv = {
        ...scrubHostCredentials({ ...buildRunnerEnv(), ...proxiedEnv }, proxiedEnv),
        // Approval-hook credentials are minted here for this run; they are
        // deliberately kept out of scrubHostCredentials (the hook needs them).
        ...approvalEnv,
        ...safeVaultEnv(userId, runId, llmBaseUrl),
      };

      const selectionMode = this.modeForSelection(active, selection.provider, selection.model);
      const phase = role
        ? this.rolePhaseFor(role, libraryAllowedToolPermissions(userId), selectionMode, active.toolAllowlist)
        : null;
      const { outcome, attemptError, finishEvent } = await this.runOnce(
        active,
        runEnv,
        selection,
        phase,
        approvalHook,
        verificationEnabled,
      );
      if (outcome.roleSwitch) {
        selection.release();
        return { switched: true, ...outcome.roleSwitch };
      }
      if (outcome.aborted) {
        selection.release();
        return { switched: false };
      }

      // Provider-level failure (401/429/overloaded): fail over to the next
      // provider, marking this one exhausted for the rest of the run. A
      // signal kill (e.g. exit 137) is never a provider failure — the process
      // was reaped (timeout / OOM / container), so failing over would retry a
      // healthy provider and hide the real cause. The runner's kill message
      // leads with the exit code today, but the exit code is the reliable
      // signal regardless of what the message contains.
      if (
        attemptError &&
        isClaudeFailoverEligible(attemptError.message) &&
        !isSignalKillExitCode(attemptError.exitCode ?? -1)
      ) {
        const parsed = classifyClaudeRunError(attemptError.message);
        selection.settle({ ok: false, kind: parsed?.kind, status: parsed?.status });
        exhausted.add(selection.provider);
        failovers.push({
          sel: selection,
          message: attemptError.message,
          kind: parsed?.kind,
          status: parsed?.status,
        });
        const failoverEvent: { type: "run.failover"; data: unknown } = {
          type: "run.failover",
          data: {
            provider: selection.provider,
            keyId: selection.keyId,
            model: selection.model,
            message: attemptError.message,
          },
        };
        this.bus.publish(runId, failoverEvent);
        continue;
      }

      // Terminal outcome. When the shadow-verifier gate is active, the run's
      // finish was deferred; verify it here, and bounce back to the primary
      // agent (bounded) if the code is unverified or the build broke.
      if (!attemptError) {
        selection.settle({ ok: true });
        if (!verificationEnabled || !finishEvent) return { switched: false }; // success finalized via run.finished
        const gate = await this.runShadowGate(active, finishEvent);
        if (gate.outcome === "finalized") return { switched: false };
        active.prompt = bounceRemediationPrompt(gate.summary);
        active.shadowAttempts = (active.shadowAttempts ?? 0) + 1;
        continue;
      }

      selection.settle({ ok: false, kind: "unknown" });
      const message =
        failovers.length > 0
          ? aggregateFailureSummary([
              ...failovers.map(recordToAttempt),
              recordToAttempt({ sel: selection, message: attemptError.message }),
            ])
          : attemptError.message;
      const finalError: { type: "run.error"; message: string; exitCode?: number } = {
        type: "run.error",
        message,
        exitCode: attemptError.exitCode,
      };
      this.bus.publish(runId, finalError);
      this.finalize(runId, {
        status: "error",
        error: message,
        exitCode: attemptError.exitCode,
      });
      return { switched: false };
    }
  }

  private isStillActive(runId: string, userId: string): boolean {
    const st = this.users.get(userId);
    return st?.active?.runId === runId;
  }

  /**
   * Resolve the shadow-verifier plan for a run: the selected codebase repo and
   * its test commands. Null when there is nothing meaningful to verify (no
   * repo picked, no map, or no test commands). Never throws.
   */
  private async resolveVerificationPlan(
    active: ActiveRun,
  ): Promise<{ repoRoot: string; testCommands: string[] } | null> {
    const { userId } = active;
    try {
      const selected = await selectedCodebaseRepo(userId, this.codebaseScanner);
      if (!selected) return null;
      const map = await this.codebaseScanner.readMap(userId, selected);
      const testCommands = (map?.testCommands ?? []).filter((cmd) => cmd.trim().length > 0);
      if (testCommands.length === 0) return null;
      return { repoRoot: selected, testCommands };
    } catch {
      return null;
    }
  }

  /** Adapter from the VM exec driver to the verifier's ShadowExec shape. */
  private shadowExecFor(userId: string): ShadowExec {
    const vmExec = bindExec(this.vm, userId);
    return async (cmd, opts) => {
      let stdout = "";
      let stderr = "";
      const result = await vmExec.exec(cmd, {
        cwd: opts?.cwd,
        signal: opts?.signal,
        onStdout: (chunk) => {
          stdout += chunk;
        },
        onStderr: (chunk) => {
          stderr += chunk;
        },
      });
      return { exitCode: result.exitCode, stdout, stderr };
    };
  }

  /** Finalize a finished run with its verification badge, if any. */
  private finalizeFinished(
    active: ActiveRun,
    finishEvent: Extract<HarnessEvent, { type: "run.finished" }>,
    summary: ShadowVerificationSummary | undefined,
  ): void {
    const patch: TerminalPatch = {
      status: "finished",
      exitCode: finishEvent.exitCode,
      sessionId: finishEvent.sessionId,
      costUsd: finishEvent.costUsd,
      durationMs: finishEvent.durationMs,
      numTurns: finishEvent.numTurns,
    };
    if (summary) {
      const meta: RunVerificationMeta = {
        badge: summary.badge,
        score: summary.score,
        roundsUsed: (active.shadowAttempts ?? 0) + 1,
        violations: summary.violations,
        passed: summary.passed,
      };
      patch.verification = meta;
      writeRunVerification(active.runId, meta);
    }
    this.bus.publish(active.runId, finishEvent);
    this.finalize(active.runId, patch);
  }

  /**
   * The shadow-verifier gate, run just before a successful agent run would mark
   * itself finished. Runs the repo's test commands, inspects the /workspace
   * diff, audits both via the verification pipeline, and:
   *
   *   - finalizes the run (with a badge) when verification passes, has nothing
   *     to run, or has exhausted its bounded budget; or
   *   - bounces the run back to the primary agent with a remediation prompt.
   *
   * Any infrastructure failure (no cheap model, no map, exec error) is treated
   * as "skip verification" so a run is never blocked or hung by the gate.
   */
  private async runShadowGate(
    active: ActiveRun,
    finishEvent: Extract<HarnessEvent, { type: "run.finished" }>,
  ): Promise<
    | { outcome: "finalized" }
    | { outcome: "bounce"; summary: ShadowVerificationSummary }
  > {
    const { userId } = active;
    const attemptsUsed = active.shadowAttempts ?? 0;
    try {
      const plan = await this.resolveVerificationPlan(active);
      if (!plan) {
        this.finalizeFinished(active, finishEvent, undefined);
        return { outcome: "finalized" };
      }
      const callLLM = createCheapCallLLM(userId, { signal: active.controller.signal });
      if (!callLLM) {
        this.finalizeFinished(active, finishEvent, undefined);
        return { outcome: "finalized" };
      }
      const deps: ShadowVerifierDeps = {
        exec: this.shadowExecFor(userId),
        callLLM,
      };
      const summary = await shadowVerifyRound(deps, {
        repoRoot: plan.repoRoot,
        testCommands: plan.testCommands,
        prompt: active.prompt,
        round: attemptsUsed + 1,
      });
      if (!summary.passed) {
        if (attemptsUsed + 1 >= SHADOW_VERIFIER_MAX_ROUNDS) {
          this.finalizeFinished(active, finishEvent, summary);
          return { outcome: "finalized" };
        }
        return { outcome: "bounce", summary };
      }
      // Shadow round passed: run the diff-hygiene / revert-test gate
      // (Stage 0 + Stage 3 of the engine verification pipeline). It runs
      // only on a green suite, because the revert-test proof's premise is
      // passing tests. A gate infrastructure failure never blocks or
      // bounces a run — it finalizes with the shadow summary, exactly like
      // a missing plan or model above.
      try {
        const gate = await runDiffHygieneGate(deps, {
          repoRoot: plan.repoRoot,
          testCommands: plan.testCommands,
        });
        if (!gate.summary.passed) {
          if (attemptsUsed + 1 >= SHADOW_VERIFIER_MAX_ROUNDS) {
            this.finalizeFinished(active, finishEvent, gate.summary);
            return { outcome: "finalized" };
          }
          return { outcome: "bounce", summary: gate.summary };
        }
      } catch {
        // Gate plumbing failed — finalize with the passing shadow summary.
      }
      this.finalizeFinished(active, finishEvent, summary);
      return { outcome: "finalized" };
    } catch {
      // Never let a verifier failure wedge or falsely bounce a run.
      this.finalizeFinished(active, finishEvent, undefined);
      return { outcome: "finalized" };
    }
  }

  /**
   * Run one claude invocation with the given provider env. The runner's stream
   * is forwarded to the bus; run.error is captured and returned so the caller
   * decides whether to fail over. run.finished finalizes the run here.
   */
  private async runOnce(
    active: ActiveRun,
    env: Record<string, string>,
    selection: ClaudeSelection | null,
    phase: RolePhase | null,
    approvalHook = false,
    deferFinish = false,
    forward: (event: HarnessEvent) => void = (event) => this.forwardEvent(active, event),
  ): Promise<{
    outcome: RunOutcome;
    attemptError: Extract<HarnessEvent, { type: "run.error" }> | null;
    finishEvent: Extract<HarnessEvent, { type: "run.finished" }> | null;
  }> {
    const { runId, userId } = active;
    let attemptError: Extract<HarnessEvent, { type: "run.error" }> | null = null;
    let finishEvent: Extract<HarnessEvent, { type: "run.finished" }> | null = null;

    // The router's selection is the provider/model actually serving this
    // attempt. Record it on the active run before the runner starts, so
    // run.started and the in-memory summary carry it even when no explicit
    // model was requested (the router picks the default then).
    if (selection) {
      active.provider = selection.provider;
      active.model = selection.model;
    }

    const onAttemptEvent = (event: HarnessEvent) => {
      if (event.type === "run.error") {
        attemptError = event;
        return; // whether this ends the run is decided by the caller
      }
      if (event.type === "run.finished") {
        if (deferFinish) {
          finishEvent = event;
          return; // the shadow-verifier gate decides whether to finalize
        }
        this.bus.publish(runId, event);
        this.finalize(runId, {
          status: "finished",
          exitCode: event.exitCode,
          sessionId: event.sessionId,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          numTurns: event.numTurns,
        });
        return;
      }
      forward(event);
    };

    // Ask-classified tool calls pause the run until POST /api/runtime/approvals/{id}.
    const approvalGateway: ApprovalGateway = async (ask) => {
      const approval = getApprovalStore().create({
        runId,
        userId,
        toolName: ask.toolName,
        action: ask.action,
        reason: ask.reason,
      });
      return {
        id: approval.id,
        expiresAt: approval.expiresAt,
        timedOut: () => getApprovalStore().get(approval.id)?.timedOut === true,
        verdict: getApprovalStore().waitFor(approval.id),
      };
    };

    // The agent's memory tools run against the host-side store: the in-VM MCP
    // server forwards every call over a small file RPC and this bridge
    // answers it. The bridge only lives as long as the run.
    const memoryBridge = startMemoryBridge({
      vm: this.vm,
      userId,
      handle: (tool, args) => runMemoryTool(userId, tool, args),
    });

    // ask_user calls pause the run until POST /api/runtime/questions. The
    // pending/answer files are the rendezvous with the VM-side MCP server;
    // every write goes through the VM driver.
    const questionGateway: QuestionGateway = this.questionGatewayFor(active, new Set<string>());

    // ask_human_desktop calls pause the run until POST /api/runtime/handoffs
    // (shadow-to-takeover desktop handoff). Same rendezvous-file pattern: the
    // VM-side server writes <id>.pending.json, the host adopts its id, waits,
    // and writes the resolution file (with the post-handoff state summary).
    const handoffGateway: HandoffGateway = this.handoffGatewayFor(active, new Set<string>());

    try {
      const outcome = await this.runner.run(
        {
          // The project digest rides in front of the user's ask on a fresh
          // thread only; history and Telemetry keep showing the real prompt.
          prompt: active.contextPrefix ? `${active.contextPrefix}\n\n${active.prompt}` : active.prompt,
          agentCard: active.agentCard,
          memoryContext: active.memoryContext,
          sessionId: active.sessionId,
          model: active.model,
          provider: selection?.provider,
          env,
          // Stable per-run pgid marker: the cancel backstop kills exactly
          // this run's process group (never PID 1's children).
          pgidFile: active.pgidFile,
          vm: bindExec(this.vm, userId),
          signal: active.controller.signal,
          cwd: "/workspace",
          redactSecrets: selection?.secrets,
          approvalGateway,
          approvalHook,
          autoApprove: active.fullAuto === true,
          questionGateway,
          handoffGateway,
          rolePhase:
            phase ??
            this.defaultRolePhase(
              libraryAllowedToolPermissions(userId),
              active.runMode,
              active.toolAllowlist,
            ),
          onRoleSwitch: async (request) => {
            // The run's frozen policy is the source of truth. `catalog` here
            // is the user's current catalog; ids outside it are rejected as
            // unknown. The MCP server already rejected the call the same way
            // using SWARM_ROLE_ALLOWED, but this check is authoritative.
            const catalog = userRoleCatalog(userId);
            const policy = active.rolePolicy;
            const baseline =
              catalog.find((candidate) => candidate.id === policy.startingRole.id) ?? policy.startingRole;
            const fromRole = active.role ?? baseline;
            const decision = resolveRoleSwitch(catalog, new Set(policy.allowedRoleIds), request.toRoleId);
            if (decision.ok) {
              return this.rolePhaseFor(
                decision.role,
                libraryAllowedToolPermissions(userId),
                active.runMode,
                active.toolAllowlist,
              );
            }
            if (decision.error === "unknown_role") return null;

            const toRole = catalog.find((candidate) => candidate.id === request.toRoleId);
            if (!toRole) return null;
            const delta = roleCapabilityDelta(baseline, toRole);
            if (!hasRoleEscalation(delta)) {
              // A subset the policy should already contain. Admit it without
              // asking (never broader than the starting role).
              if (!policy.allowedRoleIds.includes(toRole.id)) policy.allowedRoleIds.push(toRole.id);
              return this.rolePhaseFor(
                toRole,
                libraryAllowedToolPermissions(userId),
                active.runMode,
                active.toolAllowlist,
              );
            }

            // Escalation: ask the user before the CLI restart. The approval is
            // enforced here, server-side; nothing restarts until it is granted.
            const approval = createRoleEscalationApproval({ runId, userId, from: fromRole, to: toRole, baseline });
            const verdict = await awaitRoleEscalation(approval, {
              publish: (event) => this.bus.publish(runId, event),
              signal: active.controller.signal,
            });
            if (verdict !== "approved") return null;
            // Grant it for the rest of this run so a later switch back to (or
            // between) approved roles does not re-prompt.
            if (!policy.allowedRoleIds.includes(toRole.id)) policy.allowedRoleIds.push(toRole.id);
            return this.rolePhaseFor(
              toRole,
              libraryAllowedToolPermissions(userId),
              active.runMode,
              active.toolAllowlist,
            );
          },
        },
        onAttemptEvent,
      );
      return { outcome, attemptError, finishEvent };
    } catch (error) {
      // The runner surfaced a non-run failure (e.g. exec driver error). Treat
      // it as a run error so the caller's terminal handling applies uniformly.
      const redact = makeRedactor({ ...process.env } as Record<string, string>);
      const message = redact(error instanceof Error ? error.message : String(error));
      const synthetic: Extract<HarnessEvent, { type: "run.error" }> = {
        type: "run.error",
        message,
      };
      if (!this.isStillActive(runId, userId)) {
        return { outcome: { exitCode: -1, aborted: true, malformedLines: 0 }, attemptError: synthetic, finishEvent };
      }
      return { outcome: { exitCode: -1, aborted: false, malformedLines: 0 }, attemptError: synthetic, finishEvent };
    } finally {
      memoryBridge.stop();
    }
  }

  /**
   * Wire ask_user to the question store and the VM-side rendezvous files.
   *
   * The VM ask server has already created `<id>.pending.json` and is polling
   * for `<id>.answer.json`. We adopt its id, persist the question, and return
   * a ticket immediately (so the runner can emit question.required); the
   * ticket's outcome answers by writing the answer file through the VM driver.
   */
  private questionGatewayFor(active: ActiveRun, seen: Set<string>): QuestionGateway {
    const { runId, userId } = active;
    return async (ask: QuestionRequest) => {
      const pending = await this.waitForPendingQuestion(userId, seen, ask);
      const store = getQuestionStore();
      const question = store.create({
        ...(pending?.id ? { id: pending.id } : {}),
        runId,
        userId,
        question: pending?.question ?? ask.question,
        options: pending?.options ?? ask.options,
        allowFreeText: pending?.allowFreeText ?? ask.allowFreeText,
      });

      const settled = this.waitForQuestionOutcome(store.waitFor(question.id), active);
      return {
        id: question.id,
        question: question.question,
        options: question.options,
        allowFreeText: question.allowFreeText,
        expiresAt: question.expiresAt,
        outcome: settled.then(async (result) => {
          await this.writeQuestionAnswer(userId, question.id, result);
          return result;
        }),
      };
    };
  }

  /** Wait for an answer, but never past the run's cancellation. */
  private async waitForQuestionOutcome(
    outcome: Promise<QuestionOutcome>,
    active: ActiveRun,
  ): Promise<QuestionOutcome> {
    const signal = active.controller.signal;
    if (signal.aborted) return { status: "cancelled" };
    return Promise.race([
      outcome,
      new Promise<QuestionOutcome>((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    ]);
  }

  /**
   * Find the pending file the VM ask server just wrote. Polls briefly because
   * the tool call can reach the harness stream a tick before the file lands.
   * Returns null when the server is unavailable (the card is still shown; the
   * tool call itself will time out in the VM).
   */
  private async waitForPendingQuestion(
    userId: string,
    seen: Set<string>,
    ask: QuestionRequest,
  ): Promise<{ id: string; question: string; options: string[]; allowFreeText: boolean } | null> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const entries = await this.vm.listDir(userId, ASK_QUESTIONS_DIR);
        const candidates = entries
          .filter((entry) => entry.type === "file" && entry.name.endsWith(".pending.json"))
          .map((entry) => ({ entry, id: entry.name.slice(0, -".pending.json".length) }))
          .filter(({ id }) => !seen.has(id))
          .sort((a, b) => (b.entry.modifiedAt ?? 0) - (a.entry.modifiedAt ?? 0));
        for (const { entry, id } of candidates) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(await this.vm.readFile(userId, entry.path)) as Record<string, unknown>;
          } catch {
            continue; // partially written; retry on the next poll
          }
          if (!parsed || typeof parsed.id !== "string") continue;
          seen.add(parsed.id);
          return {
            id: parsed.id,
            question: typeof parsed.question === "string" ? parsed.question : ask.question,
            options: Array.isArray(parsed.options)
              ? parsed.options.filter((option): option is string => typeof option === "string")
              : ask.options,
            allowFreeText: parsed.allowFreeText !== false,
          };
        }
      } catch {
        // Directory may not exist yet; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  /** Write the answer (or cancellation) file the VM ask server is polling. */
  private async writeQuestionAnswer(
    userId: string,
    id: string,
    outcome: QuestionOutcome,
  ): Promise<void> {
    const payload =
      outcome.status === "answered"
        ? { status: "answered", answer: outcome.answer, answeredAt: Date.now() }
        : { status: outcome.status, answeredAt: Date.now() };
    try {
      await this.vm.writeFile(userId, questionPaths(id).answer, JSON.stringify(payload));
    } catch {
      // The run is already finalized or the VM is gone; nothing to resume.
    }
  }

  /**
   * Wire ask_human_desktop to the handoff store and the VM-side rendezvous
   * files.
   *
   * The VM desktop-handoff server has already created `<id>.pending.json` and
   * is polling for `<id>.answer.json`. We adopt its id, persist the handoff,
   * force the user's desktop sessions to view mode (the user has the wheel)
   * and return a ticket immediately (so the runner can emit handoff.required);
   * the ticket's outcome resolves by writing the resolution file through the
   * VM driver.
   */
  private handoffGatewayFor(active: ActiveRun, seen: Set<string>): HandoffGateway {
    const { runId, userId } = active;
    return async (request: HandoffRequest) => {
      const pending = await this.waitForPendingHandoff(userId, seen, request);
      const store = getHandoffStore();
      const handoff = store.create({
        ...(pending?.id ? { id: pending.id } : {}),
        runId,
        userId,
        reason: pending?.reason ?? request.reason,
        description: pending?.description ?? request.description,
      });

      // The user now holds the wheel: keep every desktop session read-only so
      // only the inline take-the-wheel canvas (opened in control mode) sends
      // input while the handoff is outstanding.
      this.forceDesktopMode(userId, "view");

      const settled = this.waitForHandoffOutcome(store.waitFor(handoff.id), active);
      return {
        id: handoff.id,
        reason: handoff.reason,
        description: handoff.description,
        expiresAt: handoff.expiresAt,
        outcome: settled.then(async (result) => {
          await this.writeHandoffResolution(userId, handoff.id, request, result);
          return result;
        }),
      };
    };
  }

  /** Wait for a handoff outcome, but never past the run's cancellation. */
  private async waitForHandoffOutcome(
    outcome: Promise<HandoffOutcome>,
    active: ActiveRun,
  ): Promise<HandoffOutcome> {
    const signal = active.controller.signal;
    if (signal.aborted) return { status: "cancelled" };
    return Promise.race([
      outcome,
      new Promise<HandoffOutcome>((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    ]);
  }

  /**
   * Find the pending handoff file the VM desktop-handoff server just wrote.
   * Polls briefly because the tool call can reach the harness stream a tick
   * before the file lands. Returns null when the server is unavailable (the
   * card is still shown; the tool call itself will time out in the VM).
   */
  private async waitForPendingHandoff(
    userId: string,
    seen: Set<string>,
    request: HandoffRequest,
  ): Promise<{ id: string; reason: string; description: string } | null> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const entries = await this.vm.listDir(userId, DESKTOP_HANDOFF_DIR);
        const candidates = entries
          .filter((entry) => entry.type === "file" && entry.name.endsWith(".pending.json"))
          .map((entry) => ({ entry, id: entry.name.slice(0, -".pending.json".length) }))
          .filter(({ id }) => !seen.has(id))
          .sort((a, b) => (b.entry.modifiedAt ?? 0) - (a.entry.modifiedAt ?? 0));
        for (const { entry, id } of candidates) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(await this.vm.readFile(userId, entry.path)) as Record<string, unknown>;
          } catch {
            continue; // partially written; retry on the next poll
          }
          if (!parsed || typeof parsed.id !== "string") continue;
          seen.add(parsed.id);
          return {
            id: parsed.id,
            reason: typeof parsed.reason === "string" ? parsed.reason : request.reason,
            description: typeof parsed.description === "string" ? parsed.description : request.description,
          };
        }
      } catch {
        // Directory may not exist yet; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  /**
   * Write the resolution (or cancellation) file the VM desktop-handoff server
   * is polling. On "Hand back to Agent" this also captures the post-handoff
   * desktop state into a compact context summary that the agent resumes with,
   * and restores control mode to the user's desktop sessions.
   */
  private async writeHandoffResolution(
    userId: string,
    id: string,
    request: DesktopHandoffArguments,
    outcome: HandoffOutcome,
  ): Promise<void> {
    let payload: Record<string, unknown>;
    if (outcome.status === "answered") {
      // Restore control to the user's desktop sessions (the wheel is handed
      // back to the agent).
      this.forceDesktopMode(userId, "control");
      const resolvedAt = Date.now();
      const startedAt = getHandoffStore().get(id)?.createdAt ?? resolvedAt;
      const shot = await captureDesktopScreenshot(this.vm, userId);
      const summary = buildHandoffSummary({
        startedAt,
        resolvedAt,
        shot,
        description: request.description,
      });
      payload = { status: "answered", summary, resolvedAt };
    } else {
      payload = { status: outcome.status, resolvedAt: Date.now() };
    }
    try {
      await this.vm.writeFile(userId, handoffPaths(id).answer, JSON.stringify(payload));
    } catch {
      // The run is already finalized or the VM is gone; nothing to resume.
    }
  }

  /**
   * Force (or restore) the desktop proxy mode for a user. Never throws: a
   * missing/failed proxy must not break a run.
   */
  private forceDesktopMode(userId: string, mode: RfbFilterMode): void {
    try {
      getGlobalDesktopProxy()?.setUserMode(userId, mode);
    } catch {
      // best-effort; the handoff still resolves through the VM files
    }
  }

  /** Forward one non-terminal event to the bus, with single-start handling. */
  private forwardEvent(active: ActiveRun, event: HarnessEvent): void {
    const { runId, userId } = active;
    this.touchActivity(active); // any live telemetry is heartbeat
    if (active.projectId) {
      // Project continuity is best-effort and must never break the run stream.
      try {
        noteProjectRunEvent(userId, active.projectId, runId, event);
      } catch {
        /* recorder is fail-safe; this is belt-and-braces */
      }
    }
    if (event.type === "run.started") {
      const st = this.users.get(userId);
      if (st?.active?.runId === runId && st.active.startedAt === undefined) {
        st.active.startedAt = Date.now();
      }
    }
    if (event.type === "tool.call") {
      // Remember which files the agent worked on: the heatmap weighs them.
      const touched = extractTouchedPaths((event as { input?: unknown }).input);
      if (touched.length > 0) {
        void this.recordCodebaseTouches(userId, touched);
      }
    }
    this.bus.publish(runId, event);
  }

  /**
   * Note the files the agent touched in the heatmap of the repository the
   * account picked. Never builds a map: an account that never picked a
   * repository has no heatmap to update.
   */
  private async recordCodebaseTouches(userId: string, touchedPaths: string[]): Promise<void> {
    try {
      const repoRoot = await selectedCodebaseRepo(userId, this.codebaseScanner);
      if (!repoRoot) return;
      await recordAgentTouches(userId, this.codebaseScanner, repoRoot, touchedPaths);
    } catch {
      // best effort
    }
  }

  /**
   * Prepend the codebase context pack to the run's system prompt.
   *
   * The pack is injected once per run (the flag on the run makes a second
   * call a no-op) and only when the account picked a repository and the pack
   * fits inside the token budget. A failure here never blocks the run.
   */
  private async maybeInjectCodebaseContext(active: ActiveRun): Promise<void> {
    if (active.codebaseContextInjected) return;
    active.codebaseContextInjected = true;
    try {
      const result = await resolveCodebaseInjection(
        active.userId,
        this.codebaseScanner,
        WORKSPACE_ROOT,
      );
      if (!result.injected || !result.text) return;
      const wrapped = wrapCodebasePack(result.text, { repoHash: result.repoHash });
      active.agentCard = active.agentCard ? `${wrapped}\n\n${active.agentCard}` : wrapped;
      this.bus.publish(active.runId, {
        type: "codebase.context.injected",
        data: {
          repoHash: result.repoHash,
          repoRoot: result.repoRoot,
          tokenEstimate: result.tokenEstimate,
        },
      });
    } catch {
      // Never block a run on the map.
    }
  }

  private finalize(runId: string, patch: TerminalPatch, drainQueue = true): void {
    // The run's LLM proxy token dies with the run.
    revokeRunToken(runId);
    revokeVaultToken(runId);
    // Any still-pending approvals for this run are moot; release their waiters
    // so a cancelled run never hangs the harness.
    getApprovalStore().expirePendingForRun(runId);
    // Pending questions for a dead run can never be answered usefully; close
    // them so the UI does not show a stale card.
    getQuestionStore().cancelPendingForRun(runId);
    // Same for a run paused on its budget: the user can no longer raise it,
    // so the gateway's hold resolves as "stop" and the run unwinds.
    getBudgetGate().release(runId);
    // The run's browser (if any) must not outlive it.
    void getBrowserManager().close(runId).catch(() => {});
    let nextUserId: string | undefined;
    for (const [userId, st] of this.users) {
      if (st.active?.runId !== runId) continue;
      const active = st.active;
      if (patch.status === "finished" && patch.sessionId) {
        setLastSession(userId, patch.sessionId).catch(() => {});
      } else if (patch.status === "error" && patch.error && isUnknownSessionError(patch.error)) {
        clearLastSession(userId).catch(() => {});
      }
      if (patch.status === "cancelled") {
        const cancelledEvent: { type: "run.cancelled"; reason: "user" | "superseded" | "shutdown" } = {
          type: "run.cancelled",
          reason: patch.cancelledReason ?? "user",
        };
        this.bus.publish(runId, cancelledEvent);
      }
      const summary: RunSummary = {
        ...this.baseSummary(active),
        status: patch.status,
        startedAt: active.startedAt,
        finishedAt: Date.now(),
        exitCode: patch.exitCode,
        error: patch.error,
        sessionId: patch.sessionId ?? active.sessionId,
        costUsd: patch.costUsd,
        durationMs: patch.durationMs,
        numTurns: patch.numTurns,
        cancelledReason: patch.cancelledReason,
        kind: "agent",
        ...(patch.verification ? { verification: patch.verification } : {}),
      };
      st.active = null;
      this.cancelling.delete(runId);
      st.history.unshift(summary);
      if (st.history.length > HISTORY_LIMIT) st.history.length = HISTORY_LIMIT;
      nextUserId = userId;
      break;
    }
    // Persist the cleared slot and the still-queued prompts before possibly
    // draining the queue, so a crash during the next run cannot resurrect a
    // finished run or lose a queued one.
    this.persistState();
    if (nextUserId !== undefined && drainQueue) this.startNext(nextUserId);
  }
}

/**
 * Process-wide singleton, lazily created (same globalThis pattern as the
 * telemetry bus so route handlers and the server share one process).
 */
const g = globalThis as typeof globalThis & { __swarmRuntimeManager?: RuntimeManager };
export function getRuntimeManager(): RuntimeManager {
  if (g.__swarmRuntimeManager) return g.__swarmRuntimeManager;
  const manager = new RuntimeManager({ stateStore: new RunStateStore() });
  g.__swarmRuntimeManager = manager;
  // Persistent VMs are hibernated after SWARM_VM_IDLE_MIN minutes of
  // inactivity; the sweeper stops them and the next run transparently
  // restarts the container (the /workspace volume is kept).
  startVmIdleSweeper(manager.vmManager, {
    onIdleWindow: (userIds) => {
      if (userIds.length === 0) return;
      void import("../gardener/tick").then((mod) => mod.runAutopilotForUsers(userIds, manager.vmManager));
    },
  });
  // Abandoned test-drives are rolled back on a background timer too
  // (hourly by default, SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC to tune):
  // the route's on-demand sweep only runs while the user is looking at
  // the library, so a drive abandoned by a user who never returns would
  // otherwise pin the VM's post-drive state forever. Users with a run
  // in flight are skipped — restoring a snapshot mid-run would clobber it.
  startTestDriveSweeper(
    (drive) => manager.vmManager.restore(drive.userId, drive.snapshotLabel),
    {
      isUserBusy: (userId) =>
        manager
          .list(userId)
          .some((run) => run.status === "running" || run.status === "queued"),
    },
  );
  return manager;
}

/** Test hook: swap the singleton for a manager backed by a fake driver. */
export function setRuntimeManagerForTesting(manager: RuntimeManager | null): void {
  g.__swarmRuntimeManager = manager ?? undefined;
}
