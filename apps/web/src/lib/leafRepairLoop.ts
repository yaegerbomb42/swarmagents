/**
 * Week 2 — budgeted auto-repair after hard gate failure.
 * Requeues failed leaves as pending until attempts/time are exhausted.
 */
import type { DecompSessionRecord } from '@/lib/decompSessions';
import { ensureConstraints } from '@/lib/decompSessions';
import type { LeafValidationReport, QualityBar } from '@/lib/leafCompletionGates';

export type RepairDecision = {
  scheduled: boolean;
  attempt: number;
  maxAttempts: number;
  reason: string;
};

function maxAttemptsForBar(bar: QualityBar): number {
  switch (bar) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
    case 'strict':
      return 3;
    default:
      return 2;
  }
}

function timeRemainingSec(session: DecompSessionRecord): number {
  const budget = Math.max(60, (Number(session.budget_minutes) || 60) * 60);
  const started = Number(session.createdAt) || Date.now();
  const elapsed = Math.max(0, (Date.now() - started) / 1000);
  return Math.max(0, budget - elapsed);
}

function canAffordRepair(session: DecompSessionRecord): boolean {
  const rem = timeRemainingSec(session);
  const budget = Math.max(60, (Number(session.budget_minutes) || 60) * 60);
  return rem >= 90 && rem / budget >= 0.05;
}

function buildRepairBrief(node: any, report: LeafValidationReport): string {
  const fails = report.hardFailures.length
    ? report.hardFailures.join(', ')
    : 'unknown';
  const evidence = (report.gates || [])
    .filter((g) => g.status === 'failed')
    .slice(0, 4)
    .map((g) => {
      const cmd = g.command?.join(' ') || g.id;
      return `- ${g.id}: ${cmd} → ${g.evidence || g.status}`;
    })
    .join('\n');
  return [
    `GATE REPAIR (attempt ${(Number(node.repair_attempts) || 0) + 1}): prior completion failed hard gates [${fails}].`,
    'Fix the failures, re-run the failing checks, then finish only when they pass.',
    evidence ? `Failed gates:\n${evidence}` : '',
    node.validation_feedback ? `Feedback: ${String(node.validation_feedback).slice(0, 500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * After a hard-gate failure: requeue for repair or leave terminal failed.
 */
export function maybeScheduleLeafRepair(
  session: DecompSessionRecord,
  node: any,
  report: LeafValidationReport
): RepairDecision {
  const rawBar = ensureConstraints(session).qualityBar || 'medium';
  const bar = (['low', 'medium', 'high', 'strict'] as QualityBar[]).includes(rawBar as QualityBar)
    ? (rawBar as QualityBar)
    : 'medium';
  const maxAttempts = maxAttemptsForBar(bar);
  const attempt = Number(node.repair_attempts) || 0;

  const feedback = String(node.validation_feedback || node.last_error || '');
  if (feedback.includes('execution_limit_exceeded')) {
    return {
      scheduled: false,
      attempt,
      maxAttempts,
      reason: 'non_repairable:execution_limit',
    };
  }

  if (attempt >= maxAttempts) {
    return {
      scheduled: false,
      attempt,
      maxAttempts,
      reason: 'max_repair_attempts',
    };
  }

  if (!canAffordRepair(session)) {
    return {
      scheduled: false,
      attempt,
      maxAttempts,
      reason: 'budget_exhausted',
    };
  }

  const brief = buildRepairBrief(node, report);
  node.repair_attempts = attempt + 1;
  node.repair_history = [
    ...(Array.isArray(node.repair_history) ? node.repair_history : []),
    {
      at: Date.now(),
      attempt: node.repair_attempts,
      hardFailures: report.hardFailures.slice(),
      feedback: feedback.slice(0, 400),
    },
  ].slice(-8);

  node.last_repair_brief = brief;
  node.purpose = `gate_repair_${node.repair_attempts}`;
  if (node.repair_attempts >= maxAttempts) {
    node.agent_class = 'qa';
    node.runtimePreferredRole = 'verifier';
  } else {
    node.agent_class = node.agent_class === 'qa' ? 'specialist' : node.agent_class || 'grunt';
    node.runtimePreferredRole = 'implementer';
  }

  node.validation_passed = null;
  node.validatedAt = undefined;
  node.completedAt = undefined;
  node.watcher_checked = false;
  node.watcher_retried = false;
  node.status = 'pending';
  node.continue_count = 0;
  node.last_error = feedback;

  const marker = '[GATE_REPAIR_BRIEF]';
  const desc = String(node.description || '');
  if (!desc.includes(marker)) {
    node.description = `${marker}\n${brief}\n\n---\n${desc}`.slice(0, 8000);
  } else {
    node.description =
      `${marker}\n${brief}\n\n---\n${desc.replace(/^\[GATE_REPAIR_BRIEF\][\s\S]*?\n---\n/, '')}`.slice(
        0,
        8000
      );
  }

  return {
    scheduled: true,
    attempt: node.repair_attempts,
    maxAttempts,
    reason: 'requeued',
  };
}

export function repairSortBoost(node: any): number {
  const a = Number(node.repair_attempts) || 0;
  if (a > 0 && String(node.purpose || '').startsWith('gate_repair_')) return 0;
  return 1;
}

export function sessionRepairStats(leaves: any[]): {
  repairing: number;
  repairExhausted: number;
} {
  let repairing = 0;
  let repairExhausted = 0;
  for (const n of leaves) {
    const attempts = Number(n.repair_attempts) || 0;
    if (
      attempts > 0 &&
      n.status === 'pending' &&
      String(n.purpose || '').startsWith('gate_repair_')
    ) {
      repairing++;
    }
    if (n.status === 'failed' && attempts > 0) repairExhausted++;
  }
  return { repairing, repairExhausted };
}
