"use client";

/**
 * Conversation — the full history of the open chat, one turn per run.
 *
 * A turn is everything about one run in one place: the user's message, what
 * the agent did (its messages, with each stretch of tool calls folded into a
 * collapsible "steps" block), anything it asked the user, and a footer that
 * says how the run is going or how it ended. Because a turn is a run, it is
 * always clear which run a message belongs to, and the footer is where you
 * jump from it to the live screen or to the run's report.
 *
 * The newest run streams live; older runs show their reply and load their
 * steps on demand (the server replays a finished run's events).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  FileText,
  Loader2,
  MonitorPlay,
  Send,
  X,
} from "lucide-react";
import type { AgentSession, PromptDisplay } from "../hooks/useAgentSession";
import type { ThreadEntry } from "../../../lib/client/thread";
import { describeRunFailure } from "../../../lib/client/thread";
import { buildConversation } from "../../../lib/client/conversation";
import { useRunStream, type RunStreamItem } from "../../../lib/client/useRunStream";
import { useStickToBottom } from "../../../lib/client/useStickToBottom";
import {
  RUN_PHASE_META,
  deriveRunPhase,
  formatDuration,
  formatElapsed,
  type RunPhase,
} from "../../../lib/client/runPhase";
import {
  buildTurnBlocks,
  closeOpenPrompts,
  formatStepDuration,
  summarizeSteps,
  type QuestionEntry,
  type StepEntry,
  type ToolEntry,
  type TurnBlock,
} from "../../../lib/client/turns";
import { taskLinkForRun, type TaskRunLink, type TaskRunLinks } from "../../../lib/client/board";
import { cn } from "../utils/cn";
import { Button, Loading, Notice, StatusBadge } from "./ui";
import { RunReportCard } from "./RunReportCard";
import { HandoffCard } from "./dashboard/HandoffCard";

export interface ConversationProps {
  session: AgentSession;
  /** Runs started from board tasks, so a turn can point back at its task. */
  taskLinks: TaskRunLinks;
  /** Example prompts shown on a fresh, empty chat; clicking one starts a run. */
  starters?: string[];
  /** Show the live VM screen. Left out while the screen is already on show. */
  onWatchScreen?: () => void;
  /** Open the board on a task. */
  onOpenTask: (taskId: string) => void;
  /** Open Settings on the providers tab. */
  onOpenProviders: () => void;
  className?: string;
}

// ---- Small pieces ----

const MARKDOWN_COMPONENTS = {
  a: ({ node: _node, ...props }: React.ComponentProps<"a"> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
};

const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="sa-prose" data-testid="conversation-agent">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** "14:02" today, "Nov 3, 14:02" otherwise. */
export function formatClock(ts: number, now: number = Date.now()): string {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** A clock that ticks while a run is going. */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className={cn("sa-tabular text-[13px] text-sa-fg2", className)} aria-label="Elapsed time">
      {formatElapsed(Math.max(0, now - since))}
    </span>
  );
}

function UserMessage({ prompt, task, onOpenTask }: { prompt: PromptDisplay; task?: TaskRunLink; onOpenTask: (id: string) => void }) {
  return (
    <div className="flex justify-end" data-testid="conversation-user">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-sa-raised px-3.5 py-2.5">
        {task && (
          <button
            type="button"
            onClick={() => onOpenTask(task.taskId)}
            className="mb-1 inline-flex max-w-full items-center gap-1.5 rounded-md text-[12px] font-medium text-sa-accent-fg hover:underline"
          >
            <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">Board task</span>
          </button>
        )}
        {prompt.text.trim() && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-sa-fg">{prompt.text}</p>
        )}
        {prompt.attachments.length > 0 && (
          <ul className={cn("flex flex-wrap gap-1.5", prompt.text.trim() && "mt-2")} aria-label="Attached files">
            {prompt.attachments.map((name) => (
              <li
                key={name}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-sa-line bg-sa-panel px-2 py-1 text-[12px] text-sa-fg2"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- Steps ----

function clip(value: string, max = 6000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function ToolDetail({ entry }: { entry: ToolEntry }) {
  const input =
    typeof entry.input === "string" ? entry.input : entry.input === undefined ? "" : JSON.stringify(entry.input, null, 2);
  const sections: Array<{ label: string; body: string }> = [];
  if (input) sections.push({ label: "Input", body: clip(input) });
  if (entry.output) sections.push({ label: entry.truncated ? "Output (truncated)" : "Output", body: clip(entry.output) });
  if (sections.length === 0) return <p className="px-3 py-2 text-[12px] text-sa-fg3">No details recorded.</p>;
  return (
    <div className="space-y-2 px-3 py-2" data-testid="tool-detail">
      {sections.map((section) => (
        <div key={section.label}>
          <div className="mb-1 text-[12px] font-medium text-sa-fg3">{section.label}</div>
          <pre className="sa-scroll sa-mono max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-2.5 text-[12px] leading-[1.6] text-sa-fg2">
            {section.body}
          </pre>
        </div>
      ))}
    </div>
  );
}

/** One tool call in an expanded steps block. Exported for the static-render tests. */
export function StepRow({ step }: { step: StepEntry }) {
  const [open, setOpen] = useState(false);
  if (step.kind === "status") {
    return (
      <li
        data-testid="conversation-status"
        className={cn(
          "flex items-start gap-2 px-3 py-1.5 text-[13px]",
          step.tone === "error" ? "text-sa-err" : "text-sa-fg2",
        )}
      >
        <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
        <span className="min-w-0 break-words">{step.text}</span>
      </li>
    );
  }
  return (
    <li data-testid="tool-entry">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-sa-hover"
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
        {/* The label already names the action ("Writing /workspace/hello.txt"),
            so a separate tool-name column would double the verb ("Write
            Writing ..."). */}
        <span className="sa-mono min-w-0 flex-1 truncate text-[12.5px] text-sa-fg2">{step.label}</span>
        {/* A 0 ms duration means the call and its result were stamped in the
            same millisecond — no real elapsed time was recorded, so showing
            "0 ms" reads as a bug. */}
        {step.durationMs !== undefined && step.durationMs > 0 && step.status !== "running" && (
          <span className="sa-tabular shrink-0 text-[12px] text-sa-fg3">{formatStepDuration(step.durationMs)}</span>
        )}
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-sa-fg3 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>
      {open && <ToolDetail entry={step} />}
    </li>
  );
}

/** A stretch of tool calls, folded to one line until the user opens it. */
export function StepsBlock({ steps, defaultOpen = false }: { steps: StepEntry[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const summary = summarizeSteps(steps);
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
        <span className="min-w-0 flex-1 truncate text-sa-fg2">{summary.label}</span>
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-sa-fg3 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="border-t border-sa-line py-1">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- Question ----

function QuestionCard({
  entry,
  onAnswer,
}: {
  entry: QuestionEntry;
  onAnswer: (id: string, answer: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const pending = entry.status === "pending";

  const answer = async (value: string) => {
    const text = value.trim();
    if (!pending || sending || !text) return;
    setSending(true);
    setError(undefined);
    const ok = await onAnswer(entry.id, text);
    if (!ok) setError("The answer did not send. Try again.");
    setSending(false);
  };

  return (
    <div
      data-testid="question-card"
      data-question-id={entry.id}
      className={cn(
        "rounded-xl border p-3.5",
        pending ? "sa-enter border-sa-warn/40 bg-sa-warn/[0.06]" : "border-sa-line",
      )}
    >
      <div className="flex items-start gap-2.5">
        <CircleHelp className={cn("mt-0.5 h-4 w-4 shrink-0", pending ? "text-sa-warn" : "text-sa-fg3")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-sa-fg2">
            {pending ? "The agent needs your answer to continue" : "The agent asked"}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-sa-fg">{entry.question}</p>

          {entry.status === "answered" && entry.answer !== undefined && (
            <p className="mt-2 text-[13px] text-sa-fg2">
              <span className="text-sa-fg3">You answered: </span>
              {entry.answer}
            </p>
          )}
          {!pending && entry.status !== "answered" && (
            <p className="mt-2 text-[13px] text-sa-fg3">
              {entry.status === "expired" ? "This question expired unanswered." : "The run ended before an answer."}
            </p>
          )}

          {pending && entry.options.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {entry.options.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  data-testid="question-option"
                  disabled={sending}
                  onClick={() => void answer(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          {pending && entry.allowFreeText && (
            <div className="mt-3 flex items-end gap-2">
              <textarea
                data-testid="question-answer"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void answer(draft);
                  }
                }}
                rows={1}
                placeholder="Type your answer"
                aria-label="Your answer"
                className="sa-scroll max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-sa-line-strong bg-sa-bg px-2.5 py-2 text-base leading-5 text-sa-fg placeholder:text-sa-fg3 sm:text-sm"
              />
              <Button
                variant="primary"
                data-testid="question-send"
                loading={sending}
                disabled={!draft.trim()}
                onClick={() => void answer(draft)}
              >
                {!sending && <Send className="h-3.5 w-3.5" aria-hidden />}
                Answer
              </Button>
            </div>
          )}
          {error && <p className="mt-2 text-[13px] text-sa-err" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ---- Blocks ----

function isReplayTruncated(items: readonly RunStreamItem[]): boolean {
  return items.some(
    (item) =>
      item.kind === "run.snapshot" &&
      typeof item.data === "object" &&
      item.data !== null &&
      (item.data as { truncated?: unknown }).truncated === true,
  );
}

function Blocks({
  blocks,
  truncated,
  onAnswer,
  onHandBack,
  defaultOpen = false,
}: {
  blocks: TurnBlock[];
  truncated: boolean;
  onAnswer: (id: string, answer: string) => Promise<boolean>;
  onHandBack: (id: string) => void;
  /** Start step blocks expanded (used when the user asked to see the steps). */
  defaultOpen?: boolean;
}) {
  return (
    <>
      {truncated && (
        <p className="text-[13px] text-sa-fg3">This run was long. Its earliest steps are not shown here.</p>
      )}
      {blocks.map((block) => {
        if (block.kind === "agent") return <Markdown key={block.key} text={block.entry.text} />;
        if (block.kind === "steps") return <StepsBlock key={block.key} steps={block.steps} defaultOpen={defaultOpen} />;
        if (block.kind === "question") return <QuestionCard key={block.key} entry={block.entry} onAnswer={onAnswer} />;
        return <HandoffCard key={block.key} entry={block.entry} onHandBack={onHandBack} />;
      })}
    </>
  );
}

/** A finished run's steps, replayed from the server when the user asks for them. */
function ReplayedSteps({
  runId,
  onAnswer,
  onHandBack,
}: {
  runId: string;
  onAnswer: (id: string, answer: string) => Promise<boolean>;
  onHandBack: (id: string) => void;
}) {
  const stream = useRunStream(runId);
  const blocks = useMemo(() => buildTurnBlocks(closeOpenPrompts(buildConversation(stream.items))), [stream.items]);
  if (blocks.length === 0) {
    return stream.status === "idle" ? (
      <p className="text-[13px] text-sa-fg3">No steps were recorded for this run.</p>
    ) : (
      <Loading label="Loading steps" className="justify-start py-1" />
    );
  }
  return <Blocks blocks={blocks} truncated={isReplayTruncated(stream.items)} onAnswer={onAnswer} onHandBack={onHandBack} defaultOpen />;
}

// ---- Turn ----

interface TurnProps {
  entry: ThreadEntry;
  prompt: PromptDisplay;
  /** This is the run whose stream is attached: its blocks are live. */
  live: boolean;
  blocks?: TurnBlock[];
  truncated: boolean;
  phase: RunPhase;
  activity?: string;
  task?: TaskRunLink;
  onAnswer: (id: string, answer: string) => Promise<boolean>;
  onHandBack: (id: string) => void;
  onStop: (runId: string) => void;
  onResume: (runId: string) => void;
  onRetry: (entry: ThreadEntry) => void;
  onWatchScreen?: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenProviders: () => void;
}

const Turn = React.memo(function Turn({
  entry,
  prompt,
  live,
  blocks,
  truncated,
  phase,
  activity,
  task,
  onAnswer,
  onHandBack,
  onStop,
  onResume,
  onRetry,
  onWatchScreen,
  onOpenTask,
  onOpenProviders,
}: TurnProps) {
  const [showSteps, setShowSteps] = useState(false);
  const meta = RUN_PHASE_META[phase];
  const failure = meta.active ? null : describeRunFailure(entry);
  const terminal = phase === "finished" || phase === "error" || phase === "cancelled";
  const duration =
    entry.finishedAt !== undefined && entry.finishedAt >= entry.createdAt
      ? formatDuration(entry.finishedAt - entry.createdAt)
      : undefined;

  return (
    <article className="space-y-3" data-testid="turn" data-run-id={entry.runId} data-phase={phase} aria-label="Run">
      <UserMessage prompt={prompt} task={task} onOpenTask={onOpenTask} />

      <div className="space-y-3">
        {live && blocks && blocks.length > 0 ? (
          <Blocks blocks={blocks} truncated={truncated} onAnswer={onAnswer} onHandBack={onHandBack} />
        ) : showSteps ? (
          <ReplayedSteps runId={entry.runId} onAnswer={onAnswer} onHandBack={onHandBack} />
        ) : (
          entry.finalText && <Markdown text={entry.finalText} />
        )}

        {failure && failure.kind !== "cancelled" && (
          <Notice
            tone={failure.kind === "empty" || failure.kind === "paused" ? "info" : "err"}
            title={failure.title}
            testId="run-failure"
            action={
              failure.kind === "paused" ? (
                <Button size="sm" variant="primary" onClick={() => onResume(entry.runId)}>
                  Resume
                </Button>
              ) : failure.kind === "auth" || failure.kind === "model" ? (
                <Button size="sm" variant="primary" onClick={onOpenProviders}>
                  Open providers
                </Button>
              ) : failure.kind === "session" ? undefined : (
                <Button size="sm" onClick={() => onRetry(entry)}>
                  Try again
                </Button>
              )
            }
          >
            {failure.raw && failure.raw !== failure.title ? failure.raw : undefined}
          </Notice>
        )}

        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1" data-testid="turn-status">
          <StatusBadge tone={meta.tone} label={meta.label} live={meta.active} />
          {meta.active ? (
            <Elapsed since={entry.createdAt} />
          ) : (
            duration && <span className="sa-tabular text-[13px] text-sa-fg2">{duration}</span>
          )}
          {meta.active && activity && phase === "running" && (
            <span className="min-w-0 max-w-full flex-1 basis-40 truncate text-[13px] text-sa-fg2">{activity}</span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {!meta.active && (
              <span className="mr-1 hidden text-[12px] text-sa-fg3 sm:inline" title={`Run ${entry.runId}`}>
                {formatClock(entry.createdAt)}
              </span>
            )}
            {phase === "queued" && (
              <Button size="sm" variant="ghost" onClick={() => onStop(entry.runId)}>
                Cancel
              </Button>
            )}
            {onWatchScreen && meta.active && phase !== "queued" && phase !== "starting" && (
              <Button size="sm" variant="ghost" onClick={onWatchScreen} data-testid="watch-screen">
                <MonitorPlay className="h-3.5 w-3.5" aria-hidden />
                Watch computer
              </Button>
            )}
            {!live && !meta.active && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={showSteps}
                onClick={() => setShowSteps((value) => !value)}
                data-testid="toggle-steps"
              >
                {showSteps ? "Hide steps" : "Show steps"}
              </Button>
            )}
            {terminal && task && (
              <Button size="sm" onClick={() => onOpenTask(task.taskId)}>
                <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                Open task
              </Button>
            )}
          </span>
        </div>

        {terminal && <RunReportCard entry={entry} />}
      </div>
    </article>
  );
});

// ---- Conversation ----

export function Conversation({
  session,
  taskLinks,
  starters = [],
  onWatchScreen,
  onOpenTask,
  onOpenProviders,
  className,
}: ConversationProps) {
  const { turns, pending, liveRunId, liveEntries, liveItems, phase, activity, promptFor } = session;
  const liveBlocks = useMemo(() => buildTurnBlocks(liveEntries), [liveEntries]);
  // One prompt object per run, so unchanged turns skip re-rendering on each poll.
  const prompts = useMemo(() => new Map(turns.map((entry) => [entry.runId, promptFor(entry)])), [turns, promptFor]);
  const truncated = useMemo(() => isReplayTruncated(liveItems), [liveItems]);

  const lastEntry = liveEntries[liveEntries.length - 1];
  const streamingChars = lastEntry?.kind === "agent" ? lastEntry.text.length : 0;
  const contentVersion = turns.length * 1_000_000 + liveEntries.length * 1000 + streamingChars + (pending ? 1 : 0);
  const { ref, contentRef, stuck, onScroll, jumpToLatest, hold } = useStickToBottom(contentVersion);
  // Opening or closing a section (steps, a report) is the reader's own doing:
  // it stays where they put it instead of being scrolled to the latest message.
  const onToggleSection = useCallback(
    (event: React.MouseEvent) => {
      if ((event.target as Element).closest("[aria-expanded]")) hold();
    },
    [hold],
  );

  // Opening a conversation starts at its latest message.
  useEffect(() => {
    jumpToLatest();
  }, [session.threadKey, jumpToLatest]);

  const { stop, resume, send, answerQuestion, markHandedBack } = session;
  const onStop = useMemo(() => (runId: string) => void stop(runId), [stop]);
  const onResume = useMemo(() => (runId: string) => void resume(runId), [resume]);
  const onRetry = useMemo(
    () => (entry: ThreadEntry) => {
      // The stored prompt is a preview; when it was cut, resend what was typed.
      const full = entry.prompt.endsWith("…") ? promptFor(entry).text : entry.prompt;
      void send(full, [], { displayText: promptFor(entry).text });
    },
    [send, promptFor],
  );

  return (
    <section
      className={cn("relative flex min-h-0 flex-col", className)}
      aria-label="Conversation"
      data-testid="conversation-log"
    >
      <div
        ref={ref}
        onScroll={onScroll}
        className="sa-scroll min-h-0 flex-1 overflow-y-auto"
        data-testid="conversation-scroll"
      >
        <div
          ref={contentRef}
          onClickCapture={onToggleSection}
          className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-4 py-6"
        >
          {session.turnsLoading && <Loading label="Loading conversation" className="py-10" />}

          {!session.turnsLoading && turns.length === 0 && !pending && (
            <div className="py-10 text-center" data-testid="conversation-empty">
              <p className="text-[13px] text-sa-fg2 mb-6">No messages yet. Tell the agent what you want done.</p>
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4 sm:justify-center">
                {starters.map((text) => (
                  <Button
                    key={text}
                    data-testid="starter-prompt"
                    onClick={() => void send(text, [])}
                    size="sm"
                  >
                    {text}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {turns.map((entry) => {
            const live = entry.runId === liveRunId;
            const turnPhase = (live ? phase : null) ?? deriveRunPhase({ status: entry.status }) ?? "running";
            return (
              <Turn
                key={entry.runId}
                entry={entry}
                prompt={prompts.get(entry.runId) ?? promptFor(entry)}
                live={live}
                blocks={live ? liveBlocks : undefined}
                truncated={live && truncated}
                phase={turnPhase}
                activity={live ? activity : undefined}
                task={taskLinkForRun(taskLinks, entry.runId)}
                onAnswer={answerQuestion}
                onHandBack={markHandedBack}
                onStop={onStop}
                onResume={onResume}
                onRetry={onRetry}
                onWatchScreen={onWatchScreen}
                onOpenTask={onOpenTask}
                onOpenProviders={onOpenProviders}
              />
            );
          })}

          {pending && (
            <article className="sa-enter space-y-3" data-testid="turn-pending" aria-label="Sending message">
              <UserMessage prompt={pending} onOpenTask={onOpenTask} />
              <StatusBadge tone="accent" label={pending.attachments.length > 0 ? "Uploading and starting" : "Starting"} live />
            </article>
          )}
        </div>
      </div>

      {!stuck && (
        <button
          type="button"
          data-testid="jump-to-latest"
          onClick={jumpToLatest}
          className="mx-auto sa-fade inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-sa-line-strong bg-sa-raised px-3.5 py-1.5 text-[13px] font-medium text-sa-fg shadow-sm transition-colors hover:bg-sa-hover"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          Latest
        </button>
      )}
    </section>
  );
}

export default Conversation;
