// Run ledger: a durable, human-readable record of everything a task actually did.
//
// The ledger is the source of truth for progress, cost and the "did it really work?"
// question. It is deliberately append-mostly and small: turns, tool calls, notices and
// checkpoints. Model output stays in the session; the ledger stores the skeleton.

// Runs and their usage are mutated through store.withLedger (serialized per task, write awaited).
// Steps are appended to an append-only log so a long run records them at O(1) cost instead of
// rewriting the whole ledger on every turn.

import { appendStep, loadLedger, rtId, withLedger } from "./store";
import { getTask, updateTask } from "./tasks";
import type { RunRecord, RunUsage, StepRecord } from "./types";

export async function addStep(
  taskId: string,
  runId: string,
  step: Omit<StepRecord, "id" | "taskId" | "runId" | "ts"> & { ts?: number },
): Promise<StepRecord> {
  const rec: StepRecord = { id: rtId(), taskId, runId, ts: step.ts ?? Date.now(), ...step };
  // Steps go to an append-only log (one line, O(1)); the file is compacted to a bounded number of
  // recent lines, so a 24h run never grows the ledger without limit or rewrites it on every step.
  await appendStep(taskId, rec);
  return rec;
}

export async function startRun(taskId: string, sessionId: string, attempt: number): Promise<RunRecord> {
  const run: RunRecord = {
    id: rtId(),
    taskId,
    sessionId,
    attempt,
    startedAt: Date.now(),
    status: "running",
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, turns: 0, toolCalls: 0, wallMs: 0 },
    notes: [],
  };
  await withLedger(taskId, (ledger) => {
    // Any run still marked running belongs to a previous process; settle it as interrupted.
    for (const r of ledger.runs) if (r.status === "running") r.status = "interrupted";
    ledger.runs.push(run);
    // A task that restarts many times (or flaps on quota) must not grow this list forever.
    if (ledger.runs.length > RUN_KEEP) ledger.runs.splice(0, ledger.runs.length - RUN_KEEP);
  });
  return run;
}

function mutateRun(taskId: string, runId: string, fn: (r: RunRecord) => void): Promise<void> {
  return withLedger(taskId, (ledger) => {
    const r = ledger.runs.find((x) => x.id === runId);
    if (r) fn(r);
  });
}

/** Record one model turn's usage and fold it into the task total. */
export async function recordTurn(
  taskId: string,
  runId: string,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd?: number; provider?: string; model?: string },
): Promise<void> {
  mutateRun(taskId, runId, (r) => {
    r.usage.inputTokens += usage.inputTokens;
    r.usage.outputTokens += usage.outputTokens;
    r.usage.cachedTokens += usage.cachedTokens;
    r.usage.costUsd += usage.costUsd ?? 0;
    r.usage.turns += 1;
    if (usage.provider) r.provider = usage.provider;
    if (usage.model) r.model = usage.model;
  });
  await updateTask(taskId, (t) => {
    t.usage.inputTokens += usage.inputTokens;
    t.usage.outputTokens += usage.outputTokens;
    t.usage.cachedTokens += usage.cachedTokens;
    t.usage.costUsd += usage.costUsd ?? 0;
    t.usage.turns += 1;
  });
}

export async function recordTool(taskId: string, runId: string, ok: boolean): Promise<void> {
  mutateRun(taskId, runId, (r) => {
    r.usage.toolCalls += 1;
  });
  await updateTask(taskId, (t) => {
    t.usage.toolCalls += 1;
  });
  void ok;
}

export async function noteRun(taskId: string, runId: string, note: string): Promise<void> {
  await mutateRun(taskId, runId, (r) => {
    r.notes.push(note);
    if (r.notes.length > 200) r.notes.splice(0, r.notes.length - 200);
  });
}

export async function endRun(taskId: string, runId: string, status: RunRecord["status"], wallMs: number): Promise<void> {
  await mutateRun(taskId, runId, (r) => {
    r.status = status;
    r.endedAt = Date.now();
    r.usage.wallMs += wallMs;
  });
}

export function getLedger(taskId: string) {
  return loadLedger(taskId);
}

export interface BudgetCheck {
  exceeded: boolean;
  reason?: string;
  /** Which limit tripped, so the UI can be specific. */
  field?: "maxDurationMs" | "maxTokens" | "maxCostUsd" | "maxAttempts";
}

/** Has this task blown a budget? Checks both the task's accumulated usage and wall clock. */
export function checkBudget(taskId: string): BudgetCheck {
  const t = getTask(taskId);
  if (!t) return { exceeded: false };
  const b = t.budget;
  if (b.maxAttempts > 0 && t.attempts >= b.maxAttempts) {
    return { exceeded: true, field: "maxAttempts", reason: `Attempt limit reached (${b.maxAttempts}).` };
  }
  if (b.maxDurationMs > 0 && t.startedAt && Date.now() - t.startedAt >= b.maxDurationMs) {
    return { exceeded: true, field: "maxDurationMs", reason: `Time budget reached (${Math.round(b.maxDurationMs / 60000)} min).` };
  }
  const tokens = t.usage.inputTokens + t.usage.outputTokens;
  if (b.maxTokens > 0 && tokens >= b.maxTokens) {
    return { exceeded: true, field: "maxTokens", reason: `Token budget reached (${tokens.toLocaleString()} tokens).` };
  }
  if (b.maxCostUsd > 0 && t.usage.costUsd >= b.maxCostUsd) {
    return { exceeded: true, field: "maxCostUsd", reason: `Cost budget reached ($${t.usage.costUsd.toFixed(2)}).` };
  }
  return { exceeded: false };
}

/** A compact roll-up for headers and summaries. */
export function summarizeUsage(u: RunUsage): string {
  const tok = (u.inputTokens + u.outputTokens).toLocaleString();
  const bits = [`${tok} tok`, `${u.turns} turns`, `${u.toolCalls} tools`];
  if (u.costUsd > 0) bits.push(`$${u.costUsd.toFixed(2)}`);
  if (u.wallMs > 0) bits.push(fmtDuration(u.wallMs));
  return bits.join(" · ");
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}