import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTeamRuns,
  getTeamRunEvents,
  resetUserSlots,
  runTeamToCompletion,
  toolsForRole,
  type AgentResult,
  type ExecuteInput,
  type MergeInput,
  type PlanInput,
  type ReviewInput,
  type TeamHarness,
  type TeamTaskDraft,
} from './index';
import { getAgentRoleById } from '@/lib/agentRoles';
import { nextRoute, rankProviders } from './providerRotation';
import type { StoredProvider } from '@/lib/providerStore';
import { estimateTokens } from './providerRotation';

/**
 * Fake harness: drives the real runner (plan → parallel lanes → review →
 * merge) without an LLM or a network. It deliberately makes task t2 fail its
 * first review so the rework path is exercised too.
 */
class FakeHarness implements TeamHarness {
  readonly id = 'fake';
  active = 0;
  maxActive = 0;
  started: string[] = [];
  attempts = new Map<string, number>();
  reviews: { taskId: string; attempt: number; approved: boolean }[] = [];
  workspaces = new Set<string>();
  private readonly holdMs: number;
  private readonly taskCount: number;

  constructor(opts: { holdMs?: number; tasks?: number } = {}) {
    this.holdMs = opts.holdMs ?? 25;
    this.taskCount = opts.tasks ?? 3;
  }

  async plan(_input: PlanInput): Promise<TeamTaskDraft[]> {
    const roles = ['implementer', 'qa-engineer', 'researcher', 'devops-engineer'];
    return Array.from({ length: this.taskCount }, (_, i) => ({
      title: `Task ${String.fromCharCode(65 + i)}`,
      detail: `do ${String.fromCharCode(97 + i)}`,
      roleId: roles[i % roles.length],
    }));
  }

  async execute(input: ExecuteInput): Promise<AgentResult> {
    this.started.push(input.task.id);
    this.attempts.set(input.task.id, (this.attempts.get(input.task.id) ?? 0) + 1);
    this.workspaces.add(input.workspace);
    expect(input.workspace).toContain(input.runId);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, this.holdMs));
    this.active -= 1;
    return {
      ok: true,
      summary: `${input.task.title} complete`,
      files: [`${input.workspace}/${input.task.id}.md`],
      tokens: 5,
    };
  }

  async review(input: ReviewInput) {
    const approved = !(input.task.id === 't2' && input.attempt === 1);
    this.reviews.push({ taskId: input.task.id, attempt: input.attempt, approved });
    return approved
      ? { approved: true, note: 'looks good' }
      : { approved: false, note: 'add the missing test' };
  }

  async merge(input: MergeInput) {
    return {
      merged: true,
      files: input.result.files.map((f) => `merged/${input.task.id}.md`),
      note: 'merged',
    };
  }
}

const PROVIDERS: StoredProvider[] = [];
const tinyPlan = { tokenCap: 80 };

beforeEach(() => {
  clearTeamRuns();
  resetUserSlots();
  process.env.TEAM_WORKSPACE_ROOT = '/tmp/swarm-team-test';
});

afterEach(() => {
  delete process.env.TEAM_WORKSPACE_ROOT;
});

describe('team runner — fake harness', () => {
  it('runs a 3-task plan in parallel, sends one task back, and merges everything', async () => {
    const harness = new FakeHarness({ holdMs: 30 });
    const run = await runTeamToCompletion({
      prompt: 'Build the onboarding flow',
      userId: 'parallel-user',
      harness,
      providers: PROVIDERS,
    });

    // 3 tasks → 3 lanes → genuinely parallel.
    expect(run.plan).toHaveLength(3);
    expect(harness.maxActive).toBe(3);
    expect(run.concurrency.limit).toBe(3);

    // t2 was rejected once, then fixed on the rework attempt.
    expect(harness.attempts.get('t2')).toBe(2);
    expect(harness.reviews.filter((r) => r.taskId === 't2' && !r.approved)).toHaveLength(1);

    // The final merge lands for every task.
    expect(run.status).toBe('completed');
    expect(run.plan.map((t) => t.status)).toEqual(['merged', 'merged', 'merged']);
    expect(run.mergedFiles).toHaveLength(3);
    expect(run.error).toBeNull();

    // Telemetry: plan, agent starts, reviews, finishes.
    const actions = getTeamRunEvents(run.runId).map((e) => e.action);
    expect(actions).toContain('team.plan');
    expect(actions.filter((a) => a === 'team.agent.started')).toHaveLength(3);
    expect(actions.filter((a) => a === 'team.review')).toHaveLength(4);
    expect(actions.filter((a) => a === 'team.agent.finished')).toHaveLength(3);
    expect(actions[actions.length - 1]).toBe('team.run.finished');

    // Every lane got its own folder under the run directory.
    for (const dir of harness.workspaces) {
      expect(dir.startsWith('/tmp/swarm-team-test/')).toBe(true);
    }
    expect(new Set([...harness.workspaces].map((w) => w.split('/').pop())).size).toBe(3);
  });

  it('caps concurrency at the user setting', async () => {
    const harness = new FakeHarness({ holdMs: 20, tasks: 4 });
    const run = await runTeamToCompletion({
      prompt: 'Four things',
      userId: 'capped-user',
      settings: { maxAgents: 2, maxTasks: 4 },
      harness,
      providers: PROVIDERS,
    });

    expect(run.concurrency.limit).toBe(2);
    expect(harness.maxActive).toBe(2);
    expect(run.status).toBe('completed');
    expect(run.plan.every((t) => t.status === 'merged')).toBe(true);
  });

  it('stops the run when the team token budget is exhausted', async () => {
    const harness = new FakeHarness({ holdMs: 5 });
    const run = await runTeamToCompletion({
      prompt: 'Three tiny tasks',
      userId: 'budget-user',
      settings: tinyPlan,
      harness,
      providers: PROVIDERS,
    });

    // Each task reserves estimateTokens(...) + 32; only two fit under 80.
    const perTask = estimateTokens('Task A do a') + 32;
    expect(perTask * 2).toBeLessThanOrEqual(80);
    expect(perTask * 3).toBeGreaterThan(80);

    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/budget/i);
    expect(run.budget.tokensUsed).toBeLessThanOrEqual(run.budget.tokenCap);
    expect(harness.started).toHaveLength(2);
    expect(harness.started).not.toContain('t3');
    expect(run.plan.find((t) => t.id === 't3')?.status).toBe('failed');
  });

  it('never gives an agent a tool the user disallowed', () => {
    const role = getAgentRoleById('implementer')!;
    expect(role.tools).toContain('edit');
    const limited = toolsForRole(role, {
      maxAgents: 3,
      maxTasks: 4,
      tokenCap: 1000,
      costCapUsd: 1,
      maxAttempts: 2,
      allowedTools: ['shell'],
    });
    expect(limited).toEqual(['shell']);
  });
});

describe('team provider rotation — free first', () => {
  const provider = (over: Partial<StoredProvider>): StoredProvider => ({
    id: over.id || over.type || 'p',
    name: over.name || over.type || 'p',
    type: over.type || 'openai',
    endpoint: '',
    models: over.models || ['m1'],
    quota: over.quota || { rpm: 60, tpm: 1000, dailyBudget: 10, maxConcurrency: 2 },
    enabled: over.enabled ?? true,
    ...over,
  });

  it('orders free providers before paid ones and rotates keys', () => {
    const providers = [
      provider({ id: 'azure', type: 'azure', name: 'Azure', quota: { rpm: 60, tpm: 1000, dailyBudget: 50, maxConcurrency: 8 } }),
      provider({ id: 'cerebras', type: 'cerebras', name: 'Cerebras', models: ['c1', 'c2'], quota: { rpm: 60, tpm: 1000, dailyBudget: 0, maxConcurrency: 2 } }),
      provider({ id: 'groq', type: 'groq', name: 'Groq', models: ['g1'], quota: { rpm: 60, tpm: 1000, dailyBudget: 0, maxConcurrency: 4 } }),
      provider({ id: 'off', type: 'openai', name: 'Off', enabled: false }),
    ];

    expect(rankProviders(providers).map((p) => p.id)).toEqual(['groq', 'cerebras', 'azure']);

    const a = nextRoute(providers, 0);
    const b = nextRoute(providers, 1);
    const c = nextRoute(providers, 2);
    expect(a.route?.provider).toBe('Groq');
    expect(a.route?.tier).toBe('free');
    expect(b.route?.provider).toBe('Cerebras');
    expect(c.route?.provider).toBe('Azure');
    expect(c.route?.tier).toBe('paid');
  });
});