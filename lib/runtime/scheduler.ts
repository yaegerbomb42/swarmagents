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
import { dueTasks, finishTask, getTask, listTasks, runningTasks, setStatus, waitTask } from "./tasks";
import { loadRuntimeSettings } from "./store";

const TICK_MS = 2000;

class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private started = false;

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
          await waitTask(t.id, { kind: "backoff", message: "Resuming.", resumeAt: Date.now() });
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
    const run = startRun(taskId, running.sessionId, attempt);
    addStep(taskId, run.id, { kind: "checkpoint", label: `Attempt ${attempt} started`, detail: running.prompt.slice(0, 200) });

    const controller = new AbortController();
    let parked = false;

    try {
      const outcome = await adapter.run(running, {
        signal: controller.signal,
        onTurn: (u) => void recordTurn(taskId, run.id, u),
        onTool: (name, ok) => {
          void recordTool(taskId, run.id, ok);
          addStep(taskId, run.id, { kind: "tool", label: name, ok });
        },
        onNote: (text) => noteRun(taskId, run.id, text),
        onQuotaWait: (ms, message) => {
          parked = true;
          void waitTask(taskId, { kind: "quota", message, resumeAt: Date.now() + ms });
          addStep(taskId, run.id, { kind: "notice", label: "Paused on quota", detail: `${message} (${fmtDuration(ms)})` });
        },
      });

      if (parked) {
        endRun(taskId, run.id, "interrupted", Date.now() - t0);
        return;
      }

      const artifactIds: string[] = [];
      for (const out of outcome.outputs ?? []) {
        const a = await registerArtifact({ taskId, runId: run.id, kind: "file", title: out.title ?? basename(out.path), path: out.path });
        artifactIds.push(a.id);
      }

      if (outcome.needs) {
        await waitTask(taskId, { kind: outcome.needs.kind, message: outcome.needs.message });
        endRun(taskId, run.id, "interrupted", Date.now() - t0);
        addStep(taskId, run.id, { kind: "notice", label: "Waiting on you", detail: outcome.needs.message });
        return;
      }

      const budget = checkBudget(taskId);
      if (budget.exceeded) {
        await waitTask(taskId, { kind: "approval", message: `${budget.reason} Approve continuing.` });
        endRun(taskId, run.id, "interrupted", Date.now() - t0);
        return;
      }

      endRun(taskId, run.id, "done", Date.now() - t0);
      addStep(taskId, run.id, { kind: "checkpoint", label: "Finished", detail: outcome.summary.slice(0, 300), ok: true });
      await finishTask(taskId, {
        summary: outcome.summary,
        artifactIds,
        verified: outcome.verified ?? false,
        outcome: "success",
      });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      endRun(taskId, run.id, "failed", Date.now() - t0);
      addStep(taskId, run.id, { kind: "notice", label: "Run failed", detail: msg, ok: false });
      // A failed attempt is not fatal: retry with backoff unless the budget says stop.
      const budget = checkBudget(taskId);
      if (budget.exceeded) {
        await finishTask(taskId, { summary: msg, artifactIds: [], verified: false, outcome: "failed" });
      } else {
        await waitTask(taskId, { kind: "backoff", message: `Retrying after error: ${msg.slice(0, 120)}`, resumeAt: Date.now() + 5000 });
      }
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