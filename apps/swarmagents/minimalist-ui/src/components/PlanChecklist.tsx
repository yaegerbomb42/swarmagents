"use client";

/**
 * PlanChecklist — the agent's own plan as a live checklist (Manus-style).
 *
 * Fed by the run's latest `run.plan` (see lib/run-plan.ts). One header row
 * ("Plan 3/7" plus the step in progress, in its present-continuous form)
 * and the steps underneath, each with a status icon. Pinned to the top of
 * the conversation while the run is live so the user always knows where the
 * agent is. On narrow screens it starts collapsed to the header row; the
 * toggle opens the full list. Renders nothing for a run that never planned.
 */

import { useId, useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle, ListChecks, Loader2 } from "lucide-react";
import { planProgress, type PlanStep, type RunPlan } from "../../../lib/run-plan";
import { cn } from "../utils/cn";

export interface PlanChecklistProps {
  plan: RunPlan | null | undefined;
  /** The run is live: pin the card and animate the in-progress step. */
  live?: boolean;
  /** Start with the list open on every screen size (tests, replays). */
  defaultOpen?: boolean;
  className?: string;
}

function StepIcon({ step, live }: { step: PlanStep; live: boolean }) {
  if (step.status === "completed") return <Check className="h-3.5 w-3.5 shrink-0 text-sa-ok" aria-label="Done" />;
  if (step.status === "in_progress") {
    return live ? (
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sa-accent-fg" aria-label="In progress" />
    ) : (
      <Circle className="h-3.5 w-3.5 shrink-0 fill-current text-sa-accent-fg" aria-label="In progress" />
    );
  }
  return <Circle className="h-3.5 w-3.5 shrink-0 text-sa-fg3" aria-label="To do" />;
}

/** Whether the list is showing by default at this screen size (sm and up). */
function openByScreen(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 640px)").matches;
}

export function PlanChecklist({ plan, live = false, defaultOpen = false, className }: PlanChecklistProps) {
  // null = follow the screen size (open on sm+, collapsed on mobile);
  // a boolean = the user's own choice.
  const [open, setOpen] = useState<boolean | null>(defaultOpen ? true : null);
  const listId = useId();
  if (!plan || plan.length === 0) return null;

  const { done, total, current } = planProgress(plan);
  const allDone = done === total;
  const currentLabel = current ? current.activeForm ?? current.content : allDone ? "All steps done" : undefined;
  const expanded = open === true;
  const pct = Math.round((done / total) * 100);

  return (
    <section
      className={cn(
        "rounded-xl border border-sa-line bg-sa-raised/95 shadow-sm backdrop-blur",
        live && "sticky top-2 z-10",
        className,
      )}
      aria-label="Agent plan"
      data-testid="plan-checklist"
      data-done={done}
      data-total={total}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open ?? undefined}
        aria-controls={listId}
        onClick={() => setOpen((value) => !(value ?? openByScreen()))}
        data-testid="plan-toggle"
      >
        <ListChecks className="h-4 w-4 shrink-0 text-sa-fg2" aria-hidden />
        <span className="shrink-0 text-[13px] font-medium text-sa-fg">Plan</span>
        <span className="sa-tabular shrink-0 text-[12px] text-sa-fg2" data-testid="plan-counter">
          {done}/{total}
        </span>
        {currentLabel && (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-sa-fg2" data-testid="plan-current">
            {currentLabel}
          </span>
        )}
        <span className="ml-auto shrink-0 text-sa-fg3">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        </span>
      </button>
      <div className="mx-3 h-0.5 overflow-hidden rounded-full bg-sa-line" aria-hidden>
        <div className="h-full bg-sa-ok transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <ol
        id={listId}
        className={cn("space-y-1 px-3 py-2", open === null ? "hidden sm:block" : expanded ? "block" : "hidden")}
        data-testid="plan-steps"
      >
        {plan.map((step) => (
          <li
            key={step.id}
            className="flex items-start gap-2"
            data-testid="plan-step"
            data-status={step.status}
            aria-current={step.status === "in_progress" ? "step" : undefined}
          >
            <span className="mt-[3px]">
              <StepIcon step={step} live={live} />
            </span>
            <span
              className={cn(
                "min-w-0 text-[13px] leading-snug",
                step.status === "completed" && "text-sa-fg3 line-through decoration-sa-fg3/50",
                step.status === "in_progress" && "font-medium text-sa-fg",
                step.status === "pending" && "text-sa-fg2",
              )}
            >
              {step.status === "in_progress" && step.activeForm ? step.activeForm : step.content}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
