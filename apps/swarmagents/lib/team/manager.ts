// Team Mode — the runner.
//
// One prompt becomes a team on the user's own VM:
//   planner  → 2–4 role lanes in parallel → reviewer (merge or send back)
//
// Everything runs inside the user's VM under /workspace/team/<runId>/<agentId>/.
// Lanes use the existing ClaudeCodeRunner, the existing provider router and
// key pool (free-first, cooldowns, failover) and the existing per-run LLM
// token. Telemetry is published on the normal telemetry bus under the team
// run id, so the main screen's activity strip and telemetry drawer show it.

import { randomUUID } from "node:crypto";
import { BUILTIN_ROLES, buildRunRolePolicy, type RoleDefinition } from "../roles";
import { userRoleCatalog } from "../roles-store";
import { desktopModeEnabled, rolePhase, roleSeedFiles } from "../harness/role-mcp";
import type { TelemetryEvent as HarnessEvent } from "../harness/types";
import { telemetryBus, type TelemetryBus } from "../telemetry";
import { getApprovalStore } from "../harness/approvals";
import { getRuntimeManager } from "../runtime/manager";
import { vmManager, type VmManager } from "../vm/manager";
import type { Router } from "../providers";
import {
  LANE_PROMPT,
  PLANNER_ROLE,
  VmTeamHarness,
  workerRole,
  type TeamHarness,
} from "./harness";
import { partitionTeamLanes } from "./hybrid";
import { handleSyncArtifact } from "../board/handlers";
import { withLockedStore } from "../board/store";
import {
  clearTeamRuns,
  endTeamRun,
  getTeamRun,
  hasActiveTeamRun,
  isTeamRunActive,
  latestTeamRun,
  listTeamRuns,
  ownsTeamRun,
  registerTeamRun,
} from "./store";
import { laneDir, mergeDir, plannerDir, reviewerDir, teamRoot, displayPath } from "./workspace";
import {
  DEFAULT_TEAM_SETTINGS,
  resolveTeamSettings,
  type LaneResult,
  type LaneStatus,
  type PlanDraft,
  type ReviewResult,
  type TeamLane,
  type TeamRun,
  type TeamSettings,
  type TeamTask,
} from "./types";

const MAX_LANES = 4;
const TEAM_EXEC_MS = 30 * 60_000;
const SNAPSHOT_THROTTLE_MS = 200;
const LANE_RESERVE_TOKENS = 500;

export interface StartTeamInput {
  prompt: string;
  agentCard?: string;
  settings?: Partial<TeamSettings>;
  /** Roles the user pre-granted for the team's lanes (from the composer). */
  grantedRoleIds?: string[];
  /** Paired computer id (`cmp_…`) for lanes classified as local work. */
  byocComputerId?: string;
}

export interface StartTeamResult {
  accepted: boolean;
  runId: string;
  queued?: boolean;
  limit?: number;
  error?: string;
}

export interface LaneArtifact {
  runId: string;
  agentId: string;
  taskId: string;
  computeTarget: string;
  files: string[];
  summary: string;
}

export interface TeamManagerOptions {
  vm?: VmManager;
  bus?: TelemetryBus;
  /** Injectable harness (tests use a fake with no VM or model). */
  harness?: TeamHarness;
  /** Persist a lane's merged files onto the swarm board. Tests omit this. */
  syncArtifact?: (artifact: LaneArtifact) => void;
  routerForUser?: (userId: string) => Router | null;
  agentCard?: string;
  desktopMode?: boolean;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class TeamManager {
  private readonly vm: VmManager;
  private readonly bus: TelemetryBus;
  private readonly harnessFor: (userId: string) => TeamHarness;
  private readonly routerForUser: (userId: string) => Router | null;
  private readonly agentCard?: string;
  private readonly desktopMode: boolean;
  private readonly now: () => number;
  private readonly syncArtifact?: (artifact: LaneArtifact) => void;

  private readonly controllers = new Map<string, AbortController>();
  private readonly laneControllers = new Map<string, Map<string, AbortController>>();
  private readonly lastSnapshot = new Map<string, number>();
  private readonly userLanes = new Map<string, number>();

  constructor(opts: TeamManagerOptions = {}) {
    this.vm = opts.vm ?? vmManager;
    this.bus = opts.bus ?? telemetryBus;
    this.routerForUser =
      opts.routerForUser ?? ((userId: string) => getRuntimeManager().routerForUser(userId));
    this.agentCard = opts.agentCard;
    this.desktopMode = opts.desktopMode ?? desktopModeEnabled();
    this.now = opts.now ?? Date.now;
    this.syncArtifact = opts.syncArtifact;
    this.harnessFor = (userId: string) =>
      opts.harness ??
      new VmTeamHarness({
        vm: this.vm,
        routerForUser: this.routerForUser,
        desktopMode: this.desktopMode,
        ...(this.agentCard ? { agentCard: this.agentCard } : {}),
      });
  }

  // ---- public API -------------------------------------------------------

  start(userId: string, input: StartTeamInput): StartTeamResult {
    const prompt = String(input.prompt || "").trim();
    if (!prompt) return { accepted: false, runId: "", error: "prompt is required." };
    if (hasActiveTeamRun(userId)) {
      return { accepted: false, runId: "", error: "A team run is already in flight for this account." };
    }

    const settings = resolveTeamSettings(input.settings);
    const runId = `team_${randomUUID()}`;
    const controller = new AbortController();
    const planner: TeamLane = {
      agentId: "planner",
      kind: "planner",
      roleId: PLANNER_ROLE.id,
      roleName: PLANNER_ROLE.name,
      glyph: PLANNER_ROLE.glyph,
      taskId: null,
      taskTitle: null,
      status: "running",
      currentAction: "Drafting the plan…",
      provider: "",
      model: "",
      worktree: displayPath(plannerDir(runId)),
      attempts: 0,
      turns: 0,
      tokens: 0,
      costUsd: 0,
      startedAt: this.now(),
      finishedAt: null,
      takenOver: false,
      note: null,
    };

    const run: TeamRun = {
      runId,
      userId,
      prompt,
      ...(input.grantedRoleIds && input.grantedRoleIds.length > 0
        ? { grantedRoleIds: input.grantedRoleIds }
        : {}),
      ...(input.byocComputerId ? { byocComputerId: input.byocComputerId } : {}),
      status: "planning",
      createdAt: this.now(),
      updatedAt: this.now(),
      plan: [],
      lanes: [planner],
      budget: {
        tokenCap: settings.tokenCap,
        tokensUsed: 0,
        costCapUsd: settings.costCapUsd,
        costUsedUsd: 0,
      },
      concurrency: { limit: settings.maxAgents, active: 0 },
      mergedFiles: [],
      error: null,
    };

    registerTeamRun(run);
    this.controllers.set(runId, controller);
    this.laneControllers.set(runId, new Map());
    this.publish(run, "team.run.started", { prompt: prompt.slice(0, 200), settings });
    this.snapshot(run, true);

    void this.execute(run, settings, input.agentCard).catch((err: unknown) => {
      this.fail(run, err instanceof Error ? err.message : String(err));
    });
    return { accepted: true, runId };
  }

  get(userId: string): TeamRun | undefined {
    return latestTeamRun(userId);
  }

  list(userId: string): TeamRun[] {
    return listTeamRuns(userId);
  }

  getById(userId: string, runId: string): TeamRun | undefined {
    const run = getTeamRun(runId);
    return run && run.userId === userId ? run : undefined;
  }

  isBusy(userId: string): boolean {
    return hasActiveTeamRun(userId);
  }

  cancel(userId: string, runId?: string): { ok: boolean; runId?: string } {
    const target = runId ?? latestTeamRun(userId)?.runId;
    if (!target) return { ok: false };
    const run = this.getById(userId, target);
    if (!run) return { ok: false };
    run.status = "cancelled";
    run.error = "cancelled by user";
    run.updatedAt = this.now();
    for (const lane of run.lanes) {
      if (lane.status === "queued" || lane.status === "running" || lane.status === "review" || lane.status === "rework") {
        lane.status = "paused";
        lane.currentAction = "Cancelled";
      }
    }
    this.controllers.get(run.runId)?.abort();
    this.laneControllers.get(run.runId)?.forEach((controller) => controller.abort());
    // A lane waiting on an approval must not keep waiting: the cancelled run
    // releases its pending approvals (they deny, like an expired one).
    this.expireApprovals(run.runId);
    this.publish(run, "team.run.cancelled", { runId: run.runId });
    this.snapshot(run, true);
    endTeamRun(run.runId);
    return { ok: true, runId: run.runId };
  }

  /** Hand one lane to the user: it stops taking new work and waits. */
  takeOver(userId: string, runId: string, agentId: string): TeamRun | null {
    const run = this.getById(userId, runId);
    if (!run) return null;
    const lane = run.lanes.find((item) => item.agentId === agentId);
    if (!lane) return run;
    lane.takenOver = true;
    if (lane.status !== "merged" && lane.status !== "failed") {
      lane.status = "paused";
      lane.currentAction = "You have the controls";
    }
    this.laneControllers.get(runId)?.get(agentId)?.abort();
    this.publish(run, "team.agent.takeover", { agentId, roleId: lane.roleId, worktree: lane.worktree });
    this.snapshot(run, true);
    return run;
  }

  // ---- execution --------------------------------------------------------

  private async execute(run: TeamRun, settings: TeamSettings, agentCard?: string): Promise<void> {
    const { userId } = run;
    this.bus.publish(run.runId, { type: "vm.starting", data: { userId } });
    try {
      await this.vm.ensure(userId);
      if (this.vm.quotas.diskQuotaMb > 0) await this.vm.assertDiskQuota(userId);
    } catch (err) {
      this.fail(run, err instanceof Error ? err.message : String(err));
      return;
    }
    this.bus.publish(run.runId, { type: "vm.ready", data: { userId } });

    try {
      await this.seedRoles(userId);
      await this.vm.exec(userId, ["mkdir", "-p", teamRoot(run.runId), plannerDir(run.runId), reviewerDir(run.runId)]);
    } catch (err) {
      this.fail(run, err instanceof Error ? err.message : String(err));
      return;
    }

    // 1. Planner writes the task list.
    const harness = this.harnessFor(userId);
    const planner = run.lanes[0];
    let drafts: PlanDraft[];
    try {
      drafts = await harness.plan({
        runId: run.runId,
        userId,
        prompt: run.prompt,
        maxTasks: settings.maxTasks,
        ...(run.grantedRoleIds ? { grantedRoleIds: run.grantedRoleIds } : {}),
        ...(agentCard ? { agentCard } : {}),
        signal: this.controllers.get(run.runId)?.signal,
        onEvent: this.laneEventSink(run, planner),
      });
    } catch (err) {
      planner.status = "failed";
      planner.currentAction = "Planning failed";
      planner.finishedAt = this.now();
      this.fail(run, err instanceof Error ? err.message : String(err));
      return;
    }

    const plan: TeamTask[] = drafts.slice(0, settings.maxTasks).map((draft, index) => ({
      id: `t${index + 1}`,
      title: draft.title.slice(0, 160),
      detail: draft.detail.slice(0, 600),
      roleId: draft.roleId || workerRole(index).id,
      status: "pending",
    }));
    run.plan = plan;
    planner.turns = 1;
    planner.currentAction = `Plan ready — ${plan.length} tasks`;
    this.publish(run, "team.plan", { prompt: run.prompt.slice(0, 200), tasks: plan.map((task) => ({ id: task.id, title: task.title, roleId: task.roleId })) });

    // 1b. Plan-review gate: the reviewer reads the plan before any lane
    // starts. One revision round — a rejected plan goes back to the
    // planner once with the reviewer's note; a second rejection fails the
    // run with that reason, so no lane ever runs on a bad plan.
    const gatedPlan = await this.reviewPlanGate(run, harness, plan, settings, agentCard);
    if (!gatedPlan) return;
    planner.status = "merged";
    planner.currentAction = `Plan ready — ${gatedPlan.length} tasks`;
    planner.finishedAt = this.now();
    this.snapshot(run, true);

    // 2. Lanes: never more than the user's cap, never more than one lane per task.
    const laneCount = Math.max(1, Math.min(gatedPlan.length, settings.maxAgents, MAX_LANES));
    const planned = partitionTeamLanes({
      taskCount: gatedPlan.length,
      texts: gatedPlan.map((task) => `${task.title}\n${task.detail}`),
      laneCount,
      byocComputerId: run.byocComputerId,
    });
    const lanes: { lane: TeamLane; queue: TeamTask[] }[] = [];
    for (let index = 0; index < planned.length; index++) {
      const queue = planned[index].taskIndexes.map((taskIndex) => gatedPlan[taskIndex]).filter(Boolean);
      if (!queue.length) continue;
      const role = workerRole(index, queue[0].roleId);
      const lane: TeamLane = {
        agentId: `a${index + 1}`,
        kind: "worker",
        roleId: role.id,
        roleName: role.name,
        glyph: role.glyph,
        taskId: queue[0].id,
        taskTitle: queue[0].title,
        status: "queued",
        currentAction: "Queued",
        provider: "",
        model: "",
        worktree: displayPath(laneDir(run.runId, `a${index + 1}`)),
        attempts: 0,
        turns: 0,
        tokens: 0,
        costUsd: 0,
        startedAt: null,
        finishedAt: null,
        takenOver: false,
        note: null,
        computeTarget: planned[index].computeTarget,
        computePlacement: planned[index].placement,
      };
      queue.forEach((task) => {
        task.agentId = lane.agentId;
      });
      run.lanes.push(lane);
      lanes.push({ lane, queue });
      await this.vm.exec(userId, ["mkdir", "-p", laneDir(run.runId, lane.agentId)]).catch(() => undefined);
    }
    run.concurrency.limit = laneCount;
    this.ensureVmCapacity(laneCount);
    run.status = "running";
    this.snapshot(run, true);

    // 3. Run lanes in parallel, review, rework once, merge.
    let stopped = false;
    const release = await this.acquireUserLanes(userId, laneCount);
    run.concurrency.active = lanes.length;
    this.snapshot(run, true);
    try {
      await Promise.all(
        lanes.map(async ({ lane, queue }) => {
          for (const task of queue) {
            if (stopped || this.controllers.get(run.runId)?.signal.aborted) {
              task.status = "failed";
              continue;
            }
            if (lane.takenOver) {
              task.status = "pending";
              lane.currentAction = "Paused — you have the controls";
              this.snapshot(run, true);
              continue;
            }
            const outcome = await this.runTask(run, harness, lane, task, settings, agentCard);
            if (outcome === "budget" || outcome === "cancelled") {
              stopped = true;
            }
          }
        }),
      );
    } finally {
      release();
      run.concurrency.active = 0;
    }

    // 4. Settle the run.
    if (run.status === "running") {
      const merged = run.plan.filter((task) => task.status === "merged").length;
      run.status = merged === run.plan.length && run.plan.length > 0 ? "completed" : "failed";
      if (run.status === "failed" && !run.error) {
        run.error = `${merged}/${run.plan.length} tasks merged`;
      }
    }
    run.updatedAt = this.now();
    this.snapshot(run, true);
    this.bus.publish(run.runId, {
      type: "run.finished",
      exitCode: run.status === "completed" ? 0 : 1,
      sessionId: run.runId,
      costUsd: run.budget.costUsedUsd,
      durationMs: run.updatedAt - run.createdAt,
    } as HarnessEvent);
    this.expireApprovals(run.runId);
    endTeamRun(run.runId);
  }

  /**
   * Pre-execution plan-review gate. The reviewer (same role, same verdict
   * protocol as a lane review) reads the plan before any lane starts.
   *
   * One revision round, then the run proceeds or fails: round 1 rejects go
   * back to the planner with the reviewer's note; a round 2 rejection fails
   * the run with that reason. Returns the plan to execute, or null when the
   * run failed (the caller returns without starting lanes).
   */
  private async reviewPlanGate(
    run: TeamRun,
    harness: TeamHarness,
    initialPlan: TeamTask[],
    settings: TeamSettings,
    agentCard?: string,
  ): Promise<TeamTask[] | null> {
    const planner = run.lanes[0];
    let current = initialPlan;
    let note: string | null = null;
    for (let round = 1; round <= 2; round++) {
      let verdict: ReviewResult;
      try {
        verdict = await harness.reviewPlan({
          runId: run.runId,
          userId: run.userId,
          prompt: run.prompt,
          plan: current,
          attempt: round,
          ...(run.grantedRoleIds ? { grantedRoleIds: run.grantedRoleIds } : {}),
          ...(agentCard ? { agentCard } : {}),
          signal: this.controllers.get(run.runId)?.signal,
          onEvent: this.laneEventSink(run, planner),
        });
      } catch (err) {
        verdict = {
          approved: false,
          note: `plan reviewer crashed: ${err instanceof Error ? err.message : String(err)}`,
          tokens: 0,
          costUsd: 0,
        };
      }
      run.budget.tokensUsed = Math.min(run.budget.tokenCap, run.budget.tokensUsed + verdict.tokens);
      run.budget.costUsedUsd = Math.round(
        (run.budget.costUsedUsd + Math.max(0, verdict.costUsd)) * 1_000_000,
      ) / 1_000_000;
      note = verdict.note;
      this.publish(run, "team.plan.review", { attempt: round, approved: verdict.approved, note: verdict.note });
      this.snapshot(run, true);
      if (verdict.approved) {
        run.planReview = { rounds: round, approved: true, note };
        return current;
      }
      if (round === 2) break;

      // One revision round: the planner revises with the reviewer's note.
      planner.currentAction = "Revising the plan…";
      planner.turns += 1;
      this.snapshot(run, true);
      let drafts: PlanDraft[];
      try {
        drafts = await harness.plan({
          runId: run.runId,
          userId: run.userId,
          prompt: run.prompt,
          maxTasks: settings.maxTasks,
          revisionNote: verdict.note,
          ...(run.grantedRoleIds ? { grantedRoleIds: run.grantedRoleIds } : {}),
          ...(agentCard ? { agentCard } : {}),
          signal: this.controllers.get(run.runId)?.signal,
          onEvent: this.laneEventSink(run, planner),
        });
      } catch (err) {
        this.fail(run, err instanceof Error ? err.message : String(err));
        return null;
      }
      current = drafts.slice(0, settings.maxTasks).map((draft, index) => ({
        id: `t${index + 1}`,
        title: draft.title.slice(0, 160),
        detail: draft.detail.slice(0, 600),
        roleId: draft.roleId || workerRole(index).id,
        status: "pending" as const,
      }));
      run.plan = current;
      planner.currentAction = `Plan revised — ${current.length} tasks`;
      this.publish(run, "team.plan", {
        prompt: run.prompt.slice(0, 200),
        tasks: current.map((task) => ({ id: task.id, title: task.title, roleId: task.roleId })),
      });
      this.snapshot(run, true);
    }
    run.planReview = { rounds: 2, approved: false, note };
    planner.status = "failed";
    planner.currentAction = "Plan rejected on review";
    planner.finishedAt = this.now();
    this.fail(run, `Plan rejected on review: ${note ?? "no reason given"}`);
    return null;
  }

  /**
   * Release the approvals this run is still waiting on. A lane that is paused
   * on an approval must never outlive its run: the pending approvals deny, the
   * same way an expired one does.
   */
  private expireApprovals(runId: string): void {
    getApprovalStore().expirePendingForRun(runId);
  }

  /**
   * Team lanes are long-running by design and run in parallel, so the VM's
   * host-safety quotas must leave room for them. Only ever raise a limit to
   * the requested lane count (never above MAX_LANES), never lower it.
   */
  private ensureVmCapacity(lanes: number): void {
    const quotas = this.vm.quotas;
    if (quotas.maxConcurrentExecsPerUser > 0 && quotas.maxConcurrentExecsPerUser < lanes) {
      quotas.maxConcurrentExecsPerUser = lanes;
    }
    if (quotas.maxExecDurationMs > 0 && quotas.maxExecDurationMs < TEAM_EXEC_MS) {
      quotas.maxExecDurationMs = TEAM_EXEC_MS;
    }
  }

  private async runTask(
    run: TeamRun,
    harness: TeamHarness,
    lane: TeamLane,
    task: TeamTask,
    settings: TeamSettings,
    agentCard?: string,
  ): Promise<"ok" | "failed" | "budget" | "cancelled" | "paused"> {
    const controller = new AbortController();
    this.laneControllers.get(run.runId)?.set(lane.agentId, controller);
    if (this.controllers.get(run.runId)?.signal.aborted) return "cancelled";

    task.status = "active";
    lane.taskId = task.id;
    lane.taskTitle = task.title;
    lane.status = "running";
    lane.startedAt = lane.startedAt ?? this.now();
    lane.currentAction = "Starting…";
    this.snapshot(run, true);
    this.publish(run, "team.agent.started", {
      agentId: lane.agentId,
      roleId: lane.roleId,
      taskId: task.id,
      taskTitle: task.title,
      worktree: lane.worktree,
    });

    const role = this.roleFor(lane.roleId);
    let approved = false;
    let result: LaneResult | null = null;
    let note = "";

    for (let attempt = 1; attempt <= settings.maxAttempts && !approved; attempt++) {
      if (controller.signal.aborted || this.controllers.get(run.runId)?.signal.aborted) return "cancelled";
      lane.attempts = attempt;
      lane.turns += 1;
      if (attempt > 1) {
        lane.status = "rework";
        lane.currentAction = "Fixing review feedback…";
        task.status = "rework";
        this.publish(run, "team.agent.rework", { agentId: lane.agentId, taskId: task.id, attempt, note });
        this.snapshot(run, true);
      }

      const reserved = estimateTokens(`${task.title} ${task.detail}`) + LANE_RESERVE_TOKENS;
      if (run.budget.tokensUsed + reserved > run.budget.tokenCap) {
        run.status = "failed";
        run.error = `team token budget exhausted: ${run.budget.tokensUsed}+${reserved} > ${run.budget.tokenCap}`;
        task.status = "failed";
        lane.status = "failed";
        lane.currentAction = "Stopped — token budget exhausted";
        lane.finishedAt = this.now();
        this.publish(run, "team.budget", {
          agentId: lane.agentId,
          taskId: task.id,
          tokensUsed: run.budget.tokensUsed,
          tokenCap: run.budget.tokenCap,
        });
        this.snapshot(run, true);
        return "budget";
      }
      run.budget.tokensUsed += reserved;

      const laneController = controller;
      const onEvent = this.laneEventSink(run, lane);
      try {
        result = await harness.lane({
          runId: run.runId,
          userId: run.userId,
          agentId: lane.agentId,
          role,
          prompt: LANE_PROMPT(task, run.runId, lane.agentId),
          cwd: laneDir(run.runId, lane.agentId),
          ...(run.grantedRoleIds ? { grantedRoleIds: run.grantedRoleIds } : {}),
          ...(agentCard ? { agentCard } : {}),
          signal: laneController.signal,
          onEvent,
        });
      } catch (err) {
        result = {
          ok: false,
          summary: "",
          files: [],
          tokens: 0,
          costUsd: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const actual = Math.max(0, result.tokens);
      run.budget.tokensUsed = Math.max(0, Math.min(run.budget.tokenCap, run.budget.tokensUsed - reserved + actual));
      lane.tokens += actual;
      const cost = Math.max(0, result.costUsd || 0);
      lane.costUsd = Math.round((lane.costUsd + cost) * 1_000_000) / 1_000_000;
      run.budget.costUsedUsd = Math.round((run.budget.costUsedUsd + cost) * 1_000_000) / 1_000_000;
      if (result.provider) lane.provider = result.provider;
      if (result.model) lane.model = result.model;

      if (run.budget.costUsedUsd > run.budget.costCapUsd) {
        run.status = "failed";
        run.error = `team cost budget exhausted: $${run.budget.costUsedUsd.toFixed(4)} > $${run.budget.costCapUsd}`;
        task.status = "failed";
        lane.status = "failed";
        this.publish(run, "team.budget", {
          agentId: lane.agentId,
          taskId: task.id,
          costUsedUsd: run.budget.costUsedUsd,
          costCapUsd: run.budget.costCapUsd,
        });
        this.snapshot(run, true);
        return "budget";
      }

      // Reviewer checks the result.
      lane.status = "review";
      lane.currentAction = "Reviewing…";
      this.snapshot(run, true);
      let verdict: ReviewResult;
      try {
        verdict = await harness.review({
          runId: run.runId,
          userId: run.userId,
          task,
          result,
          attempt,
          ...(run.grantedRoleIds ? { grantedRoleIds: run.grantedRoleIds } : {}),
          ...(agentCard ? { agentCard } : {}),
          signal: controller.signal,
          onEvent: this.laneEventSink(run, lane),
        });
      } catch (err) {
        verdict = {
          approved: false,
          note: `reviewer crashed: ${err instanceof Error ? err.message : String(err)}`,
          tokens: 0,
          costUsd: 0,
        };
      }
      run.budget.tokensUsed = Math.min(run.budget.tokenCap, run.budget.tokensUsed + verdict.tokens);
      run.budget.costUsedUsd = Math.round((run.budget.costUsedUsd + Math.max(0, verdict.costUsd)) * 1_000_000) / 1_000_000;
      note = verdict.note;
      this.publish(run, "team.review", {
        agentId: lane.agentId,
        taskId: task.id,
        attempt,
        approved: verdict.approved,
        note: verdict.note,
      });

      if (verdict.approved) {
        approved = true;
        task.status = "passed";
        lane.note = verdict.note;
        task.summary = result.summary;
      } else {
        task.status = "rework";
        task.note = verdict.note;
        lane.note = verdict.note;
      }
      this.snapshot(run, true);
    }

    if (!approved || !result) {
      task.status = "failed";
      lane.status = "failed";
      lane.currentAction = note || "Rejected after rework";
      lane.finishedAt = this.now();
      this.publish(run, "team.agent.finished", {
        agentId: lane.agentId,
        taskId: task.id,
        status: "failed",
        tokens: lane.tokens,
        costUsd: lane.costUsd,
      });
      this.snapshot(run, true);
      return "failed";
    }

    // Merge.
    lane.currentAction = "Merging…";
    this.snapshot(run, true);
    try {
      const merge = await harness.merge({
        runId: run.runId,
        userId: run.userId,
        task,
        result,
        signal: controller.signal,
      });
      if (merge.files.length) {
        task.status = "merged";
        lane.status = "merged";
        lane.currentAction = merge.note || "Merged";
        run.mergedFiles.push(...merge.files);
        try {
          this.syncArtifact?.({
            runId: run.runId,
            agentId: lane.agentId,
            taskId: task.id,
            computeTarget: lane.computeTarget ?? "cloud",
            files: merge.files.slice(0, 50),
            summary: (result.summary || "").slice(0, 500),
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          lane.note = lane.note ? `${lane.note} (artifact sync failed: ${detail})` : `artifact sync failed: ${detail}`;
        }
      } else {
        task.status = "failed";
        lane.status = "failed";
        lane.currentAction = merge.note || "Merge failed";
      }
    } catch (err) {
      task.status = "failed";
      lane.status = "failed";
      lane.currentAction = err instanceof Error ? err.message : "Merge failed";
    }
    lane.finishedAt = this.now();
    this.publish(run, "team.agent.finished", {
      agentId: lane.agentId,
      taskId: task.id,
      status: lane.status,
      tokens: lane.tokens,
      costUsd: lane.costUsd,
      files: run.mergedFiles.length,
    });
    this.snapshot(run, true);
    return lane.status === "merged" ? "ok" : "failed";
  }

  // ---- helpers ----------------------------------------------------------

  private roleFor(roleId: string): RoleDefinition {
    return BUILTIN_ROLES.find((role) => role.id === roleId) ?? workerRole(0);
  }

  private async seedRoles(userId: string): Promise<void> {
    const catalog = userRoleCatalog(userId);
    // Seed the shared server script + catalog and a planner-scoped default
    // config. Lanes write their own per-lane config under this policy (see
    // VmTeamHarness.runLane), so a lane never inherits the whole catalog.
    const allowed = new Set(buildRunRolePolicy(catalog, PLANNER_ROLE).allowedRoleIds);
    const phase = rolePhase(PLANNER_ROLE, { desktopMode: this.desktopMode });
    for (const file of roleSeedFiles(catalog, allowed, phase, { desktopMode: this.desktopMode })) {
      await this.vm.writeFile(userId, file.path, file.content);
    }
  }

  private laneEventSink(run: TeamRun, lane: TeamLane): (event: HarnessEvent) => void {
    return (event) => {
      if (event.type === "assistant.text") lane.currentAction = event.text.slice(0, 140);
      else if (event.type === "tool.call") lane.currentAction = `${event.name}…`;
      else if (event.type === "run.started") {
        if (event.provider) lane.provider = event.provider;
        if (event.model) lane.model = event.model;
        lane.currentAction = "Working…";
      } else if (event.type === "approval.required") {
        // The lane asked for permission: show the request in the lane so the
        // user can approve or deny it from the team panel.
        lane.approval = {
          id: event.approval.id,
          tool: event.approval.tool,
          action: event.approval.action,
          reason: event.approval.reason,
          expiresAt: event.approval.expiresAt ?? 0,
        };
        lane.currentAction = "Waiting for your approval…";
        this.snapshot(run, true);
      } else if (event.type === "approval.resolved" || event.type === "approval.timeout") {
        if (lane.approval && lane.approval.id === event.id) {
          lane.approval = undefined;
          lane.currentAction =
            event.type === "approval.timeout"
              ? "Approval expired — the lane stopped"
              : event.verdict === "denied"
                ? "Approval denied — the lane stopped"
                : "Approved — continuing";
        }
        this.snapshot(run, true);
      } else if (event.type === "run.finished" || event.type === "run.error") {
        // The team owns terminal events: many lanes share one stream.
        return;
      }
      this.bus.publish(run.runId, event);
    };
  }

  private publish(run: TeamRun, type: string, data: Record<string, unknown>): void {
    this.bus.publish(run.runId, { type, data: { runId: run.runId, ...data } });
  }

  private snapshot(run: TeamRun, force = false): void {
    run.updatedAt = this.now();
    const last = this.lastSnapshot.get(run.runId) ?? 0;
    const now = this.now();
    if (!force && now - last < SNAPSHOT_THROTTLE_MS) return;
    this.lastSnapshot.set(run.runId, now);
    this.bus.publish(run.runId, { type: "team.run", data: clone(run) });
  }

  private fail(run: TeamRun, message: string): void {
    if (run.status === "cancelled") return;
    run.status = "failed";
    run.error = message;
    for (const lane of run.lanes) {
      if (lane.status === "running" || lane.status === "queued" || lane.status === "review") {
        lane.status = "failed";
        lane.currentAction = "Stopped";
      }
    }
    this.controllers.get(run.runId)?.abort();
    this.expireApprovals(run.runId);
    this.publish(run, "team.run.failed", { error: message });
    this.bus.publish(run.runId, { type: "run.error", message } as HarnessEvent);
    this.snapshot(run, true);
    endTeamRun(run.runId);
  }

  /** Per-user lane gate: never more than `limit` team agents at once. */
  private async acquireUserLanes(userId: string, limit: number): Promise<() => void> {
    const cap = Math.max(1, limit);
    const deadline = Date.now() + 30_000;
    while ((this.userLanes.get(userId) ?? 0) >= cap) {
      if (Date.now() > deadline) throw new Error("team lane concurrency wait timed out");
      await sleep(5);
    }
    this.userLanes.set(userId, (this.userLanes.get(userId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.userLanes.set(userId, Math.max(0, (this.userLanes.get(userId) ?? 1) - 1));
    };
  }

  laneCount(userId: string): number {
    return this.userLanes.get(userId) ?? 0;
  }
}

const g = globalThis as typeof globalThis & { __swarmTeamManager?: TeamManager };

export function getTeamManager(): TeamManager {
  if (!g.__swarmTeamManager) {
    g.__swarmTeamManager = new TeamManager({
      syncArtifact: (artifact) => {
        void withLockedStore(async (store) => {
          const result = await handleSyncArtifact(store, { ...artifact } as Record<string, unknown>);
          if ("error" in result) {
            console.error("[team] artifact sync failed:", result.error.message);
          }
          return result;
        }).catch((err: unknown) => {
          console.error("[team] artifact sync failed:", err instanceof Error ? err.message : String(err));
        });
      },
    });
  }
  return g.__swarmTeamManager;
}

export function setTeamManagerForTesting(manager: TeamManager | null): void {
  if (manager) g.__swarmTeamManager = manager;
  else delete g.__swarmTeamManager;
}

export {
  clearTeamRuns,
  endTeamRun,
  getTeamRun,
  hasActiveTeamRun,
  isTeamRunActive,
  latestTeamRun,
  listTeamRuns,
  ownsTeamRun,
};