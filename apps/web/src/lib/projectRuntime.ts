/**
 * Persistent project runtime for long-horizon decomp runs.
 * Milestones as hard gates, ship checkpoints, role/depth reallocation from remaining time.
 */

import type { DecompSessionRecord } from '@/lib/decompSessions';
import { phaseLabelsForBudget, formatMinutes } from '@/lib/timeBudget';

export type MilestoneId =
  | 'foundation'
  | 'mvp'
  | 'quality'
  | 'expand'
  | 'iterate'
  | 'ship';

export type Milestone = {
  id: MilestoneId;
  label: string;
  /** Fraction of wall-clock budget by which this gate must be reached (0–1). */
  dueByRatio: number;
  /** Fraction of leaves that should be completed to pass (0–1). */
  minLeafRatio: number;
  status: 'pending' | 'active' | 'passed' | 'missed';
  passedAt?: number;
};

export type ShipCheckpoint = {
  id: string;
  milestoneId: MilestoneId;
  label: string;
  status: 'pending' | 'verifying' | 'passed' | 'failed';
  verifiedAt?: number;
  notes?: string;
};

export type RoleAllocation = {
  roleId: string;
  weight: number; // 0–1 share of upcoming leaf work
  reason: string;
};

export type ProjectRuntime = {
  version: 1;
  ambition: string;
  budgetMinutes: number;
  milestones: Milestone[];
  checkpoints: ShipCheckpoint[];
  roleAllocation: RoleAllocation[];
  /** Suggested max Hamiltonian steps per leaf given remaining time. */
  leafStepBudget: number;
  /** Suggested execute batch size. */
  batchSize: number;
  /** Max deepen rounds remaining aspiration. */
  deepenBudget: number;
  /** Cumulative tool steps across the session (toward multi-thousand). */
  trajectorySteps: number;
  /** Soft target for total trajectory steps. */
  trajectoryTarget: number;
  currentMilestoneId: MilestoneId;
  lastTickAt: number;
  events: Array<{ at: number; level: 'info' | 'warn' | 'action'; message: string }>;
};

const ROLE_SETS: Record<string, RoleAllocation[]> = {
  foundation: [
    { roleId: 'architect', weight: 0.35, reason: 'contracts & structure' },
    { roleId: 'implementer', weight: 0.35, reason: 'scaffold' },
    { roleId: 'researcher', weight: 0.2, reason: 'discovery' },
    { roleId: 'verifier', weight: 0.1, reason: 'smoke checks' },
  ],
  mvp: [
    { roleId: 'implementer', weight: 0.55, reason: 'vertical slice' },
    { roleId: 'architect', weight: 0.15, reason: 'keep coherent' },
    { roleId: 'verifier', weight: 0.2, reason: 'acceptance' },
    { roleId: 'researcher', weight: 0.1, reason: 'unblock' },
  ],
  quality: [
    { roleId: 'verifier', weight: 0.4, reason: 'tests & gates' },
    { roleId: 'implementer', weight: 0.35, reason: 'harden' },
    { roleId: 'debugger', weight: 0.15, reason: 'fix failures' },
    { roleId: 'architect', weight: 0.1, reason: 'refactors' },
  ],
  expand: [
    { roleId: 'implementer', weight: 0.5, reason: 'features' },
    { roleId: 'researcher', weight: 0.15, reason: 'scope next' },
    { roleId: 'verifier', weight: 0.2, reason: 'regression' },
    { roleId: 'architect', weight: 0.15, reason: 'boundaries' },
  ],
  iterate: [
    { roleId: 'implementer', weight: 0.4, reason: 'polish' },
    { roleId: 'verifier', weight: 0.25, reason: 'quality bar' },
    { roleId: 'debugger', weight: 0.2, reason: 'edge cases' },
    { roleId: 'architect', weight: 0.15, reason: 'simplify' },
  ],
  ship: [
    { roleId: 'verifier', weight: 0.45, reason: 'ship gate' },
    { roleId: 'implementer', weight: 0.35, reason: 'last fixes' },
    { roleId: 'architect', weight: 0.2, reason: 'release notes' },
  ],
};

function collectLeaves(nodes: any[]): any[] {
  const leaves: any[] = [];
  const walk = (list: any[]) => {
    for (const n of list || []) {
      const kids = n.children || [];
      if (!kids.length && (n.type === 'task' || n.type === 'leaf' || !n.type)) leaves.push(n);
      else if (kids.length) walk(kids);
      else leaves.push(n);
    }
  };
  walk(nodes || []);
  return leaves;
}

function ambitionLabel(budgetMinutes: number): string {
  const m = budgetMinutes || 60;
  if (m <= 60) return 'focused_slice';
  if (m <= 180) return 'solid_mvp';
  if (m <= 1440) return 'full_day_push';
  if (m <= 10080) return 'multi_day_product';
  return 'long_horizon_program';
}

/** Build milestone gates scaled to wall-clock budget. */
export function buildMilestones(budgetMinutes: number): Milestone[] {
  const phases = phaseLabelsForBudget(budgetMinutes);
  const base: Array<{ id: MilestoneId; dueByRatio: number; minLeafRatio: number }> = [
    { id: 'foundation', dueByRatio: 0.15, minLeafRatio: 0.12 },
    { id: 'mvp', dueByRatio: 0.4, minLeafRatio: 0.35 },
    { id: 'quality', dueByRatio: 0.55, minLeafRatio: 0.5 },
    { id: 'expand', dueByRatio: 0.75, minLeafRatio: 0.7 },
    { id: 'iterate', dueByRatio: 0.9, minLeafRatio: 0.85 },
    { id: 'ship', dueByRatio: 1.0, minLeafRatio: 0.95 },
  ];

  return base.map((b, i) => ({
    id: b.id,
    label: phases[Math.min(i, phases.length - 1)] || b.id,
    dueByRatio: b.dueByRatio,
    minLeafRatio: b.minLeafRatio,
    status: i === 0 ? 'active' : 'pending',
  }));
}

export function buildCheckpoints(milestones: Milestone[]): ShipCheckpoint[] {
  const all: ShipCheckpoint[] = [
    {
      id: 'cp-mvp',
      milestoneId: 'mvp',
      label: 'MVP runnable checkpoint',
      status: 'pending',
    },
    {
      id: 'cp-quality',
      milestoneId: 'quality',
      label: 'Quality bar checkpoint',
      status: 'pending',
    },
    {
      id: 'cp-ship',
      milestoneId: 'ship',
      label: 'Final ship checkpoint',
      status: 'pending',
    },
  ];
  return all.filter((c) => milestones.some((m) => m.id === c.milestoneId));
}

export function initProjectRuntime(session: DecompSessionRecord): ProjectRuntime {
  const budgetMinutes = Number(session.budget_minutes) || 60;
  const milestones = buildMilestones(budgetMinutes);
  const runtime: ProjectRuntime = {
    version: 1,
    ambition: ambitionLabel(budgetMinutes),
    budgetMinutes,
    milestones,
    checkpoints: buildCheckpoints(milestones),
    roleAllocation: ROLE_SETS.foundation,
    leafStepBudget: leafStepsForBudget(budgetMinutes, 1),
    batchSize: batchSizeForBudget(budgetMinutes),
    deepenBudget: deepenBudgetFor(budgetMinutes),
    trajectorySteps: 0,
    trajectoryTarget: trajectoryStepTarget(budgetMinutes),
    currentMilestoneId: 'foundation',
    lastTickAt: Date.now(),
    events: [
      {
        at: Date.now(),
        level: 'info',
        message: `Runtime armed for ${formatMinutes(budgetMinutes)} · ambition=${ambitionLabel(budgetMinutes)} · target≈${trajectoryStepTarget(budgetMinutes)} tool-steps`,
      },
    ],
  };
  session.runtime = runtime;
  return runtime;
}

export function ensureProjectRuntime(session: DecompSessionRecord): ProjectRuntime {
  const existing = session.runtime as ProjectRuntime | undefined;
  if (existing?.version === 1 && existing.milestones?.length) {
    if (typeof existing.trajectorySteps !== 'number') existing.trajectorySteps = 0;
    if (typeof existing.trajectoryTarget !== 'number') {
      existing.trajectoryTarget = trajectoryStepTarget(existing.budgetMinutes || 60);
    }
    return existing;
  }
  return initProjectRuntime(session);
}

function leafStepsForBudget(budgetMinutes: number, remainingRatio: number): number {
  // Per-invocation micro-steps (small models); long horizon = many continuations
  const base = budgetMinutes >= 1440 ? 16 : budgetMinutes >= 180 ? 12 : budgetMinutes >= 60 ? 10 : 8;
  if (remainingRatio < 0.2) return Math.max(4, Math.floor(base * 0.5));
  if (remainingRatio < 0.4) return Math.max(6, Math.floor(base * 0.75));
  return base;
}

function batchSizeForBudget(budgetMinutes: number): number {
  if (budgetMinutes >= 10080) return 6;
  if (budgetMinutes >= 1440) return 4;
  if (budgetMinutes >= 180) return 3;
  return 2;
}

function deepenBudgetFor(budgetMinutes: number): number {
  if (budgetMinutes >= 10080) return 80;
  if (budgetMinutes >= 1440) return 48;
  if (budgetMinutes >= 180) return 32;
  return 24;
}

/** Target total tool-steps across the whole run (multi-thousand capable). */
export function trajectoryStepTarget(budgetMinutes: number): number {
  const m = budgetMinutes || 60;
  if (m >= 10080) return 50_000;
  if (m >= 1440) return 12_000;
  if (m >= 180) return 4_000;
  if (m >= 60) return 2_000;
  return 800;
}

/** How many execute_leaves rounds the client should allow for this session. */
export function executeRoundBudget(session: DecompSessionRecord): number {
  const leaves = collectLeaves(session.nodes || []);
  const target = Number(session.target_leaves) || leaves.length || 50;
  const batch = batchSizeForBudget(Number(session.budget_minutes) || 60);
  const traj = trajectoryStepTarget(Number(session.budget_minutes) || 60);
  const perLeaf = leafStepsForBudget(Number(session.budget_minutes) || 60, 1);
  // Allow enough rounds for leaf continuations toward trajectory target
  const fromLeaves = Math.ceil((target * 8) / batch); // ~8 continuations/leaf avg
  const fromTraj = Math.ceil(traj / Math.max(1, perLeaf * batch));
  return Math.min(20_000, Math.max(200, fromLeaves, fromTraj));
}

function verifyCheckpoint(
  session: DecompSessionRecord,
  cp: ShipCheckpoint,
  completedRatio: number
): { ok: boolean; notes: string } {
  const leaves = collectLeaves(session.nodes);
  const completed = leaves.filter((n) => n.status === 'completed');
  const weak = completed.filter((n) => {
    const files = Array.isArray(n.files_written) ? n.files_written : [];
    const real = files.filter(
      (f: string) => f && !String(f).endsWith('README.md') && !String(f).includes('.swarm/')
    );
    if (real.length === 0) return true;
    const r = String(n.result || '');
    return r.length < 40;
  });

  if (cp.milestoneId === 'mvp') {
    const ok = completedRatio >= 0.3 && weak.length / Math.max(1, completed.length) < 0.4;
    return {
      ok,
      notes: ok
        ? `MVP gate: ${completed.length} leaves done, weak=${weak.length}`
        : `MVP not ready: need ~30% leaves with usable output (have ${(completedRatio * 100).toFixed(0)}%, weak=${weak.length})`,
    };
  }
  if (cp.milestoneId === 'quality') {
    const ok = completedRatio >= 0.45 && weak.length / Math.max(1, completed.length) < 0.25;
    return {
      ok,
      notes: ok
        ? `Quality gate passed (${completed.length} leaves)`
        : `Quality gate failed — too many weak leaves (${weak.length})`,
    };
  }
  // ship
  const ok = completedRatio >= 0.9 && weak.length / Math.max(1, completed.length) < 0.15;
  return {
    ok,
    notes: ok
      ? `Ship gate passed — ${(completedRatio * 100).toFixed(0)}% complete`
      : `Ship gate blocked — complete more leaves or strengthen weak outputs`,
  };
}

export type RuntimeTickResult = {
  runtime: ProjectRuntime;
  pause: boolean;
  forceShipMvp: boolean;
  preferredRoles: string[];
  leafStepBudget: number;
  batchSize: number;
  events: ProjectRuntime['events'];
  missedMilestone?: Milestone;
};

/**
 * Advance milestone gates from elapsed time + leaf completion.
 * Hard-gates: if a due milestone isn't met, force ship-MVP mode and/or pause at ship.
 */
export function tickProjectRuntime(session: DecompSessionRecord): RuntimeTickResult {
  const runtime = ensureProjectRuntime(session);
  const events: ProjectRuntime['events'] = [];
  const leaves = collectLeaves(session.nodes);
  const total = Math.max(1, leaves.length);
  const completed = leaves.filter((n) => n.status === 'completed').length;
  const completedRatio = completed / total;
  const budgetSec = Math.max(60, runtime.budgetMinutes * 60);
  const elapsed = Math.max(0, (Date.now() - (session.createdAt || Date.now())) / 1000);
  const remainingRatio = Math.max(0, 1 - elapsed / budgetSec);
  const elapsedRatio = Math.min(1, elapsed / budgetSec);

  let pause = false;
  let forceShipMvp = remainingRatio < 0.2;
  let missed: Milestone | undefined;

  // Pass / miss milestones in order
  for (const m of runtime.milestones) {
    if (m.status === 'passed' || m.status === 'missed') continue;

    const due = elapsedRatio >= m.dueByRatio;
    const met = completedRatio >= m.minLeafRatio;

    if (met && (m.status === 'active' || m.status === 'pending')) {
      m.status = 'passed';
      m.passedAt = Date.now();
      events.push({
        at: Date.now(),
        level: 'action',
        message: `Milestone passed: ${m.label} (${(completedRatio * 100).toFixed(0)}% leaves · due ${(m.dueByRatio * 100).toFixed(0)}% time)`,
      });
      const next = runtime.milestones.find((x) => x.status === 'pending');
      if (next) {
        next.status = 'active';
        runtime.currentMilestoneId = next.id;
        runtime.roleAllocation = ROLE_SETS[next.id] || ROLE_SETS.iterate;
        events.push({
          at: Date.now(),
          level: 'info',
          message: `Now focusing: ${next.label} — roles reallocated`,
        });
      }
      continue;
    }

    if (due && !met) {
      m.status = 'missed';
      missed = m;
      forceShipMvp = true;
      events.push({
        at: Date.now(),
        level: 'warn',
        message: `Milestone missed: ${m.label} — forcing ship-MVP mode on remaining leaves`,
      });
      const next = runtime.milestones.find((x) => x.status === 'pending');
      if (next) {
        next.status = 'active';
        runtime.currentMilestoneId = next.id;
        runtime.roleAllocation = ROLE_SETS.ship;
      } else {
        runtime.currentMilestoneId = 'ship';
        runtime.roleAllocation = ROLE_SETS.ship;
      }
    }
  }

  // Ensure one active milestone
  if (!runtime.milestones.some((m) => m.status === 'active')) {
    const pending = runtime.milestones.find((m) => m.status === 'pending');
    if (pending) {
      pending.status = 'active';
      runtime.currentMilestoneId = pending.id;
    } else {
      runtime.currentMilestoneId = 'ship';
    }
  }

  // Checkpoints tied to milestones
  for (const cp of runtime.checkpoints) {
    const milestone = runtime.milestones.find((m) => m.id === cp.milestoneId);
    if (!milestone) continue;
    if (cp.status === 'passed' || cp.status === 'failed') continue;

    if (milestone.status === 'passed' || milestone.status === 'missed') {
      cp.status = 'verifying';
      const verdict = verifyCheckpoint(session, cp, completedRatio);
      if (verdict.ok) {
        cp.status = 'passed';
        cp.verifiedAt = Date.now();
        cp.notes = verdict.notes;
        events.push({ at: Date.now(), level: 'action', message: `Checkpoint ✓ ${cp.label}: ${verdict.notes}` });
      } else if (milestone.status === 'missed' || elapsedRatio >= (milestone.dueByRatio + 0.05)) {
        cp.status = 'failed';
        cp.notes = verdict.notes;
        events.push({ at: Date.now(), level: 'warn', message: `Checkpoint ✗ ${cp.label}: ${verdict.notes}` });
        if (cp.milestoneId === 'ship') {
          pause = true;
          events.push({
            at: Date.now(),
            level: 'action',
            message: 'Runtime paused at final ship gate — strengthen outputs or extend budget, then resume',
          });
        } else {
          forceShipMvp = true;
        }
      } else {
        cp.status = 'pending';
      }
    }
  }

  runtime.leafStepBudget = leafStepsForBudget(runtime.budgetMinutes, remainingRatio);
  runtime.batchSize = forceShipMvp
    ? Math.max(2, batchSizeForBudget(runtime.budgetMinutes))
    : batchSizeForBudget(runtime.budgetMinutes);
  runtime.lastTickAt = Date.now();
  runtime.events = [...runtime.events, ...events].slice(-60);
  session.runtime = runtime;

  // Stamp leaves with preferred role from allocation (orchestrator hint)
  const topRole = [...runtime.roleAllocation].sort((a, b) => b.weight - a.weight)[0]?.roleId;
  if (topRole && forceShipMvp) {
    for (const leaf of leaves) {
      if (leaf.status === 'completed' || leaf.status === 'failed') continue;
      leaf.watcher_urgency = 'ship_mvp';
      if (!leaf.assignedAgent) leaf.runtimePreferredRole = topRole;
    }
  } else if (topRole) {
    let i = 0;
    const pending = leaves.filter((n) => n.status !== 'completed' && n.status !== 'failed');
    for (const leaf of pending) {
      const pick = runtime.roleAllocation[i % runtime.roleAllocation.length];
      leaf.runtimePreferredRole = pick?.roleId || topRole;
      i++;
    }
  }

  const preferredRoles = runtime.roleAllocation.map((r) => r.roleId);

  return {
    runtime,
    pause,
    forceShipMvp,
    preferredRoles,
    leafStepBudget: runtime.leafStepBudget,
    batchSize: runtime.batchSize,
    events,
    missedMilestone: missed,
  };
}
