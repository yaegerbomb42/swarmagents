"use client";

/**
 * RunTraceTimeline — one stretch of a run's trace as a collapsible pill.
 *
 * The pill shows the stretch at a glance (step count, total duration, the
 * step in flight or the last one); expanding it shows one card per step with
 * a color-coded diff (edits) or stdout preview (everything else) and a Copy
 * button. Nothing here renders raw JSON: every body comes from the trace
 * engine's whitelisted, capped previews.
 */

import React, { useMemo, useState } from "react";
import { Check, ChevronRight, Clipboard, ClipboardCheck, History, Loader2, X } from "lucide-react";
import {
  formatTraceDuration,
  summarizeTraceStretch,
  type TimelineStep,
  type TraceStepKind,
} from "../../../lib/client/traceTimeline";
import { cn } from "../utils/cn";

const KIND_LABEL: Record<TraceStepKind, string> = {
  bash: "Bash",
  edit: "Edit",
  read: "Read",
  search: "Search",
  mcp: "MCP",
  browser: "Browser",
  desktop: "Desktop",
  thinking: "Thinking",
};

const KIND_CHIP: Record<TraceStepKind, string> = {
  bash: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  edit: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  read: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  search: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  mcp: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  browser: "border-teal-400/30 bg-teal-400/10 text-teal-300",
  desktop: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  thinking: "border-zinc-400/30 bg-zinc-400/10 text-zinc-300",
};

/** One diff/stdout line, colored by its prefix. */
function DiffLine({ line }: { line: string }) {
  const tone = line.startsWith("+ ")
    ? "text-emerald-300"
    : line.startsWith("- ")
      ? "text-rose-300"
      : line.startsWith("--- ")
        ? "text-sa-fg3"
        : "text-sa-fg2";
  return <span className={cn("block", tone)}>{line || " "}</span>;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== "undefined") {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } else {
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is best-effort (permissions, insecure contexts):
      // the preview stays visible, so nothing is lost.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy ${label}`}
      data-testid="trace-copy"
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sa-line bg-sa-panel px-2 py-1 text-[11px] font-medium text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg"
    >
      {copied ? (
        <ClipboardCheck className="h-3 w-3 text-sa-ok" aria-hidden />
      ) : (
        <Clipboard className="h-3 w-3" aria-hidden />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * core-17 Rewind: restore the user's VM to the checkpoint this step's call is
 * guarded by. Self-contained: it knows the run from props and posts to the
 * rewind API, showing its own progress and outcome inline.
 */
export function RewindButton({ runId, stepSeq, label, initialState = "idle" }: {
  readonly runId: string;
  readonly stepSeq: number;
  readonly label: string;
  /** Test seam for static rendering of each state. */
  readonly initialState?: "idle" | "confirm" | "rewinding" | "done" | "error";
}) {
  const [state, setState] = useState<"idle" | "confirm" | "rewinding" | "done" | "error">(initialState);
  const [error, setError] = useState<string>();
  const [undoLabel, setUndoLabel] = useState<string>();
  const rewind = async () => {
    setState("rewinding");
    setError(undefined);
    try {
      const res = await fetch(`/api/runtime/runs/${encodeURIComponent(runId)}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkpointSeq: stepSeq }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; undoLabel?: string } | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `Rewind failed (${res.status}).`);
      }
      setUndoLabel(typeof body?.undoLabel === "string" ? body.undoLabel : undefined);
      setState("done");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Rewind failed.");
    }
  };
  const btn =
    "inline-flex shrink-0 items-center gap-1 rounded-md border border-sa-line bg-sa-panel px-2 py-1 text-[11px] font-medium text-sa-fg2 transition-colors hover:bg-sa-hover hover:text-sa-fg disabled:cursor-not-allowed disabled:opacity-50";
  if (state === "confirm") {
    // Two-step: a rewind replaces the machine, so the first click only asks.
    return (
      <span className="inline-flex shrink-0 items-center gap-1" data-testid="trace-rewind-confirm">
        <span className="text-[11px] text-sa-fg2">Restore VM to {label}? Current state is saved as an undo point.</span>
        <button type="button" onClick={() => void rewind()} data-testid="trace-rewind-go" className={btn}>
          Rewind
        </button>
        <button type="button" onClick={() => setState("idle")} data-testid="trace-rewind-cancel" className={btn}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {state === "error" && <span className="text-[11px] text-sa-err">{error}</span>}
      {state === "done" && undoLabel && (
        <span className="text-[11px] text-sa-fg3" data-testid="trace-rewind-undo">
          undo point: <span className="sa-mono">{undoLabel}</span>
        </span>
      )}
      <button
        type="button"
        onClick={() => setState("confirm")}
        disabled={state === "rewinding" || state === "done"}
        title={`Restore the VM to ${label} — before this step ran`}
        aria-label={`Rewind VM to ${label}`}
        data-testid="trace-rewind"
        className={btn}
      >
        {state === "rewinding" ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : state === "done" ? (
          <Check className="h-3 w-3 text-sa-ok" aria-hidden />
        ) : (
          <History className="h-3 w-3" aria-hidden />
        )}
        {state === "done" ? "Rewound" : "Rewind"}
      </button>
    </span>
  );
}

function StepCard({ step, runId }: { step: TimelineStep; runId?: string }) {
  const [open, setOpen] = useState(false);
  const hasBody = step.diff !== undefined;
  const showPreview = step.preview !== step.label;
  return (
    <li data-testid={step.kind === "thinking" ? "trace-step" : "tool-entry"} data-kind={step.kind} className="border-t border-sa-line first:border-t-0">
      <button
        type="button"
        onClick={() => (hasBody ? setOpen((value) => !value) : undefined)}
        aria-expanded={hasBody ? open : undefined}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-sa-hover"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center">
          {step.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sa-accent-fg" aria-label="Running" />
          ) : step.status === "done" ? (
            <Check className="h-3.5 w-3.5 text-sa-ok" aria-label="Done" />
          ) : (
            <X className="h-3.5 w-3.5 text-sa-err" aria-label="Failed" />
          )}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            KIND_CHIP[step.kind],
          )}
        >
          {KIND_LABEL[step.kind]}
        </span>
        <span className="sa-mono min-w-0 flex-1 truncate text-[12.5px] text-sa-fg2">{step.label}</span>
        {step.checkpoint && runId && (
          <RewindButton runId={runId} stepSeq={step.checkpoint.stepSeq} label={step.checkpoint.label} />
        )}
        {step.durationMs !== undefined && step.durationMs > 0 && step.status !== "running" && (
          <span className="sa-tabular shrink-0 text-[12px] text-sa-fg3">{formatTraceDuration(step.durationMs)}</span>
        )}
        {hasBody && (
          <ChevronRight
            className={cn("h-3.5 w-3.5 shrink-0 text-sa-fg3 transition-transform", open && "rotate-90")}
            aria-hidden
          />
        )}
      </button>
      {step.kind === "thinking" && (
        <p className="px-3 pb-2 pl-9 text-[13px] italic leading-relaxed text-sa-fg2">{step.preview}</p>
      )}
      {open && step.diff && (
        <div className="space-y-2 px-3 pb-2 pl-9">
          {showPreview && <p className="text-[12px] leading-relaxed text-sa-fg2">{step.preview}</p>}
          <div className="rounded-lg bg-black/40 p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-sa-fg3">
                {step.diff.kind === "diff" ? "Diff" : "Output"}
                {step.diff.truncated ? " (truncated)" : ""}
              </span>
              <CopyButton text={step.diff.body} label={step.diff.kind === "diff" ? "diff" : "output"} />
            </div>
            <pre className="sa-scroll sa-mono max-h-56 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-[1.6]">
              {step.diff.kind === "diff"
                ? step.diff.body.split("\n").map((line, index) => <DiffLine key={index} line={line} />)
                : step.diff.body}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * One trace stretch: a collapsible pill plus one card per step. Renders
 * nothing when the stretch has no steps (the caller falls back to the
 * legacy steps block).
 */
export function RunTraceTimeline({
  steps,
  runId,
  defaultOpen = false,
}: {
  steps: readonly TimelineStep[];
  /** The run whose VM the Rewind buttons restore into; omitted hides them. */
  runId?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const summary = useMemo(() => summarizeTraceStretch(steps), [steps]);
  if (steps.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-sa-line" data-testid="steps-block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-sa-hover"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center">
          {summary.running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sa-accent-fg" aria-hidden />
          ) : summary.failed > 0 ? (
            <X className="h-3.5 w-3.5 text-sa-err" aria-hidden />
          ) : (
            <Check className="h-3.5 w-3.5 text-sa-ok" aria-hidden />
          )}
        </span>
        <span className="shrink-0 font-medium text-sa-fg">
          {summary.count} {summary.count === 1 ? "step" : "steps"}
        </span>
        {summary.failed > 0 && <span className="shrink-0 text-sa-err">{summary.failed} failed</span>}
        {summary.durationMs !== undefined && summary.durationMs > 0 && (
          <span className="sa-tabular shrink-0 text-[12px] text-sa-fg3">{formatTraceDuration(summary.durationMs)}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-sa-fg2">{summary.label}</span>
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-sa-fg3 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="border-t border-sa-line py-1">
          {steps.map((step) => (
            <StepCard key={step.id} step={step} runId={runId} />
          ))}
        </ol>
      )}
    </div>
  );
}

export default RunTraceTimeline;
