/**
 * Step-rail state for a run plan.
 *
 * The visual rail (node + connector line, from the
 * "autonomous-ai-computer-platform" and
 * "autonomous-human-ai-architecture" bundles) is only worth lifting if its
 * states are derived honestly. A step is `active` only when it is the current
 * one and the run is not finished; an unfinished run never renders later steps
 * as done.
 */

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface PlanStep {
  title: string;
  detail?: string;
  status: StepStatus;
}

export interface StepInput {
  title: string;
  detail?: string;
}

export interface StepProgress {
  /** 0-based index of the current step, or -1 when nothing has started. */
  currentIndex: number;
  /** Terminal state of the whole plan. */
  finished?: "completed" | "failed" | "cancelled";
}

/**
 * Build the rail. `currentIndex` is the step being worked on; everything before
 * it is done, everything after is pending. A finished plan marks the current
 * step as done (completed) or failed (failed), and never leaves an `active`
 * node behind — a spinner on a finished run is a lie.
 */
export function buildPlanSteps(steps: readonly StepInput[], progress: StepProgress): PlanStep[] {
  const { currentIndex, finished } = progress;
  return steps.map((step, index) => {
    const base = { title: step.title, ...(step.detail ? { detail: step.detail } : {}) };
    if (index < currentIndex) return { ...base, status: "done" as const };
    if (index === currentIndex) {
      if (finished === "completed") return { ...base, status: "done" as const };
      if (finished === "failed") return { ...base, status: "failed" as const };
      if (finished === "cancelled") return { ...base, status: "skipped" as const };
      return { ...base, status: "active" as const };
    }
    return { ...base, status: "pending" as const };
  });
}

/** Completed steps over total, for the "2/5" counter next to the rail. */
export function planProgressLabel(steps: readonly PlanStep[]): string {
  const done = steps.filter((step) => step.status === "done").length;
  return `${done}/${steps.length}`;
}

/** Node glyph per status: numbered for any, check for done, cross for failed. */
export function stepGlyph(step: PlanStep, index: number): string {
  if (step.status === "done") return "✓";
  if (step.status === "failed") return "✕";
  if (step.status === "skipped") return "–";
  return String(index + 1);
}

export type EventTone = "neutral" | "ok" | "warn" | "err";

/**
 * Tone for a run event row. Mirrors the colour mapping in the bundled design
 * (`event-verified/completed/step_done` green, `event-error/retry` red) without
 * importing their stylesheet.
 */
export function eventTone(eventType: string): EventTone {
  const type = eventType.toLowerCase();
  if (/(error|failed|failure|denied|blocked|timeout)/.test(type)) return "err";
  if (/(retry|warning|warn|expired|degraded|queued)/.test(type)) return "warn";
  if (/(done|completed|finished|verified|approved|success|resolved)/.test(type)) return "ok";
  return "neutral";
}
