/**
 * The agent's own plan, as a checklist the user can follow (Manus-style).
 *
 * Claude Code keeps a running plan through its todo tools:
 *   - `TodoWrite` replaces the whole list: `{ todos: [{ content, status, activeForm }] }`
 *     (status is pending | in_progress | completed; activeForm is the
 *     present-continuous label, e.g. "Running the tests").
 *   - Newer CLIs can use the task tools instead: `TaskCreate { subject,
 *     description?, activeForm? }` appends a step (the CLI numbers them
 *     1, 2, 3… per session) and `TaskUpdate { taskId, status?, subject?,
 *     activeForm? }` edits one (status may also be "deleted").
 *
 * Both are folded into one `RunPlan` here. The harness emits a `run.plan`
 * telemetry event whenever the folded plan changes; the client and the run
 * report read the latest one (and fall back to folding the raw `tool.call`
 * events, so runs recorded before `run.plan` existed still show a plan).
 *
 * Pure and dependency-free: shared by the harness, the client and the
 * report builder.
 */

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  /** Stable id: the TodoWrite position ("1"-based) or the CLI task id. */
  id: string;
  content: string;
  status: PlanStepStatus;
  /** Present-continuous label shown while the step is in progress. */
  activeForm?: string;
}

export type RunPlan = readonly PlanStep[];

export interface PlanProgress {
  done: number;
  total: number;
  /** The step in progress (first one), if any. */
  current?: PlanStep;
}

/** Hard caps so a runaway model cannot flood the UI or the run log. */
export const MAX_PLAN_STEPS = 50;
const MAX_STEP_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_STEP_CHARS ? `${text.slice(0, MAX_STEP_CHARS - 1)}…` : text;
}

function normalizeStatus(value: unknown): PlanStepStatus | "deleted" | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "completed" || v === "complete" || v === "done") return "completed";
  if (v === "in_progress" || v === "active" || v === "running") return "in_progress";
  if (v === "pending" || v === "todo" || v === "open") return "pending";
  if (v === "deleted" || v === "removed" || v === "cancelled") return "deleted";
  return undefined;
}

/** The bare tool name: MCP-prefixed names ("mcp__x__TodoWrite") reduce to their last segment. */
function bareToolName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

/** Tool inputs sometimes arrive as a JSON string (bridged providers). */
function inputRecord(input: unknown): Record<string, unknown> | null {
  if (isRecord(input)) return input;
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True for the tool names that carry the agent's plan. */
export function isPlanToolName(name: string): boolean {
  const bare = bareToolName(name);
  return bare === "TodoWrite" || bare === "TaskCreate" || bare === "TaskUpdate";
}

/**
 * The fold state: the steps plus how many tasks the CLI has created, since
 * TaskCreate ids keep counting past deleted tasks (1, 2, [3 deleted], 4).
 */
export interface PlanFold {
  steps: RunPlan;
  created: number;
}

function highestNumericId(plan: RunPlan): number {
  return plan.reduce((max, step) => Math.max(max, Number(step.id) || 0), 0);
}

/**
 * Fold one tool call into the plan. Returns the new plan, or `null` when
 * the call is not a plan tool or is malformed (the plan is unchanged).
 * Stateless convenience over `foldPlanToolCall`; prefer the fold (or the
 * tracker) when replaying a whole run so TaskCreate numbering survives
 * deletions.
 */
export function applyPlanToolCall(plan: RunPlan, name: string, rawInput: unknown): RunPlan | null {
  return foldPlanToolCall({ steps: plan, created: highestNumericId(plan) }, name, rawInput)?.steps ?? null;
}

export function foldPlanToolCall(fold: PlanFold, name: string, rawInput: unknown): PlanFold | null {
  const plan = fold.steps;
  const tool = bareToolName(name);
  if (!isPlanToolName(tool)) return null;
  const input = inputRecord(rawInput);
  if (!input) return null;

  if (tool === "TodoWrite") {
    if (!Array.isArray(input.todos)) return null;
    const steps: PlanStep[] = [];
    for (const todo of input.todos) {
      if (!isRecord(todo)) continue;
      const content = clean(todo.content) ?? clean(todo.subject) ?? clean(todo.title);
      if (!content) continue;
      const status = normalizeStatus(todo.status);
      if (status === "deleted") continue;
      const activeForm = clean(todo.activeForm);
      steps.push({
        id: clean(todo.id) ?? String(steps.length + 1),
        content,
        status: status ?? "pending",
        ...(activeForm ? { activeForm } : {}),
      });
      if (steps.length >= MAX_PLAN_STEPS) break;
    }
    return { steps, created: fold.created };
  }

  if (tool === "TaskCreate") {
    const content = clean(input.subject) ?? clean(input.content) ?? clean(input.description);
    if (!content || plan.length >= MAX_PLAN_STEPS) return null;
    // The CLI numbers tasks 1, 2, 3… per session, deleted ones included.
    const nextId = Math.max(fold.created, highestNumericId(plan)) + 1;
    const activeForm = clean(input.activeForm);
    return {
      steps: [...plan, { id: String(nextId), content, status: "pending", ...(activeForm ? { activeForm } : {}) }],
      created: nextId,
    };
  }

  // TaskUpdate
  const id = typeof input.taskId === "number" ? String(input.taskId) : clean(input.taskId) ?? clean(input.id);
  if (!id) return null;
  const index = plan.findIndex((step) => step.id === id);
  if (index < 0) return null;
  const status = normalizeStatus(input.status);
  if (status === "deleted") return { steps: plan.filter((_, i) => i !== index), created: fold.created };
  const prev = plan[index];
  const content = clean(input.subject) ?? prev.content;
  const activeForm = clean(input.activeForm) ?? prev.activeForm;
  const next: PlanStep = { id, content, status: status ?? prev.status, ...(activeForm ? { activeForm } : {}) };
  if (samePlan([prev], [next])) return null;
  return { steps: plan.map((step, i) => (i === index ? next : step)), created: fold.created };
}

/** Structural equality (order, ids, text and status). */
export function samePlan(a: RunPlan | null | undefined, b: RunPlan | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((step, i) => {
    const other = b[i];
    return (
      step.id === other.id &&
      step.content === other.content &&
      step.status === other.status &&
      (step.activeForm ?? "") === (other.activeForm ?? "")
    );
  });
}

/** Validate a plan carried on a `run.plan` event (it crossed a wire). */
export function parsePlanSteps(value: unknown): RunPlan | null {
  if (!Array.isArray(value)) return null;
  const steps: PlanStep[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const content = clean(raw.content);
    const status = normalizeStatus(raw.status);
    if (!content || !status || status === "deleted") continue;
    const activeForm = clean(raw.activeForm);
    steps.push({ id: clean(raw.id) ?? String(steps.length + 1), content, status, ...(activeForm ? { activeForm } : {}) });
    if (steps.length >= MAX_PLAN_STEPS) break;
  }
  return steps;
}

/** A telemetry/run-log event in any of the shapes the app stores. */
export interface PlanSourceEvent {
  /** Event type (run log) … */
  type?: string;
  /** … or SSE event kind (client stream). */
  kind?: string;
  data?: unknown;
}

/**
 * The run's latest plan from its event stream: `run.plan` events win; raw
 * plan tool calls are folded for runs recorded before `run.plan` existed.
 * Returns null when the run never planned.
 */
export function latestPlanFromEvents(events: readonly PlanSourceEvent[]): RunPlan | null {
  let fromEvents: RunPlan | null = null;
  let folded: PlanFold | null = null;
  for (const event of events) {
    const type = event.type ?? event.kind;
    const data = isRecord(event.data) ? event.data : (event as unknown as Record<string, unknown>);
    if (type === "run.plan") {
      const steps = parsePlanSteps(data.steps);
      if (steps) fromEvents = steps;
    } else if (type === "tool.call" && typeof data.name === "string" && isPlanToolName(data.name)) {
      const next = foldPlanToolCall(folded ?? { steps: [], created: 0 }, data.name, data.input);
      if (next) folded = next;
    }
  }
  const plan = fromEvents ?? folded?.steps ?? null;
  return plan && plan.length > 0 ? plan : null;
}

export function planProgress(plan: RunPlan): PlanProgress {
  const done = plan.filter((step) => step.status === "completed").length;
  const current = plan.find((step) => step.status === "in_progress");
  return { done, total: plan.length, ...(current ? { current } : {}) };
}

/** "Plan: 7/7 completed" — the one-line summary for the run report. */
export function formatPlanSummary(progress: Pick<PlanProgress, "done" | "total">): string {
  return `Plan: ${progress.done}/${progress.total} completed`;
}

/**
 * Stateful tracker for the harness: feed it every tool_use; it returns the
 * new plan when (and only when) the plan changed, so `run.plan` is emitted
 * once per real change.
 */
export function createPlanTracker() {
  let fold: PlanFold = { steps: [], created: 0 };
  let lastEmitted: RunPlan | null = null;
  return {
    onToolUse(name: string, input: unknown): RunPlan | null {
      const next = foldPlanToolCall(fold, name, input);
      if (!next) return null;
      fold = next;
      if (samePlan(next.steps, lastEmitted)) return null;
      lastEmitted = next.steps;
      return next.steps;
    },
    current(): RunPlan {
      return fold.steps;
    },
  };
}
