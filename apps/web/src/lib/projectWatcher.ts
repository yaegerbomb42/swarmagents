/**
 * Persistent project watcher — time + leaf QA, delegates milestone gates to projectRuntime.
 */

import type { DecompSessionRecord } from '@/lib/decompSessions';
import {
  ensureProjectRuntime,
  tickProjectRuntime,
  type ProjectRuntime,
} from '@/lib/projectRuntime';

export type WatcherEvent = {
  at: number;
  level: 'info' | 'warn' | 'action';
  message: string;
  leafId?: string;
};

export type WatcherTickResult = {
  ok: boolean;
  pause: boolean;
  retried: string[];
  events: WatcherEvent[];
  timeRemainingSec: number;
  paceOk: boolean;
  runtime?: ProjectRuntime;
  leafStepBudget?: number;
  batchSize?: number;
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

function elapsedSec(session: DecompSessionRecord): number {
  return Math.max(0, (Date.now() - (session.createdAt || Date.now())) / 1000);
}

function budgetSec(session: DecompSessionRecord): number {
  return Math.max(60, (Number(session.budget_minutes) || 60) * 60);
}

function leafQualityWeak(node: any): boolean {
  const files = Array.isArray(node.files_written) ? node.files_written : [];
  const realFiles = files.filter(
    (f: string) => f && !String(f).endsWith('README.md') && !String(f).includes('.swarm/')
  );
  if (realFiles.length === 0) return true;
  const result = String(node.result || '').trim();
  if (!result) return true;
  if (result.length < 40) return true;
  if (/no llm provider|failed|error:/i.test(result) && result.length < 400) return true;
  return false;
}

/** One watcher tick: runtime milestones + leaf QA + retries. */
export function tickProjectWatcher(session: DecompSessionRecord): WatcherTickResult {
  ensureProjectRuntime(session);
  const runtimeTick = tickProjectRuntime(session);

  const events: WatcherEvent[] = runtimeTick.events.map((e) => ({
    at: e.at,
    level: e.level,
    message: e.message,
  }));
  const retried: string[] = [];
  const leaves = collectLeaves(session.nodes);
  const completed = leaves.filter((n) => n.status === 'completed');
  const pending = leaves.filter((n) => !['completed', 'failed'].includes(String(n.status)));
  const elapsed = elapsedSec(session);
  const budget = budgetSec(session);
  const remaining = Math.max(0, budget - elapsed);
  const paceOk =
    runtimeTick.runtime.milestones.find((m) => m.status === 'active')?.status === 'active' &&
    !runtimeTick.missedMilestone;

  if (runtimeTick.pause || (remaining <= 0 && pending.length > 0)) {
    session.paused = true;
    session.status = 'paused';
    if (remaining <= 0 && pending.length > 0) {
      events.push({
        at: Date.now(),
        level: 'action',
        message: `Watcher paused — time budget exhausted with ${pending.length} leaf(s) left`,
      });
    }
    session.watcher = {
      role: 'project_watcher',
      lastTickAt: Date.now(),
      events: events.slice(-40),
      timeRemainingSec: remaining,
      paceOk: false,
    };
    return {
      ok: false,
      pause: true,
      retried,
      events,
      timeRemainingSec: remaining,
      paceOk: false,
      runtime: runtimeTick.runtime,
      leafStepBudget: runtimeTick.leafStepBudget,
      batchSize: runtimeTick.batchSize,
    };
  }

  for (const leaf of completed) {
    if (leaf.watcher_checked) continue;
    leaf.watcher_checked = true;
    // Validated leaves are final. Gate failures are either repairing (pending)
    // or terminal failed — do not weak-requeue either.
    if (leaf.validation_passed === true) continue;
    if (leaf.validation_passed === false || leaf.status === 'failed') continue;
    if (String(leaf.purpose || '').startsWith('gate_repair_')) continue;
    if (leafQualityWeak(leaf) && !leaf.watcher_retried) {
      leaf.watcher_retried = true;
      leaf.status = 'pending';
      leaf.result = undefined;
      leaf.quality_score = undefined;
      leaf.completedAt = undefined;
      retried.push(leaf.id);
      events.push({
        at: Date.now(),
        level: 'action',
        message: `Watcher re-queued weak leaf “${leaf.label || leaf.id}”`,
        leafId: leaf.id,
      });
    }
  }

  if (runtimeTick.forceShipMvp) {
    for (const leaf of pending.slice(0, 12)) {
      leaf.watcher_urgency = 'ship_mvp';
    }
  }

  session.watcher = {
    role: 'project_watcher',
    lastTickAt: Date.now(),
    events: events.slice(-40),
    timeRemainingSec: remaining,
    paceOk,
    leafStepBudget: runtimeTick.leafStepBudget,
    batchSize: runtimeTick.batchSize,
    currentMilestone: runtimeTick.runtime.currentMilestoneId,
  };

  return {
    ok: true,
    pause: false,
    retried,
    events,
    timeRemainingSec: remaining,
    paceOk,
    runtime: runtimeTick.runtime,
    leafStepBudget: runtimeTick.leafStepBudget,
    batchSize: runtimeTick.batchSize,
  };
}
