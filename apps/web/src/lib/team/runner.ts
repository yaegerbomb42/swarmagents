/**
 * Team Mode — the runner.
 *
 * plan → parallel lanes → review → merge, with three hard limits:
 *   • concurrency: per-user agent cap (default 3) folded with provider quotas
 *   • tokens: reserved before each attempt, reconciled after it
 *   • tools: every lane runs with its role tools ∩ the user's allow-list
 *
 * The harness is injectable; the fake harness in team.test.ts drives this exact
 * code path with no LLM and no network.
 */

import { loadProvidersStore, type StoredProvider } from '@/lib/providerStore';
import { getAgentRoleById } from '@/lib/agentRoles';
import { createTeamRun, emitTeamEvent, getTeamRun, updateTeamRun } from './registry';
import { createAgentWorkspace, displayWorkspace } from './workspace';
import {
  estimateCostUsd,
  estimateTokens,
  nextRoute,
  providerConcurrencyCap,
  type TeamRoute,
} from './providerRotation';
import {
  EngineTeamHarness,
  toolsForRole,
  workerRoleFor,
  type TeamHarness,
} from './harness';
import {
  resolveTeamSettings,
  type AgentResult,
  type TeamAgentLane,
  type TeamPlanItem,
  type TeamRun,
  type TeamSettings,
  type TeamTaskDraft,
} from './types';

export class TeamBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamBudgetError';
  }
}

export interface StartTeamInput {
  prompt: string;
  userId?: string;
  settings?: Partial<TeamSettings>;
  harness?: TeamHarness;
  /** Injectable provider list (tests); defaults to the dashboard store. */
  providers?: StoredProvider[] | null;
}

export function newTeamRunId(): string {
  return `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Per-user agent gate, shared by every run in this process.
const g = globalThis as typeof globalThis & { __swarmTeamUserSlots?: Map<string, number> };
function userSlots(): Map<string, number> {
  if (!g.__swarmTeamUserSlots) g.__swarmTeamUserSlots = new Map();
  return g.__swarmTeamUserSlots;
}

export async function acquireUserSlot(userId: string, limit: number): Promise<() => void> {
  const key = userId || 'local';
  const slots = userSlots();
  const deadline = Date.now() + 30_000;
  while ((slots.get(key) ?? 0) >= Math.max(1, limit)) {
    if (Date.now() > deadline) throw new Error('team concurrency wait timed out');
    await sleep(5);
  }
  slots.set(key, (slots.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.set(key, Math.max(0, (slots.get(key) ?? 1) - 1));
  };
}

export function userSlotCount(userId: string): number {
  return userSlots().get(userId || 'local') ?? 0;
}

export function resetUserSlots(): void {
  userSlots().clear();
}

function plannerLane(route: TeamRoute | null): TeamAgentLane {
  const role = getAgentRoleById('planner')!;
  return {
    agentId: 'planner',
    kind: 'planner',
    roleId: role.id,
    roleName: role.name,
    glyph: 'P',
    color: role.color,
    taskId: null,
    taskTitle: null,
    status: 'running',
    currentAction: 'Drafting the plan…',
    provider: route?.provider ?? 'engine',
    model: route?.model ?? 'default',
    worktree: 'team',
    attempts: 0,
    tokens: 0,
    costUsd: 0,
    startedAt: Date.now(),
    finishedAt: null,
    takenOver: false,
    lastNote: null,
  };
}

function reviewerLane(): TeamAgentLane {
  const role = getAgentRoleById('reviewer')!;
  return {
    agentId: 'reviewer',
    kind: 'reviewer',
    roleId: role.id,
    roleName: role.name,
    glyph: 'R',
    color: role.color,
    taskId: null,
    taskTitle: null,
    status: 'queued',
    currentAction: 'Waiting for results',
    provider: 'engine',
    model: 'default',
    worktree: 'team/review',
    attempts: 0,
    tokens: 0,
    costUsd: 0,
    startedAt: null,
    finishedAt: null,
    takenOver: false,
    lastNote: null,
  };
}

function workerLane(index: number, route: TeamRoute | null, draft: TeamTaskDraft): TeamAgentLane {
  const role = workerRoleFor(index, draft.roleId);
  return {
    agentId: `a${index + 1}`,
    kind: 'worker',
    roleId: role.id,
    roleName: role.name,
    glyph: role.name.slice(0, 1).toUpperCase(),
    color: role.color,
    taskId: null,
    taskTitle: null,
    status: 'queued',
    currentAction: 'Queued',
    provider: route?.provider ?? 'engine',
    model: route?.model ?? 'default',
    worktree: 'team',
    attempts: 0,
    tokens: 0,
    costUsd: 0,
    startedAt: null,
    finishedAt: null,
    takenOver: false,
    lastNote: null,
  };
}

function reserveTokens(run: TeamRun, task: TeamPlanItem): number {
  const estimate = estimateTokens(`${task.title} ${task.detail}`) + 32;
  if (run.budget.tokensUsed + estimate > run.budget.tokenCap) {
    throw new TeamBudgetError(
      `team token budget exceeded: ${run.budget.tokensUsed}+${estimate} > ${run.budget.tokenCap}`,
    );
  }
  run.budget.tokensUsed += estimate;
  return estimate;
}

function reconcileTokens(run: TeamRun, reserved: number, result: AgentResult): void {
  const next = run.budget.tokensUsed - reserved + Math.max(0, result.tokens);
  run.budget.tokensUsed = Math.max(0, Math.min(run.budget.tokenCap, next));
}

export async function startTeamRun(input: StartTeamInput): Promise<TeamRun> {
  const settings = resolveTeamSettings(input.settings);
  const harness = input.harness ?? new EngineTeamHarness();
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');

  let providers: StoredProvider[] = [];
  if (input.providers !== undefined) providers = input.providers ?? [];
  else {
    try {
      providers = (await loadProvidersStore()).providers;
    } catch {
      providers = [];
    }
  }

  const first = nextRoute(providers, 0);
  const providerCap = providers.length ? providerConcurrencyCap(providers) : settings.maxAgents;
  const run: TeamRun = {
    runId: newTeamRunId(),
    goal: prompt,
    status: 'planning',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: [],
    agents: [plannerLane(first.route)],
    budget: {
      tokenCap: settings.tokenCap,
      tokensUsed: 0,
      costCapUsd: settings.costCapUsd,
      costUsedUsd: 0,
    },
    concurrency: {
      limit: Math.max(1, Math.min(settings.maxAgents, providerCap, 4)),
      active: 0,
    },
    mergedFiles: [],
    error: null,
    rotationCursor: first.cursor,
    userId: input.userId || 'local',
  };
  createTeamRun(run);
  emitTeamEvent(run, 'team.run.started', { goal: prompt, settings });

  // The run proceeds in the background; the caller gets the run immediately.
  void executeRun(run, harness, settings, providers).catch((err: unknown) => {
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
    emitTeamEvent(run, 'team.run.failed', { error: run.error });
  });
  return run;
}

async function executeRun(
  run: TeamRun,
  harness: TeamHarness,
  settings: TeamSettings,
  providers: StoredProvider[],
): Promise<void> {
  const planner = run.agents[0];
  run.status = 'planning';
  updateTeamRun(run);

  let drafts: TeamTaskDraft[];
  try {
    drafts = await harness.plan({
      prompt: run.goal,
      runId: run.runId,
      settings,
      routes: [],
    });
  } catch (err) {
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
    planner.status = 'failed';
    planner.currentAction = 'Planning failed';
    planner.finishedAt = Date.now();
    emitTeamEvent(run, 'team.plan.failed', { error: run.error });
    emitTeamEvent(run, 'team.run.finished', { status: run.status, error: run.error });
    return;
  }

  const plan: TeamPlanItem[] = drafts.slice(0, settings.maxTasks).map((d, i) => {
    const role = getAgentRoleById(d.roleId);
    return {
      id: `t${i + 1}`,
      title: d.title.slice(0, 160),
      detail: (d.detail || '').slice(0, 600),
      roleId: role && !['planner', 'reviewer'].includes(role.id) ? role.id : workerRoleFor(i).id,
      status: 'pending',
    };
  });
  run.plan = plan;
  planner.status = 'merged';
  planner.currentAction = `Plan ready — ${plan.length} tasks`;
  planner.finishedAt = Date.now();
  emitTeamEvent(run, 'team.plan', {
    goal: run.goal,
    tasks: plan.map((t) => ({ id: t.id, title: t.title, roleId: t.roleId })),
  });

  const reviewer = reviewerLane();
  run.agents.push(reviewer);
  run.status = 'running';
  updateTeamRun(run);

  // Lanes: never more than the user's cap, never more than one per task.
  const laneCount = Math.max(1, Math.min(plan.length, run.concurrency.limit, 4));
  const lanes: { lane: TeamAgentLane; queue: TeamPlanItem[] }[] = [];
  for (let i = 0; i < laneCount; i++) {
    const queue = plan.filter((_, idx) => idx % laneCount === i);
    if (!queue.length) continue;
    const route = nextRoute(providers, run.rotationCursor);
    run.rotationCursor = route.cursor;
    const lane = workerLane(i, route.route, queue[0]);
    lane.worktree = displayWorkspace(`${run.runId}/${lane.agentId}`);
    run.agents.push(lane);
    queue.forEach((t) => {
      t.agentId = lane.agentId;
    });
    lanes.push({ lane, queue });
  }
  updateTeamRun(run);

  let stopped = false;
  const release = await acquireUserSlot(run.userId, run.concurrency.limit);
  run.concurrency.active = lanes.length;

  const worker = async ({ lane, queue }: { lane: TeamAgentLane; queue: TeamPlanItem[] }) => {
    try {
      for (const task of queue) {
        if (stopped) {
          task.status = 'failed';
          updateTeamRun(run);
          continue;
        }
        if (lane.takenOver) {
          task.status = 'pending';
          lane.currentAction = 'Paused — you have the controls';
          updateTeamRun(run);
          continue;
        }

        task.status = 'active';
        lane.taskId = task.id;
        lane.taskTitle = task.title;
        lane.status = 'running';
        lane.startedAt = lane.startedAt ?? Date.now();
        lane.currentAction = 'Starting…';
        updateTeamRun(run);
        emitTeamEvent(run, 'team.agent.started', {
          agentId: lane.agentId,
          roleId: lane.roleId,
          taskId: task.id,
          taskTitle: task.title,
          provider: lane.provider,
          model: lane.model,
          worktree: lane.worktree,
        });

        let approved = false;
        let verdictNote = '';
        let finalResult: AgentResult | null = null;
        let reserved = 0;
        let workspace = '';

        for (let attempt = 1; attempt <= settings.maxAttempts && !approved; attempt++) {
          if (stopped) break;
          lane.attempts = attempt;
          if (attempt > 1) {
            lane.status = 'rework';
            lane.currentAction = 'Fixing review feedback…';
            task.status = 'rework';
            updateTeamRun(run);
            emitTeamEvent(run, 'team.agent.rework', {
              agentId: lane.agentId,
              taskId: task.id,
              attempt,
              note: verdictNote,
            });
          }

          try {
            reserved = reserveTokens(run, task);
          } catch (err) {
            stopped = true;
            run.status = 'failed';
            run.error = err instanceof Error ? err.message : String(err);
            task.status = 'failed';
            lane.status = 'failed';
            lane.currentAction = 'Stopped — budget exhausted';
            emitTeamEvent(run, 'team.budget', {
              agentId: lane.agentId,
              taskId: task.id,
              tokensUsed: run.budget.tokensUsed,
              tokenCap: run.budget.tokenCap,
            });
            updateTeamRun(run);
            return;
          }

          const role = getAgentRoleById(lane.roleId) || workerRoleFor(0);
          const tools = toolsForRole(role, settings);
          workspace = await createAgentWorkspace(run.runId, lane.agentId);
          lane.worktree = displayWorkspace(workspace);

          try {
            const result = await harness.execute({
              runId: run.runId,
              task,
              role,
              tools,
              workspace,
              attempt,
              route:
                providers.length && lane.provider !== 'engine'
                  ? {
                      provider: lane.provider,
                      providerId: '',
                      model: lane.model,
                      tier: 'free',
                      maxConcurrency: 1,
                    }
                  : null,
              onAction: (action) => {
                lane.currentAction = action;
                updateTeamRun(run);
              },
            });
            finalResult = result;
            reconcileTokens(run, reserved, result);
            const cost = estimateCostUsd(lane.provider, result.tokens);
            lane.tokens += result.tokens;
            lane.costUsd = Math.round((lane.costUsd + cost) * 1_000_000) / 1_000_000;
            run.budget.costUsedUsd = Math.round((run.budget.costUsedUsd + cost) * 1_000_000) / 1_000_000;
          } catch (err) {
            stopped = true;
            run.status = 'failed';
            run.error = err instanceof Error ? err.message : String(err);
            task.status = 'failed';
            lane.status = 'failed';
            lane.currentAction = 'Crashed';
            emitTeamEvent(run, 'team.agent.crashed', { agentId: lane.agentId, taskId: task.id, error: run.error });
            updateTeamRun(run);
            return;
          }

          if (run.budget.costUsedUsd > run.budget.costCapUsd) {
            stopped = true;
            run.status = 'failed';
            run.error = `team cost budget exceeded: $${run.budget.costUsedUsd.toFixed(4)} > $${run.budget.costCapUsd}`;
            emitTeamEvent(run, 'team.budget', {
              agentId: lane.agentId,
              taskId: task.id,
              costUsedUsd: run.budget.costUsedUsd,
              costCapUsd: run.budget.costCapUsd,
            });
          }

          lane.currentAction = 'Reviewing…';
          lane.status = 'review';
          task.status = 'active';
          reviewer.status = 'running';
          reviewer.startedAt = reviewer.startedAt ?? Date.now();
          reviewer.taskId = task.id;
          reviewer.taskTitle = task.title;
          reviewer.currentAction = `Reviewing ${task.title}`;
          updateTeamRun(run);

          let verdict;
          try {
            verdict = await harness.review({ task, result: finalResult, attempt, route: null });
          } catch (err) {
            verdict = {
              approved: false,
              note: `reviewer crashed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          verdictNote = verdict.note;
          reviewer.status = 'queued';
          reviewer.currentAction = 'Waiting for results';
          emitTeamEvent(run, 'team.review', {
            agentId: lane.agentId,
            taskId: task.id,
            attempt,
            approved: verdict.approved,
            note: verdict.note,
          });

          if (verdict.approved) {
            approved = true;
            task.status = 'passed';
            lane.lastNote = verdict.note;
          } else {
            task.status = 'rework';
            lane.lastNote = verdict.note;
          }
          updateTeamRun(run);
          if (stopped) return;
        }

        if (!approved || !finalResult) {
          task.status = 'failed';
          lane.status = 'failed';
          lane.currentAction = verdictNote || 'Rejected after rework';
          lane.finishedAt = Date.now();
          emitTeamEvent(run, 'team.agent.finished', {
            agentId: lane.agentId,
            taskId: task.id,
            status: 'failed',
            tokens: lane.tokens,
            costUsd: lane.costUsd,
          });
          updateTeamRun(run);
          if (stopped) return;
          continue;
        }

        lane.currentAction = 'Merging…';
        updateTeamRun(run);
        try {
          const merge = await harness.merge({
            runId: run.runId,
            task,
            result: finalResult,
            workspace,
          });
          if (merge.merged) {
            task.status = 'merged';
            lane.status = 'merged';
            lane.currentAction = merge.note || 'Merged';
            run.mergedFiles.push(...merge.files);
          } else {
            task.status = 'failed';
            lane.status = 'failed';
            lane.currentAction = merge.note || 'Merge failed';
          }
        } catch (err) {
          task.status = 'failed';
          lane.status = 'failed';
          lane.currentAction = err instanceof Error ? err.message : 'Merge failed';
        }
        lane.finishedAt = Date.now();
        emitTeamEvent(run, 'team.agent.finished', {
          agentId: lane.agentId,
          taskId: task.id,
          status: lane.status,
          tokens: lane.tokens,
          costUsd: lane.costUsd,
          files: run.mergedFiles.length,
        });
        updateTeamRun(run);
        if (stopped) return;
      }
    } finally {
      if (lane.status === 'queued' || lane.status === 'running' || lane.status === 'review') {
        lane.status = lane.takenOver ? 'paused' : 'failed';
      }
    }
  };

  try {
    await Promise.all(lanes.map((l) => worker(l)));
  } finally {
    release();
    run.concurrency.active = 0;
  }

  if (reviewer.status === 'running') reviewer.status = 'queued';
  reviewer.finishedAt = Date.now();
  if (!stopped) {
    const merged = run.plan.filter((t) => t.status === 'merged').length;
    run.status = merged === run.plan.length && run.plan.length > 0 ? 'completed' : 'failed';
    if (run.status === 'failed' && !run.error) {
      run.error = `${merged}/${run.plan.length} tasks merged`;
    }
    if (run.status === 'completed') reviewer.status = 'merged';
  }
  emitTeamEvent(run, 'team.run.finished', {
    status: run.status,
    merged: run.plan.filter((t) => t.status === 'merged').length,
    total: run.plan.length,
    tokens: run.budget.tokensUsed,
    costUsd: run.budget.costUsedUsd,
    ...(run.error ? { error: run.error } : {}),
  });
}

/** Hand one lane to the user: it stops taking new work and waits. */
export function takeOverAgent(runId: string, agentId: string): TeamRun | null {
  const run = getTeamRun(runId);
  if (!run) return null;
  const lane = run.agents.find((a) => a.agentId === agentId);
  if (!lane) return run;
  lane.takenOver = true;
  if (lane.status !== 'merged' && lane.status !== 'failed') {
    lane.status = 'paused';
    lane.currentAction = 'You have the controls';
  }
  emitTeamEvent(run, 'team.agent.takeover', {
    agentId,
    roleId: lane.roleId,
    worktree: lane.worktree,
  });
  return run;
}

export function cancelTeamRun(runId: string): TeamRun | null {
  const run = getTeamRun(runId);
  if (!run) return null;
  run.status = 'cancelled';
  for (const lane of run.agents) {
    if (lane.status === 'queued' || lane.status === 'running' || lane.status === 'review') {
      lane.status = 'paused';
      lane.currentAction = 'Cancelled';
    }
  }
  emitTeamEvent(run, 'team.run.cancelled', {});
  return run;
}

export async function runTeamToCompletion(input: StartTeamInput): Promise<TeamRun> {
  const run = await startTeamRun(input);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = getTeamRun(run.runId);
    if (!current) break;
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      return current;
    }
    await sleep(10);
  }
  return getTeamRun(run.runId) ?? run;
}