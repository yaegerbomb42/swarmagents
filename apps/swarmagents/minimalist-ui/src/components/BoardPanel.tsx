"use client";

/**
 * BoardPanel — the SwarmBoard, in the same workspace as the chat and the VM.
 *
 * One calm list, grouped by where each task stands (open, in progress, in
 * review, blocked, completed). Each row shows the title, who claimed it and
 * its pull request. A task moves through the board from here:
 *
 *   add a task  →  Run (starts a VM run for it and claims it)  →  the run
 *   shows up in the chat and on the screen  →  Submit for review (branch,
 *   summary, optional PR)  →  a reviewer completes it.
 *
 * All reads and writes go through the board API (lib/client/board.ts).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink, GitBranch, Play, Plus } from "lucide-react";
import type { SwarmTask } from "../../../lib/mcp-types";
import type { ThreadEntry } from "../../../lib/client/thread";
import { formatRelativeTime } from "../../../lib/client/thread";
import {
  TASK_BRANCH_MAX,
  TASK_DESCRIPTION_MAX,
  TASK_PR_URL_MAX,
  TASK_STATUS_META,
  TASK_SUMMARY_MAX,
  extractBranchAndPr,
  groupBoardTasks,
  isSafeHttpUrl,
  prLabel,
  type TaskRunLink,
} from "../../../lib/client/board";
import { RUN_PHASE_META, deriveRunPhase } from "../../../lib/client/runPhase";
import type { Board } from "../hooks/useBoard";
import { cn } from "../utils/cn";
import { Button, Loading, Notice, StatusBadge } from "./ui";

export interface BoardPanelProps {
  board: Board;
  /** The name this user's VM agent claims tasks under. */
  agentName: string;
  /** The workspace's view of a run, to show how a task's run is going. */
  runFor: (runId: string) => ThreadEntry | undefined;
  /** Start a VM run for a task (and claim it). Resolves with an error message on failure. */
  onRunTask: (task: SwarmTask) => Promise<string | undefined>;
  /** Jump to a task's run in the chat. */
  onViewRun: (link: TaskRunLink) => void;
  /** Open this task's details (set when the user arrives from a run). */
  focusTaskId?: string;
  className?: string;
}

const fieldClass =
  "w-full rounded-lg border border-sa-line-strong bg-sa-bg px-2.5 py-2 text-base leading-5 text-sa-fg outline-none placeholder:text-sa-fg3 sm:text-sm";

function PrLink({ url }: { url: string }) {
  if (!isSafeHttpUrl(url)) return <span className="break-all text-sa-fg2">{url}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex items-center gap-1 rounded text-sa-accent-fg hover:underline"
    >
      {prLabel(url)}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

// ---- Add a task ----

function AddTask({ board }: { board: Board }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [reply, setReply] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // Talks to POST /api/board-agent/chat through askBoard(). A turn that files
  // a task shows up on the board; the reply stays under the box.
  const add = async () => {
    const message = text.trim();
    if (!message || saving) return;
    setSaving(true);
    setError(undefined);
    const result = await board.ask(message);
    setSaving(false);
    if (result.ok) {
      setReply(result.value.reply);
      setText("");
      ref.current?.focus();
    } else {
      setError(result.error);
    }
  };

  return (
    <form
      className="space-y-2"
      data-testid="board-add"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          data-testid="board-add-input"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void add();
            }
          }}
          rows={1}
          maxLength={TASK_DESCRIPTION_MAX}
          aria-label="Message the board"
          placeholder="Ask the board. It can file a task from what you say."
          className={cn(fieldClass, "sa-scroll min-h-9 flex-1 resize-none")}
        />
        <Button type="submit" variant="primary" loading={saving} disabled={!text.trim()} data-testid="board-ask-submit">
          {!saving && <Plus className="h-4 w-4" aria-hidden />}
          Ask
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!text.trim() || saving}
          data-testid="board-add-submit"
          onClick={() => {
            const message = text.trim();
            if (!message || saving) return;
            setSaving(true);
            setError(undefined);
            void board.addTask(message).then((result) => {
              setSaving(false);
              if (result.ok) {
                setText("");
                ref.current?.focus();
              } else {
                setError(result.error);
              }
            });
          }}
        >
          Add task
        </Button>
      </div>
      {reply && (
        <p className="text-[13px] leading-relaxed text-sa-fg2" data-testid="board-agent-reply">
          {reply}
        </p>
      )}
      {error && (
        <Notice tone="err" title="The task was not added" testId="board-add-error">
          {error}
        </Notice>
      )}
    </form>
  );
}

// ---- Submit work ----

function SubmitWork({
  task,
  agentName,
  run,
  board,
}: {
  task: SwarmTask;
  agentName: string;
  run?: ThreadEntry;
  board: Board;
}) {
  const found = useMemo(() => extractBranchAndPr(run?.finalText), [run?.finalText]);
  const [branch, setBranch] = useState(found.branch ?? "");
  const [prUrl, setPrUrl] = useState(found.prUrl ?? "");
  const [summary, setSummary] = useState(run?.finalText ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const touched = useRef(false);

  // The run's reply can land after the form opens: fill what is still empty.
  useEffect(() => {
    if (touched.current) return;
    if (found.branch) setBranch(found.branch);
    if (found.prUrl) setPrUrl(found.prUrl);
    if (run?.finalText) setSummary(run.finalText);
  }, [found.branch, found.prUrl, run?.finalText]);

  const prInvalid = prUrl.trim().length > 0 && !isSafeHttpUrl(prUrl.trim());
  const ready = branch.trim().length > 0 && summary.trim().length > 0 && !prInvalid;

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(undefined);
    const result = await board.submit({ taskId: task.id, agentName, gitBranch: branch, summary, prUrl });
    setSaving(false);
    if (!result.ok) setError(result.error);
  };

  const id = `submit-${task.id}`;
  return (
    <form
      className="space-y-3 rounded-xl border border-sa-line bg-sa-bg p-3"
      data-testid="board-submit"
      onChange={() => {
        touched.current = true;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-[13px] font-medium text-sa-fg">Submit this work for review</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px] text-sa-fg2" htmlFor={`${id}-branch`}>
          Git branch
          <input
            id={`${id}-branch`}
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            maxLength={TASK_BRANCH_MAX}
            required
            placeholder="feat/my-change"
            autoComplete="off"
            spellCheck={false}
            className={cn(fieldClass, "sa-mono mt-1")}
          />
        </label>
        <label className="block text-[13px] text-sa-fg2" htmlFor={`${id}-pr`}>
          Pull request URL (optional)
          <input
            id={`${id}-pr`}
            value={prUrl}
            onChange={(event) => setPrUrl(event.target.value)}
            maxLength={TASK_PR_URL_MAX}
            inputMode="url"
            placeholder="https://github.com/…/pull/1"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={prInvalid || undefined}
            className={cn(fieldClass, "mt-1")}
          />
          {prInvalid && <span className="mt-1 block text-[12px] text-sa-err">Enter a full http(s) link.</span>}
        </label>
      </div>
      <label className="block text-[13px] text-sa-fg2" htmlFor={`${id}-summary`}>
        Summary of the work
        <textarea
          id={`${id}-summary`}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={TASK_SUMMARY_MAX}
          required
          rows={4}
          placeholder="What changed and how it was verified"
          className={cn(fieldClass, "sa-scroll mt-1 resize-y")}
        />
      </label>
      {error && (
        <Notice tone="err" title="The work was not submitted">
          {error}
        </Notice>
      )}
      <Button type="submit" variant="primary" loading={saving} disabled={!ready} data-testid="board-submit-button">
        Submit for review
      </Button>
    </form>
  );
}

// ---- Task row ----

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-sa-fg3">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] text-sa-fg">{children}</dd>
    </div>
  );
}

function TaskRow({
  task,
  board,
  agentName,
  link,
  run,
  initiallyOpen,
  onRunTask,
  onViewRun,
}: {
  task: SwarmTask;
  board: Board;
  agentName: string;
  link?: TaskRunLink;
  run?: ThreadEntry;
  initiallyOpen: boolean;
  onRunTask: (task: SwarmTask) => Promise<string | undefined>;
  onViewRun: (link: TaskRunLink) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!initiallyOpen) return;
    setOpen(true);
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [initiallyOpen]);

  const meta = TASK_STATUS_META[task.status];
  const mine = task.claimedBy !== undefined && task.claimedBy === (link?.agentName ?? agentName);
  const runPhase = run ? deriveRunPhase({ status: run.status }) : null;
  const runMeta = runPhase ? RUN_PHASE_META[runPhase] : undefined;
  const runActive = runMeta?.active === true;
  const canRun = task.status === "open" || (task.status === "claimed" && mine && !runActive);
  const canSubmit = task.status === "claimed" && mine && !runActive;

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(undefined);
    const problem = await onRunTask(task);
    setStarting(false);
    if (problem) {
      setError(problem);
      setOpen(true);
    }
  };

  const detailId = `task-${task.id}`;
  return (
    <li ref={rowRef} data-testid="board-task" data-task-id={task.id} data-status={task.status} className="sa-enter">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left"
        >
          <ChevronRight
            className={cn("mt-1 h-3.5 w-3.5 shrink-0 text-sa-fg3 transition-transform", open && "rotate-90")}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-sa-fg" data-testid="board-task-title">
              {task.title}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-sa-fg2">
              <StatusBadge tone={meta.tone} label={meta.label} />
              {task.claimedBy && <span className="truncate">{task.claimedBy}</span>}
              <span className="text-sa-fg3">{formatRelativeTime(task.updatedAt)}</span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2 text-[13px]">
          {task.prUrl && <PrLink url={task.prUrl} />}
          {link && runMeta && (
            <Button size="sm" variant="ghost" onClick={() => onViewRun(link)} data-testid="board-view-run">
              <StatusBadge tone={runMeta.tone} label={runMeta.label} live={runMeta.active} />
            </Button>
          )}
          {canRun && (
            <Button size="sm" loading={starting} onClick={() => void start()} data-testid="board-run">
              {!starting && <Play className="h-3.5 w-3.5" aria-hidden />}
              {task.status === "open" ? "Run" : "Run again"}
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div id={detailId} className="space-y-3 px-3 pb-4 pl-[34px]" data-testid="board-task-detail">
          {error && (
            <Notice tone="err" title="The run did not start">
              {error}
            </Notice>
          )}
          {task.description.trim() && task.description.trim() !== task.title.trim() && (
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-sa-fg2">{task.description}</p>
          )}
          {task.constraints.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-sa-fg2">
              {task.constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
          )}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="Difficulty">
              <span className="capitalize">{task.difficulty}</span>
            </Fact>
            <Fact label="Claimed by">{task.claimedBy ?? "Nobody yet"}</Fact>
            <Fact label="Branch">
              {task.gitBranch ? (
                <span className="inline-flex items-center gap-1 font-mono text-[12px]">
                  <GitBranch className="h-3 w-3 shrink-0 text-sa-fg3" aria-hidden />
                  {task.gitBranch}
                </span>
              ) : (
                "None yet"
              )}
            </Fact>
            <Fact label="Pull request">{task.prUrl ? <PrLink url={task.prUrl} /> : "None yet"}</Fact>
          </dl>
          {task.resultSummary && (
            <div data-testid="board-task-result">
              <p className="text-[12px] text-sa-fg3">Result</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-sa-fg">
                {task.resultSummary}
              </p>
            </div>
          )}
          {task.status === "in_review" && (
            <p className="text-[13px] text-sa-fg2">Waiting for a reviewer to approve or send it back.</p>
          )}
          {canSubmit && <SubmitWork task={task} agentName={link?.agentName ?? agentName} run={run} board={board} />}
        </div>
      )}
    </li>
  );
}

// ---- Panel ----

export function BoardPanel({ board, agentName, runFor, onRunTask, onViewRun, focusTaskId, className }: BoardPanelProps) {
  const groups = useMemo(() => groupBoardTasks(board.tasks), [board.tasks]);
  const focused = focusTaskId ? board.tasks.find((task) => task.id === focusTaskId) : undefined;
  // Completed tasks are folded away until asked for, or until one is opened from a run.
  const focusedCompleted = focused?.status === "completed";
  const [showCompleted, setShowCompleted] = useState(focusedCompleted);
  useEffect(() => {
    if (focusedCompleted) setShowCompleted(true);
  }, [focusedCompleted, focusTaskId]);

  return (
    <section className={cn("flex min-h-0 flex-col", className)} aria-label="SwarmBoard" data-testid="board-panel">
      <div className="sa-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] space-y-4 px-4 py-6">
          <header>
            <h2 className="text-xl font-semibold tracking-tight text-sa-fg">Board</h2>
            <p className="mt-1 text-[13px] text-sa-fg2">
              Tasks for the swarm. Run one on your VM, then submit the result for review.
            </p>
          </header>

          {!board.writable && (
            <Notice tone="warn" title="The board cannot save right now" testId="board-readonly">
              New tasks and updates will fail until the server can write its board file.
            </Notice>
          )}

          <AddTask board={board} />

          {board.error && (
            <Notice
              tone="err"
              title={board.status === "error" ? "The board could not be loaded" : "The board could not be refreshed"}
              testId="board-error"
              action={
                <Button size="sm" onClick={() => void board.refresh()}>
                  Retry
                </Button>
              }
            >
              {board.error.message}
              {board.status === "ready" && " Showing the last tasks that loaded."}
            </Notice>
          )}

          {board.status === "loading" && <Loading label="Loading the board" className="py-10" />}

          {board.status === "ready" && board.tasks.length === 0 && (
            <div className="rounded-xl border border-dashed border-sa-line-strong px-4 py-10 text-center" data-testid="board-empty">
              <p className="text-sm font-medium text-sa-fg">No tasks yet</p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-sa-fg2">
                Add the first task above. Run it on your VM, and it moves through review to completed.
              </p>
            </div>
          )}

          {groups.map((group) => {
            const collapsed = group.status === "completed" && !showCompleted;
            return (
              <section key={group.status} aria-label={`${group.label} tasks`} data-testid={`board-group-${group.status}`}>
                <div className="flex h-8 items-center justify-between">
                  <h3 className="text-[12px] font-medium text-sa-fg3">
                    {group.label} <span className="sa-tabular ml-1">{group.tasks.length}</span>
                  </h3>
                  {group.status === "completed" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={!collapsed}
                      onClick={() => setShowCompleted((value) => !value)}
                    >
                      {collapsed ? "Show" : "Hide"}
                    </Button>
                  )}
                </div>
                {!collapsed && (
                  <ul className="divide-y divide-sa-line overflow-hidden rounded-xl border border-sa-line bg-sa-panel">
                    {group.tasks.map((task) => {
                      const link = board.links[task.id];
                      return (
                        <TaskRow
                          key={task.id}
                          task={task}
                          board={board}
                          agentName={agentName}
                          link={link}
                          run={link ? runFor(link.runId) : undefined}
                          initiallyOpen={task.id === focusTaskId}
                          onRunTask={onRunTask}
                          onViewRun={onViewRun}
                        />
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default BoardPanel;
