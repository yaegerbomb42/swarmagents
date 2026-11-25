// Team Mode — the harness contract and the VM-backed implementation.
//
// The manager only knows this interface. VmTeamHarness runs real claude
// invocations inside the user's VM through the existing ClaudeCodeRunner,
// existing provider router/key pool, and the existing per-run LLM token. The
// fake harness in manager.test.ts drives the same pipeline with no VM, no
// network and no model.

import { ClaudeCodeRunner } from "../harness/runner";
import { contextPackerFromEnv } from "../harness/context/contextGovernor";
import {
  MAX_ROLE_PHASES,
  ROLE_CATALOG_PATH,
  ROLE_MCP_SERVER_PATH,
  roleContinuationPrompt,
  roleMcpConfigJson,
  rolePhase,
} from "../harness/role-mcp";
import { getApprovalStore } from "../harness/approvals";
import { evaluateToolApproval } from "../harness/tool-approval";
import { makeRedactor } from "../harness/redact";
import { awaitRoleEscalation, createRoleEscalationApproval } from "../harness/role-escalation";
import type { ApprovalGateway, RolePhase, TelemetryEvent as HarnessEvent } from "../harness/types";
import type { RoleDefinition, RunRolePolicy } from "../roles";
import {
  BUILTIN_ROLES,
  buildRunRolePolicy,
  hasRoleEscalation,
  resolveRoleSwitch,
  roleCapabilityDelta,
} from "../roles";
import { userRoleCatalog } from "../roles-store";
import { startMemoryBridge } from "../memory/bridge";
import { memoryContextForPrompt } from "../memory/store";
import { buildMemoryPrompt } from "../memory/prompt";
import { runMemoryTool } from "../memory/tools";
import { bindExec, vmManager, type VmManager } from "../vm/manager";
import {
  applyLlmProxyEnv,
  approvalHookEnv,
  assertLocalDockerApprovalConfiguration,
  buildRunnerEnv,
  envFallback,
  resolveApprovalBaseUrl,
  resolveLlmBaseUrl,
  scrubHostCredentials,
  safeVaultEnv,
} from "../runtime/manager";
import { signRunToken } from "../runtime/run-token";
import { createCheckpointTaker } from "../runtime/checkpoints";
import { registerSynchronousApproval } from "../runtime/tool-approval-bridge";
import {
  aggregateFailureSummary,
  classifyClaudeRunError,
  isClaudeFailoverEligible,
  type AttemptInfo,
  type ClaudeSelection,
  type Router,
} from "../providers";
import {
  getLaneSpendLedger,
  isPaidProvider,
  laneProviderVerdict,
  readLanePolicy,
} from "./lane-policy";
import { laneDir, mergeDir, planFile, resultFile, reviewFile } from "./workspace";
import type { LaneResult, MergeResult, PlanDraft, ReviewResult, TeamTask } from "./types";

export interface PlanSpec {
  runId: string;
  userId: string;
  prompt: string;
  maxTasks: number;
  agentCard?: string;
  signal?: AbortSignal;
  /** Roles the user pre-granted for this team run (frozen when it started). */
  grantedRoleIds?: string[];
  /**
   * Why the previous plan was rejected on review, when this is a revision
   * round: the planner fixes exactly that and keeps what was good.
   */
  revisionNote?: string;
  /** Planner telemetry (an approval request shows up here too). */
  onEvent?: (event: HarnessEvent) => void;
}

/**
 * The pre-execution plan-review gate: the reviewer reads the planner's task
 * list before any lane starts. Same reviewer role and the same
 * {"approved", "note"} verdict protocol as a lane review — only the prompt
 * differs (the plan, not a lane result).
 */
export interface PlanReviewSpec {
  runId: string;
  userId: string;
  /** The user's goal, so the reviewer can check the plan covers it. */
  prompt: string;
  /** The planner's task list as the manager validated it. */
  plan: TeamTask[];
  /** 1 = first plan, 2 = revised plan (the gate allows one revision). */
  attempt: number;
  agentCard?: string;
  signal?: AbortSignal;
  /** Roles the user pre-granted for this team run. */
  grantedRoleIds?: string[];
  onEvent?: (event: HarnessEvent) => void;
}

export interface LaneSpec {
  runId: string;
  userId: string;
  agentId: string;
  role: RoleDefinition;
  prompt: string;
  cwd: string;
  agentCard?: string;
  signal?: AbortSignal;
  /** Roles the user pre-granted for this team run. */
  grantedRoleIds?: string[];
  onEvent: (event: HarnessEvent) => void;
}

export interface ReviewSpec {
  runId: string;
  userId: string;
  task: TeamTask;
  result: LaneResult;
  attempt: number;
  agentCard?: string;
  signal?: AbortSignal;
  /** Roles the user pre-granted for this team run. */
  grantedRoleIds?: string[];
  onEvent: (event: HarnessEvent) => void;
}

export interface MergeSpec {
  runId: string;
  userId: string;
  task: TeamTask;
  result: LaneResult;
  signal?: AbortSignal;
}

export interface TeamHarness {
  readonly id: string;
  plan(spec: PlanSpec): Promise<PlanDraft[]>;
  /** Pre-execution gate: review the plan before lanes start. */
  reviewPlan(spec: PlanReviewSpec): Promise<ReviewResult>;
  lane(spec: LaneSpec): Promise<LaneResult>;
  review(spec: ReviewSpec): Promise<ReviewResult>;
  merge(spec: MergeSpec): Promise<MergeResult>;
}

const WORKER_ROLE_IDS = [
  "implementer",
  "frontend-engineer",
  "backend-engineer",
  "debugger",
  "test-writer",
  "researcher",
  "technical-writer",
  "devops",
  "security-auditor",
];

export const PLANNER_ROLE_ID = "orchestrator";
export const REVIEWER_ROLE_ID = "code-reviewer";

export function roleById(id: string): RoleDefinition {
  return BUILTIN_ROLES.find((role) => role.id === id) ?? BUILTIN_ROLES[0];
}

export function workerRole(index: number, requested?: string): RoleDefinition {
  if (requested && WORKER_ROLE_IDS.includes(requested)) return roleById(requested);
  return roleById(WORKER_ROLE_IDS[index % WORKER_ROLE_IDS.length]);
}

export const PLANNER_ROLE = roleById(PLANNER_ROLE_ID);
export const REVIEWER_ROLE = roleById(REVIEWER_ROLE_ID);

/**
 * Per-lane --mcp-config path. Lanes run concurrently in one VM and each has
 * its own role policy/pre-grants, so they cannot share the single config file
 * a normal run writes.
 */
export function teamLaneMcpConfigPath(runId: string, agentId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return `/workspace/.swarm/mcp.team.${safe(runId)}.${safe(agentId)}.json`;
}

const PLANNER_PROMPT = (runId: string, prompt: string, maxTasks: number, revisionNote?: string) =>
  [
    "You are the Planner for a SwarmAgents team run.",
    `GOAL: ${prompt}`,
    ...(revisionNote
      ? [
          `The previous plan was rejected on review: ${revisionNote}`,
          "Fix exactly that and keep what was good.",
        ]
      : []),
    `Break the goal into 2–${maxTasks} independent tasks that can run in parallel.`,
    `Assign each task a roleId from: ${WORKER_ROLE_IDS.join(", ")}.`,
    `Write ${planFile(runId)} as a JSON array of {"title","detail","roleId"} objects — no prose, no markdown fence.`,
    "Keep each task self-contained: another agent with no context must be able to do it.",
    "Then stop.",
  ].join("\n");

/**
 * The plan-review prompt: the reviewer checks the task list against the
 * goal before any lane starts. The verdict uses the same file protocol as a
 * lane review ({"approved", "note"} in the review file), so the manager
 * reads it the same way.
 */
const PLAN_REVIEW_PROMPT = (runId: string, prompt: string, plan: TeamTask[], attempt: number) =>
  [
    `Review attempt ${attempt} for the team plan for this goal: ${prompt}`,
    `PLAN (${plan.length} tasks):`,
    ...plan.map(
      (task) => `- ${task.id}: ${task.title} [${task.roleId}] — ${task.detail}`,
    ),
    "Approve only when the tasks together cover the goal, each task is self-contained and can run in parallel with the others, and every roleId fits its task.",
    "Reject when a task is missing, duplicated, too vague to execute, or depends on another task's output.",
    `Write ${reviewFile(runId)} as {"approved": boolean, "note": "one sentence"}. When rejecting, the note must say exactly what the planner must fix.`,
  ].join("\n");

const LANE_PROMPT = (task: TeamTask, runId: string, agentId: string) =>
  [
    `TASK: ${task.title}`,
    task.detail ? `DETAIL: ${task.detail}` : "",
    `YOUR ROLE: ${task.roleId}`,
    `Work only inside ${laneDir(runId, agentId)}. Do not touch other lanes.`,
    `When the task is done, write ${resultFile(runId, agentId)} as {"summary":"what you did","files":["relative paths you wrote"]}.`,
    "Then stop.",
  ]
    .filter(Boolean)
    .join("\n");

const REVIEW_PROMPT = (runId: string, task: TeamTask, result: LaneResult, attempt: number) =>
  [
    `Review attempt ${attempt} for task: ${task.title}`,
    task.detail ? `TASK DETAIL: ${task.detail}` : "",
    `RESULT SUMMARY: ${result.summary}`,
    `RESULT FILES: ${result.files.join(", ") || "none"}`,
    `Read ${resultFile(runId, task.agentId ?? "unknown")} and the files it lists (paths are relative to ${laneDir(runId, task.agentId ?? "unknown")}).`,
    `Write ${reviewFile(runId)} as {"approved": boolean, "note": "one sentence"}.`,
    "Approve only when the result actually does the task. When rejecting, the note must say exactly what to fix.",
  ]
    .filter(Boolean)
    .join("\n");

function asJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

interface LaneRunOptions {
  runId: string;
  userId: string;
  agentId: string;
  role: RoleDefinition;
  prompt: string;
  cwd: string;
  agentCard?: string;
  signal?: AbortSignal;
  grantedRoleIds?: string[];
  onEvent?: (event: HarnessEvent) => void;
}

export interface VmTeamHarnessOptions {
  vm?: VmManager;
  runner?: ClaudeCodeRunner;
  /** Per-user router (free-first ordering lives in RuntimeManager.effectiveRouter). */
  routerForUser?: (userId: string) => Router | null;
  agentCard?: string;
  desktopMode?: boolean;
}

interface LaneRunOutcome {
  result: LaneResult;
  lastText: string;
  sessionId?: string;
}

/**
 * Real harness: every lane is one claude invocation inside the user's VM.
 * Provider selection, key rotation, cooldowns and failover come from the
 * existing router; the VM only ever holds the per-run LLM token.
 */
export class VmTeamHarness implements TeamHarness {
  readonly id = "vm";
  private readonly vm: VmManager;
  private readonly runner: ClaudeCodeRunner;
  private readonly routerForUser: (userId: string) => Router | null;
  private readonly agentCard?: string;
  private readonly desktopMode: boolean;

  constructor(opts: VmTeamHarnessOptions = {}) {
    this.vm = opts.vm ?? vmManager;
    this.runner = opts.runner ?? new ClaudeCodeRunner({ contextPacker: contextPackerFromEnv(process.env) });
    this.routerForUser = opts.routerForUser ?? (() => null);
    this.agentCard = opts.agentCard;
    this.desktopMode = opts.desktopMode ?? false;
  }

  private async readJson<T>(userId: string, path: string): Promise<T | null> {
    try {
      return asJson<T>(await this.vm.readFile(userId, path));
    } catch {
      return null;
    }
  }

  private async runLane(opts: LaneRunOptions): Promise<LaneRunOutcome> {
    // A managed Docker image always invokes its PreToolUse hook. Fail before
    // starting a lane if the VM could not possibly obtain an approval verdict.
    assertLocalDockerApprovalConfiguration(this.vm);
    const { runId, userId, agentId } = opts;
    // The agent's memory tools run against the host-side store: the in-VM MCP
    // server forwards every call over a small file RPC and this bridge
    // answers it. The bridge only lives as long as the lane.
    const memoryBridge = startMemoryBridge({
      vm: this.vm,
      userId,
      handle: (tool, args) => runMemoryTool(userId, tool, args),
    });
    // The account's long-term memory rides in the lane's system prompt.
    const memoryContext = buildMemoryPrompt(await memoryContextForPrompt(userId, opts.prompt));
    const router = this.routerForUser(userId);
    const llmBaseUrl = resolveLlmBaseUrl();
    const approvalBaseUrl = resolveApprovalBaseUrl();
    let runToken: string | null = null;
    if (llmBaseUrl || approvalBaseUrl) {
      try {
        runToken = signRunToken(userId, runId);
      } catch {
        runToken = null;
      }
    }
    const approvalEnv =
      approvalBaseUrl && runToken ? approvalHookEnv(approvalBaseUrl, runToken) : {};
    const approvalHook = Object.keys(approvalEnv).length > 0;
    // A lane is a run of its own: it inherits the user's routing policy (paid
    // providers on/off, run and day spend caps) exactly like a normal run.
    const policy = readLanePolicy(userId);
    const ledger = getLaneSpendLedger();
    // Which providers cost money is read from the user's provider file; cache
    // it so a failover loop does not re-read it for every attempt.
    const paidProviders = new Map<string, boolean>();
    const isPaid = (providerId: string): boolean => {
      const cached = paidProviders.get(providerId);
      if (cached !== undefined) return cached;
      const paid = isPaidProvider(userId, providerId);
      paidProviders.set(providerId, paid);
      return paid;
    };

    // The lane's role policy is the same one a normal run gets: its assigned
    // role plus every subset role, plus the user's pre-grants. A broader
    // switch needs the user's approval through the usual gateway. Lanes share
    // the VM, so each one gets its own --mcp-config path.
    const catalog = userRoleCatalog(userId);
    const rolePolicy: RunRolePolicy = buildRunRolePolicy(catalog, opts.role, opts.grantedRoleIds ?? []);
    const configPath = teamLaneMcpConfigPath(runId, opts.agentId);
    let currentRole = opts.role;
    let phase: RolePhase = rolePhase(currentRole, {
      desktopMode: this.desktopMode,
      mcpConfigPath: configPath,
    });
    const writeLaneConfig = async (next: RoleDefinition): Promise<RolePhase> => {
      const nextPhase = rolePhase(next, {
        desktopMode: this.desktopMode,
        mcpConfigPath: configPath,
      });
      const roleDef = catalog.find((candidate) => candidate.id === next.id) ?? next;
      const config = roleMcpConfigJson(nextPhase, {
        allowedRoleIds: new Set(rolePolicy.allowedRoleIds),
        serverPath: ROLE_MCP_SERVER_PATH,
        catalogPath: ROLE_CATALOG_PATH,
        desktopMode: this.desktopMode,
        roleDef,
      });
      await this.vm.writeFile(userId, configPath, config);
      return nextPhase;
    };
    phase = await writeLaneConfig(currentRole);

    // The same authoritative check a normal run performs. Subset switches are
    // admitted and remembered; a broader one pauses on a role_escalation
    // approval and only proceeds when the user approves it.
    let switchedPhase: RolePhase | null = null;
    const onRoleSwitch = async (request: { fromRoleId: string; toRoleId: string }): Promise<RolePhase | null> => {
      const decision = resolveRoleSwitch(catalog, new Set(rolePolicy.allowedRoleIds), request.toRoleId);
      if (decision.ok) {
        switchedPhase = await writeLaneConfig(decision.role);
        return switchedPhase;
      }
      if (decision.error === "unknown_role") return null;
      const toRole = catalog.find((candidate) => candidate.id === request.toRoleId);
      if (!toRole) return null;
      const delta = roleCapabilityDelta(rolePolicy.startingRole, toRole);
      if (!hasRoleEscalation(delta)) {
        // Newly-discovered subset role: admit it for the rest of the lane.
        if (!rolePolicy.allowedRoleIds.includes(toRole.id)) rolePolicy.allowedRoleIds.push(toRole.id);
        switchedPhase = await writeLaneConfig(toRole);
        return switchedPhase;
      }
      const approval = createRoleEscalationApproval({
        runId,
        userId,
        from: currentRole,
        to: toRole,
        baseline: rolePolicy.startingRole,
      });
      const verdict = await awaitRoleEscalation(approval, {
        publish: (event) => opts.onEvent?.(event),
        signal: opts.signal,
      });
      if (verdict !== "approved") return null;
      if (!rolePolicy.allowedRoleIds.includes(toRole.id)) rolePolicy.allowedRoleIds.push(toRole.id);
      switchedPhase = await writeLaneConfig(toRole);
      return switchedPhase;
    };

    let lastText = "";
    const lastError: { value: { message: string; exitCode?: number } | null } = { value: null };
    const failures: AttemptInfo[] = [];
    let sessionId: string | undefined;
    let prompt = opts.prompt;
    let tokens = 0;
    let costUsd = 0;
    let provider: string | undefined;
    let model: string | undefined;
    let aborted = false;
    /** Why the user's own policy refused a provider (empty when none was refused). */
    let policyRefusal = "";
    /** True when the lane ran on a provider that costs money. */
    let usedPaidProvider = false;

    const onEvent = (event: HarnessEvent) => {
      if (event.type === "assistant.text") lastText = event.text;
      else if (event.type === "usage") {
        tokens = Math.max(tokens, event.inputTokens + event.outputTokens);
      } else if (event.type === "run.finished") {
        sessionId = event.sessionId || sessionId;
        if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) costUsd = event.costUsd;
      } else if (event.type === "run.error") {
        lastError.value = { message: event.message, exitCode: event.exitCode };
      }
      opts.onEvent?.(event);
    };

    // Team lanes own their own event stream (never the RuntimeManager bus),
    // so the auto-checkpoint taker keeps its own per-lane step counter.
    // Created once per lane invocation, before the phase loop — creating it
    // inside the per-tool-call handler would reset the counter every call.
    const takeCheckpoint = createCheckpointTaker(this.vm, userId, runId, agentId);

    // Phase loop: a validated switch resumes the same conversation under the
    // new role. Capped so a switching loop cannot run forever.
    for (let phaseIndex = 0; ; phaseIndex++) {
      const exhausted = new Set<string>();
      let switchedTo: { toRoleId: string; sessionId?: string } | null = null;

      for (let attempt = 0; attempt < 8; attempt++) {
        let selection: ClaudeSelection | null = null;
        try {
          selection = router ? router.selectForClaude({ model: currentRole.model || undefined }, exhausted) : null;
        } catch {
          selection = null;
        }

        if (selection) {
          // The user's own policy has the last word on the provider: a paid
          // provider is skipped when paid providers are off, and no lane runs
          // past the user's run/day spend caps.
          const verdict = laneProviderVerdict({
            policy,
            ledger,
            userId,
            runId,
            providerId: selection.provider,
            isPaid,
          });
          if (!verdict.allowed) {
            selection.release();
            exhausted.add(selection.provider);
            policyRefusal = verdict.reason;
            continue;
          }
        } else if (policyRefusal) {
          // The only provider this account had was refused by the user's own
          // policy: fail the lane instead of quietly running on the host env.
          lastError.value = { message: policyRefusal };
          break;
        }

        // The provider selection supplies the lane's own auth. Every host
        // credential the selection did not provide is dropped, so the server's
        // keys never reach the lane (same rule as a normal run).
        const providerEnv = selection ? applyLlmProxyEnv(selection, llmBaseUrl, runToken) : null;
        const env = {
          ...(providerEnv
            ? scrubHostCredentials({ ...buildRunnerEnv(), ...providerEnv }, providerEnv)
            : envFallback()),
          ...approvalEnv,
          ...safeVaultEnv(userId, runId, llmBaseUrl || approvalBaseUrl),
        };

        let outcome;
        // A lane is not a RuntimeManager active run, so its synchronous approval
        // handler lives in the bridge registry for exactly this invocation.
        const unregisterApproval = approvalHook
          ? registerSynchronousApproval(runId, userId, async (toolName, input) => {
              const store = getApprovalStore();
              return evaluateToolApproval({
                toolName,
                input,
                emit: onEvent,
                signal: opts.signal,
                redact: makeRedactor({}),
                takeCheckpoint,
                createApproval: (ask) => {
                  const approval = store.create({
                    runId,
                    userId,
                    toolName: ask.toolName,
                    action: ask.action,
                    reason: ask.reason,
                  });
                  return {
                    id: approval.id,
                    expiresAt: approval.expiresAt,
                    timedOut: () => store.get(approval.id)?.timedOut === true,
                    verdict: store.waitFor(approval.id),
                  };
                },
              });
            })
          : () => {};
        try {
          outcome = await this.runner.run(
            {
              prompt,
              agentCard: this.agentCard ?? opts.agentCard,
              memoryContext,
              model: currentRole.model || undefined,
              provider: selection?.provider,
              env,
              vm: bindExec(this.vm, userId),
              cwd: opts.cwd,
              signal: opts.signal,
              redactSecrets: selection?.secrets,
              rolePhase: phase,
              // With the in-VM hook the verdict is synchronous with execution;
              // without it the post-hoc gateway remains the fallback.
              approvalHook,
              // Every lane tool call goes through the same approval path as a
              // normal run: an "ask" pauses the lane until the user approves or
              // denies it, a "deny" is blocked outright.
              approvalGateway: this.approvalGateway(runId, userId),
              onRoleSwitch,
              ...(sessionId ? { sessionId } : {}),
            },
            onEvent,
          );
        } catch (err) {
          lastError.value = { message: err instanceof Error ? err.message : String(err) };
          break;
        } finally {
          unregisterApproval();
        }

        provider = selection?.provider ?? provider;
        model = selection?.model ?? model;
        if (selection && isPaid(selection.provider)) usedPaidProvider = true;
        if (outcome.roleSwitch) {
          switchedTo = outcome.roleSwitch;
          selection?.release();
          break;
        }
        if (outcome.aborted || opts.signal?.aborted) {
          aborted = true;
          selection?.release();
          break;
        }

        const error = lastError.value;
        if (!error) {
          selection?.settle({ ok: true });
          break;
        }

        const parsed = selection ? classifyClaudeRunError(error.message) : null;
        if (selection && isClaudeFailoverEligible(error.message)) {
          selection.settle({ ok: false, kind: parsed?.kind, status: parsed?.status });
          exhausted.add(selection.provider);
          failures.push({
            provider: selection.provider,
            model: selection.model,
            keyId: selection.keyId,
            ok: false,
            kind: parsed?.kind,
            status: parsed?.status,
            error: error.message,
            latencyMs: 0,
          });
          lastError.value = null;
          continue;
        }

        selection?.settle({ ok: false, kind: "unknown" });
        break;
      }

      if (!switchedTo) break;
      const nextRole = catalog.find((candidate) => candidate.id === switchedTo!.toRoleId);
      if (!nextRole || !switchedPhase || phaseIndex + 1 >= MAX_ROLE_PHASES) {
        lastError.value = {
          message:
            phaseIndex + 1 >= MAX_ROLE_PHASES
              ? `Too many role switches (max ${MAX_ROLE_PHASES}) in one lane.`
              : `Role "${switchedTo.toRoleId}" is no longer available.`,
        };
        break;
      }
      const fromRole = currentRole;
      currentRole = nextRole;
      sessionId = switchedTo.sessionId ?? sessionId;
      prompt = roleContinuationPrompt(fromRole, nextRole);
      phase = switchedPhase;
    }

    memoryBridge.stop();

    // The lane's spend counts against the user's run/day caps (only a paid
    // provider spends anything: a free provider is billed at $0).
    if (usedPaidProvider) ledger.record(runId, userId, costUsd);

    const error = lastError.value;
    const result: LaneResult = {
      ok: !aborted && !error,
      summary: lastText.slice(0, 4000),
      files: [],
      tokens,
      costUsd,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(!aborted && error
        ? { error: failures.length > 0 ? aggregateFailureSummary(failures) : error.message }
        : {}),
    };
    return { result, lastText, ...(sessionId ? { sessionId } : {}) };
  }

  /**
   * The approval gate for a lane's tool calls. The same in-memory approval
   * store the runtime uses: an "ask" creates a pending approval the user
   * decides on (POST /api/runtime/approvals/{id}); nobody deciding before the
   * TTL denies it, exactly like an unattended run.
   */
  private approvalGateway(runId: string, userId: string): ApprovalGateway {
    return async (ask) => {
      const store = getApprovalStore();
      const approval = store.create({
        runId,
        userId,
        toolName: ask.toolName,
        action: ask.action,
        reason: ask.reason,
      });
      return {
        id: approval.id,
        expiresAt: approval.expiresAt,
        timedOut: () => store.get(approval.id)?.timedOut === true,
        verdict: store.waitFor(approval.id),
      };
    };
  }

  async plan(spec: PlanSpec): Promise<PlanDraft[]> {
    const { result } = await this.runLane({
      runId: spec.runId,
      userId: spec.userId,
      agentId: "planner",
      role: PLANNER_ROLE,
      prompt: PLANNER_PROMPT(spec.runId, spec.prompt, spec.maxTasks, spec.revisionNote),
      cwd: `${laneDir(spec.runId, "planner")}`,
      agentCard: spec.agentCard,
      signal: spec.signal,
      grantedRoleIds: spec.grantedRoleIds,
      onEvent: spec.onEvent,
    });

    const written = await this.readJson<PlanDraft[]>(spec.userId, planFile(spec.runId));
    const parsed = written ?? asJson<PlanDraft[]>(result.summary);

    const drafts = (Array.isArray(parsed) ? parsed : [])
      .map((item) => {
        const row = item as { title?: unknown; detail?: unknown; roleId?: unknown };
        return {
          title: String(row?.title ?? "").trim(),
          detail: String(row?.detail ?? "").trim(),
          roleId: String(row?.roleId ?? "").trim(),
        };
      })
      .filter((item) => item.title.length > 0)
      .slice(0, spec.maxTasks);

    if (drafts.length < 2) throw new Error("planner returned fewer than 2 usable tasks");
    return drafts;
  }

  /**
   * Plan-review gate: the reviewer role reads the plan (same role, same
   * verdict file, same JSON protocol as a lane review) before lanes start.
   * Runs before any lane, so the review file it writes is never confused
   * with a lane review.
   */
  async reviewPlan(spec: PlanReviewSpec): Promise<ReviewResult> {
    const { result } = await this.runLane({
      runId: spec.runId,
      userId: spec.userId,
      agentId: "reviewer",
      role: REVIEWER_ROLE,
      prompt: PLAN_REVIEW_PROMPT(spec.runId, spec.prompt, spec.plan, spec.attempt),
      cwd: `${laneDir(spec.runId, "reviewer")}`,
      agentCard: spec.agentCard,
      signal: spec.signal,
      grantedRoleIds: spec.grantedRoleIds,
      onEvent: spec.onEvent,
    });

    const written = await this.readJson<{ approved?: unknown; note?: unknown }>(
      spec.userId,
      reviewFile(spec.runId),
    );
    const fallback = asJson<{ approved?: unknown; note?: unknown }>(result.summary);
    const verdict = written ?? fallback;
    const approved = verdict?.approved === true;
    const note = String(verdict?.note ?? (approved ? "accepted" : "rejected without a note")).slice(0, 400);
    return { approved, note, tokens: result.tokens, costUsd: result.costUsd };
  }

  async lane(spec: LaneSpec): Promise<LaneResult> {
    const { result } = await this.runLane({
      runId: spec.runId,
      userId: spec.userId,
      agentId: spec.agentId,
      role: spec.role,
      prompt: spec.prompt,
      cwd: spec.cwd,
      agentCard: spec.agentCard,
      signal: spec.signal,
      grantedRoleIds: spec.grantedRoleIds,
      onEvent: spec.onEvent,
    });

    const written = await this.readJson<{ summary?: string; files?: unknown }>(
      spec.userId,
      resultFile(spec.runId, spec.agentId),
    );
    if (written && typeof written.summary === "string" && written.summary.trim()) {
      const files = Array.isArray(written.files)
        ? written.files.map((file) => String(file)).filter(Boolean)
        : [];
      return { ...result, ok: true, summary: written.summary.slice(0, 4000), files };
    }
    return result;
  }

  async review(spec: ReviewSpec): Promise<ReviewResult> {
    const { result } = await this.runLane({
      runId: spec.runId,
      userId: spec.userId,
      agentId: "reviewer",
      role: REVIEWER_ROLE,
      prompt: REVIEW_PROMPT(spec.runId, spec.task, spec.result, spec.attempt),
      cwd: `${laneDir(spec.runId, "reviewer")}`,
      agentCard: spec.agentCard,
      signal: spec.signal,
      grantedRoleIds: spec.grantedRoleIds,
      onEvent: spec.onEvent,
    });

    const written = await this.readJson<{ approved?: unknown; note?: unknown }>(
      spec.userId,
      reviewFile(spec.runId),
    );
    const fallback = asJson<{ approved?: unknown; note?: unknown }>(result.summary);
    const verdict = written ?? fallback;
    const approved = verdict?.approved === true;
    const note = String(verdict?.note ?? (approved ? "accepted" : "rejected without a note")).slice(0, 400);
    return { approved, note, tokens: result.tokens, costUsd: result.costUsd };
  }

  async merge(spec: MergeSpec): Promise<MergeResult> {
    const dest = mergeDir(spec.runId);
    const base = laneDir(spec.runId, spec.task.agentId ?? "lane");
    const files: string[] = [];
    const rel = spec.result.files.length ? spec.result.files : ["result.json"];

    for (const file of rel) {
      const source = file.startsWith("/") ? file : `${base}/${file}`;
      const name = source.split("/").pop() || "result.txt";
      const target = `${dest}/${spec.task.id}-${name}`;
      try {
        const made = await this.vm.exec(spec.userId, ["mkdir", "-p", dest]);
        if (made.exitCode !== 0) break;
        const copied = await this.vm.exec(spec.userId, ["cp", source, target]);
        if (copied.exitCode === 0) files.push(target);
      } catch {
        /* a lane may reference a file it never wrote; skip it */
      }
    }

    if (!files.length) {
      const target = `${dest}/${spec.task.id}.md`;
      try {
        await this.vm.writeFile(
          spec.userId,
          target,
          `# ${spec.task.title}\n\n${spec.result.summary || "(no summary)"}\n`,
        );
        files.push(target);
      } catch {
        return { files: [], note: "merge failed: could not write the summary" };
      }
    }
    return { files, note: `merged ${files.length} file(s)` };
  }
}

export { LANE_PROMPT };