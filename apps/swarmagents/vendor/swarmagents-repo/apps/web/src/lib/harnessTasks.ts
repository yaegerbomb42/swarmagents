/**
 * In-memory registry for harness tasks dispatched through /api/harness/task.
 *
 * A task is one run of the relentless executor (lib/agentEngine) started by
 * the route handler. Steps are appended as the executor calls back, so the
 * SSE stream (GET ?id=) can replay history to a late subscriber. State lives
 * on globalThis like the other server singletons (providerStore, eventBus)
 * so it survives module reloads in dev.
 *
 * Nothing here is synthetic: entries only exist because a real dispatch
 * created them, and steps only exist because the executor reported them.
 */

import type { ExecutionStep } from './agentEngine';

export type HarnessTaskStatus = 'created' | 'running' | 'completed' | 'failed' | 'blocked';

export interface HarnessStepView {
  step: number;
  phase: ExecutionStep['phase'];
  tool?: string;
  reasoning?: string;
  success?: boolean;
  output?: string;
  error?: string;
  duration_ms?: number;
  timestamp: number;
}

export interface HarnessTask {
  taskId: string;
  title: string;
  prompt: string;
  /** Provider type the user picked (e.g. 'groq'), or null for the default. */
  provider: string | null;
  /** Model the provider maps to, when known. */
  model: string | null;
  status: HarnessTaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  steps: HarnessStepView[];
  error?: string;
  finalResult?: string;
}

const MAX_TASKS = 50;
const MAX_STEPS_PER_TASK = 500;

const g = globalThis as typeof globalThis & {
  __swarmHarnessTasks?: Map<string, HarnessTask>;
};

function store(): Map<string, HarnessTask> {
  if (!g.__swarmHarnessTasks) g.__swarmHarnessTasks = new Map();
  return g.__swarmHarnessTasks;
}

export function newTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createHarnessTask(input: {
  title?: string;
  prompt: string;
  provider?: string | null;
  model?: string | null;
}): HarnessTask {
  const tasks = store();
  const task: HarnessTask = {
    taskId: newTaskId(),
    title: input.title || (input.prompt ? input.prompt.slice(0, 80) : 'Autonomous Mission'),
    prompt: input.prompt,
    provider: input.provider ?? null,
    model: input.model ?? null,
    status: 'created',
    createdAt: Date.now(),
    steps: [],
  };
  tasks.set(task.taskId, task);
  while (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next().value;
    if (!oldest) break;
    tasks.delete(oldest);
  }
  return task;
}

export function getHarnessTask(taskId: string): HarnessTask | undefined {
  return store().get(taskId);
}

export function startHarnessTask(taskId: string): void {
  const task = store().get(taskId);
  if (!task) return;
  task.status = 'running';
  task.startedAt = Date.now();
}

export function recordHarnessStep(taskId: string, step: ExecutionStep): HarnessStepView | null {
  const task = store().get(taskId);
  if (!task) return null;
  const view: HarnessStepView = {
    step: step.step,
    phase: step.phase,
    tool: step.tool,
    reasoning: step.reasoning,
    success: step.result?.success,
    output: step.result?.output,
    error: step.result?.error,
    duration_ms: step.result?.duration_ms,
    timestamp: step.timestamp,
  };
  task.steps.push(view);
  if (task.steps.length > MAX_STEPS_PER_TASK) {
    task.steps = task.steps.slice(-MAX_STEPS_PER_TASK);
  }
  return view;
}

export function finishHarnessTask(
  taskId: string,
  status: 'completed' | 'failed' | 'blocked',
  detail?: { error?: string; finalResult?: string },
): HarnessTask | null {
  const task = store().get(taskId);
  if (!task) return null;
  task.status = status;
  task.completedAt = Date.now();
  if (detail?.error) task.error = detail.error;
  if (detail?.finalResult) task.finalResult = detail.finalResult;
  return task;
}

export function listHarnessTasks(): HarnessTask[] {
  return [...store().values()].sort((a, b) => b.createdAt - a.createdAt);
}
