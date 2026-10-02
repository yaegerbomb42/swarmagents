// Scheduler: the loop that keeps the phone running (or on hold) forever.
//
// Responsibilities:
//   - start runnable tasks up to the configured concurrency;
//   - run each task through the registered agent adapter;
//   - fold turns/tools into the ledger and enforce budgets;
//   - on a quota wait, park the task with a resume time instead of failing, and wake it
//     automatically - this is what lets a task survive for 24h+ on a limited key;
//   - on process start, reconcile tasks that were "running" when we died.
//
// The scheduler is a singleton on globalThis so Next.js hot reloads do not spawn a
// second one.

import { requireAdapter } from "./resume";
import { addStep, checkBudget, endRun, fmtDuration, noteRun, recordTool, recordTurn, startRun } from "./ledger";
import { registerArtifact } from "./artifacts";
import { dueTasks, finishTask, getTask, listTasks, requeueTask, runningTasks, setStatus, waitTask } from "./tasks";
import { loadRuntimeSettings } from "./store";

const TICK_MS = 2000;

class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private started = false;
  /**
   * Runs currently in flight, keyed by task. This is the single source of truth for "can this
   * task be stopped", so pause/cancel go through the scheduler instead of reaching into the
   * agent directly. It also lets a late-settling run detect that it has been superseded and
   * must not overwrite the newer state.
   */
  private active = new Map<string, { controller: AbortController; runId: string; attempt: number }>();

  start() {
    if (this.started) return;
    this.started = true;
    this.reconcile();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Don't keep the process alive just for the scheduler.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** A crash leaves tasks marked running with no live run. Settle them so they can resume. */
  private reconcile() {
    const settings = loadRuntimeSettings();
    for (const t of listTasks()) {
      if (t.status !== "running") continue;
      if (settings.autoResume) {
        void waitTask(t.id, {
          kind: "backoff",
          message: "Resuming after a restart.",
          resumeAt: Date.now(),
        });
      } else {
        void waitTask(t.id, { kind: "input", message: "Interrupted by a restart; press resume to continue." });
      }
    }
  }

  /** Kick the scheduler immediately (after a new task is created or a wait is cleared). */
  kick() {
    void this.tick();
  }

  /**
   * Stop the live run for a task, if any, and hand back the task to the caller after it has
   * settled. Aborting through the scheduler's own controller is what makes pause/cancel
   * reliable: the agent stops, the run unwinds, and the stale-completion guard (isCurrent)
   * keeps that unwinding run from overwriting the state the caller sets next.
   */
  async stopTask(taskId: string): Promise<void> {
    const run = this.active.get(taskId);
    if (!run) return;
    run.controller.abort();
    // Give the in-flight run a moment to settle so its guarded transitions don't race ours.
    await Promise.resolve();
    this.active.delete(taskId);
  }

  /** Is this run still the one we are tracking for the task? False once stopped or superseded. */
  private isCurrent(taskId: string, runId: string): boolean {
    return this.active.get(taskId)?.runId === runId;
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = loadRuntimeSettings();
      const active = runningTasks().length;
      const slots = Math.max(0, settings.concurrency - active);
      if (slots > 0) {
        // Re-queue any due waiting tasks so they are picked up by runnable ordering.
        for (const t of dueTasks()) {
          await requeueTask(t.id);
        }
        const runnable = listTasks().filter((t) => t.status === "queued");
        for (const t of runnable.slice(0, slots)) {
          void this.runTask(t.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runTask(taskId: string) {
    const t0 = Date.now();
    if (!getTask(taskId)) return;
    const adapter = requireAdapter();

    // Claim the task first: this increments the attempt counter and emits "running".
    const running = await setStatus(taskId, "running");
    if (!running) return;
    const attempt = running.attempts;
    const run = await startRun(taskId, running.sessionId, attempt);
    await addStep(taskId, run.id, { kind: "checkpoint", label: `Attempt ${attempt} started`, detail: running.prompt.slice(0, 200) });

    const controller = new AbortController();
    this.active.set(taskId, { controller, runId: run.id, attempt });
    let parked = false;
    // Recorder hook promises. They are fire-and-forget during the run so hooks never
    // block the agent, but we flush them before any decision that reads usage (budget).
    const pending = new Set<Promise<unknown>>();
    const track = <T,>(p: Promise<T>): void => {
      pending.add(p);
      void p.finally(() => pending.delete(p));
    };
    const flush = () => Promise.all([...pending]);

    try {
      const outcome = await adapter.run(running, {
        signal: controller.signal,
        onTurn: (u) => track(recordTurn(taskId, run.id, u)),
        onTool: (name, ok) => {
          track(recordTool(taskId, run.id, ok));
          track(addStep(taskId, run.id, { kind: "tool", label: name, ok }));
        },
        onNote: (text) => track(noteRun(taskId, run.id, text)),
        onQuotaWait: (ms, message) => {
          // A quota wait only parks the task when the run was actually aborted. If the agent
          // is still working (the router sleeps and retries in place), the wait is recorded
          // and the run continues - that is what lets one task survive for 24h+ on a limited key.
          if (controller.signal.aborted) parked = true;
          track(noteRun(taskId, run.id, message));
          track(addStep(taskId, run.id, { kind: "notice", label: "Waiting on quota", detail: `${message} (${fmtDuration(ms)})` }));
        },
      });
      await flush();

      // If the user paused/cancelled (or the task was superseded) while we ran, this run is
      // stale: record it as interrupted and return without touching the task's newer state.
      if (!this.isCurrent(taskId, run.id)) {
        await endRun(taskId, run.id, "interrupted", Date.now() - t0);
        return;
      }

      if (parked) {
        await endRun(taskId, run.id, "interrupted", Date.now() - t0);
        return;
      }

      const artifactIds: string[] = [];
      for (const out of outcome.outputs ?? []) {
        const a = await registerArtifact({ taskId, runId: run.id, kind: "file", title: out.title ?? basename(out.path), path: out.path });
        artifactIds.push(a.id);
      }

      if (outcome.needs) {
        await waitTask(taskId, { kind: outcome.needs.kind, message: outcome.needs.message, token: outcome.needs.token });
        await endRun(taskId, run.id, "interrupted", Date.now() - t0);
        await addStep(taskId, run.id, { kind: "notice", label: "Waiting on you", detail: outcome.needs.message });
        return;
      }

      const budget = checkBudget(taskId);
      if (budget.exceeded) {
        await waitTask(taskId, { kind: "approval", message: `${budget.reason} Approve continuing.` });
        await endRun(taskId, run.id, "interrupted", Date.now() - t0);
        return;
      }

      await endRun(taskId, run.id, "done", Date.now() - t0);
      await addStep(taskId, run.id, { kind: "checkpoint", label: "Finished", detail: outcome.summary.slice(0, 300), ok: true });
      await finishTask(taskId, {
        summary: outcome.summary,
        artifactIds,
        verified: outcome.verified ?? false,
        outcome: "success",
      });
    } catch (e) {
      // A stopped/superseded run must not write failure state over a user's pause/cancel.
      if (!this.isCurrent(taskId, run.id)) {
        await endRun(taskId, run.id, "interrupted", Date.now() - t0);
        return;
      }
      const msg = (e as Error).message || String(e);
      await endRun(taskId, run.id, "failed", Date.now() - t0);
      await addStep(taskId, run.id, { kind: "notice", label: "Run failed", detail: msg, ok: false });
      // A failed attempt is not fatal: retry with backoff unless the budget says stop.
      const budget = checkBudget(taskId);
      if (budget.exceeded) {
        await finishTask(taskId, { summary: msg, artifactIds: [], verified: false, outcome: "failed" });
      } else {
        await waitTask(taskId, { kind: "backoff", message: `Retrying after error: ${msg.slice(0, 120)}`, resumeAt: Date.now() + 5000 });
      }
    } finally {
      // Release the slot only if we are still the registered run; a newer attempt owns it otherwise.
      if (this.isCurrent(taskId, run.id)) this.active.delete(taskId);
    }
  }
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

const g = globalThis as unknown as { __swarmScheduler?: Scheduler };

export function scheduler(): Scheduler {
  return (g.__swarmScheduler ??= new Scheduler());
}