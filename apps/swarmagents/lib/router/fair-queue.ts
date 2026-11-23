interface QueuedTask {
  userId: string;
  taskId: string;
  canRunNow: () => boolean;
  start: () => void;
  reject: (err: Error) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class QueueWaitTimeoutError extends Error {
  readonly code = "QUEUE_WAIT_TIMEOUT";

  constructor(message = "Timed out waiting for a fair-queue slot") {
    super(message);
    this.name = "QueueWaitTimeoutError";
  }
}

/**
 * Multi-tenant fair scheduler.
 *
 * Keeps one FIFO per user and serves the least-recently-served user first, so a user submitting a
 * large burst cannot starve other tenants. A dispatched task holds one of
 * `globalMaxConcurrent` slots until its owner calls the release function it
 * was handed — i.e. for the whole upstream LLM call, not just for the time
 * it takes to pick a route.
 *
 * A task may pass `waitTimeoutMs`: if it has not been dispatched by then it
 * is dequeued and its promise rejects with QueueWaitTimeoutError, instead of
 * waiting forever behind a slot whose release was leaked.
 */
export class FairTenantQueue {
  private readonly queues = new Map<string, QueuedTask[]>();
  private readonly userOrder: string[] = [];
  /** Dispatch sequence number of each user's most recent turn. */
  private readonly lastServed = new Map<string, number>();
  private serveSeq = 0;
  private globalInFlight = 0;

  constructor(private readonly globalMaxConcurrent: number = Number.POSITIVE_INFINITY) {}

  get activeInFlight(): number {
    return this.globalInFlight;
  }

  get queuedCount(): number {
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }

  /**
   * Wait for a fair turn. Resolves with the result of `run` (called
   * synchronously at dispatch time) and a `release` that frees the global
   * slot. `run` receives that release too, and may call it right away (for
   * example when no route was found and nothing will be sent upstream).
   *
   * With `opts.waitTimeoutMs`, a task still queued when the timeout expires
   * is dequeued and the promise rejects with QueueWaitTimeoutError. The
   * timeout covers queueing only — once dispatched, the slot is held until
   * `release` as before.
   */
  enqueue<T>(
    userId: string,
    taskId: string,
    canRunNow: () => boolean,
    run: (release: () => void) => T,
    opts?: { waitTimeoutMs?: number },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let userQueue = this.queues.get(userId);
      if (!userQueue) {
        userQueue = [];
        this.queues.set(userId, userQueue);
        this.userOrder.push(userId);
      }
      const task: QueuedTask = {
        userId,
        taskId,
        canRunNow,
        settled: false,
        reject,
        start: () => {
          task.settled = true;
          if (task.timer !== undefined) clearTimeout(task.timer);
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            this.globalInFlight = Math.max(0, this.globalInFlight - 1);
            this.drain();
          };
          try {
            resolve(run(release));
          } catch (err) {
            release();
            reject(err);
          }
        },
      };
      const waitTimeoutMs = opts?.waitTimeoutMs;
      // Only finite timeouts arm a timer: setTimeout(Infinity) fires almost
      // immediately in Node, which would invert the caller's intent.
      if (waitTimeoutMs !== undefined && Number.isFinite(waitTimeoutMs)) {
        task.timer = setTimeout(() => this.expireTask(task, waitTimeoutMs), waitTimeoutMs);
      }
      userQueue.push(task);
      this.drain();
    });
  }

  /** Re-check queued tasks (e.g. after a per-user or per-key slot freed up). */
  notifyCapacityAvailable(): void {
    this.drain();
  }

  private expireTask(task: QueuedTask, waitTimeoutMs: number): void {
    if (task.settled) return;
    task.settled = true;
    const queue = this.queues.get(task.userId);
    if (queue) {
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) this.removeUser(task.userId);
    }
    task.reject(
      new QueueWaitTimeoutError(
        `Task ${task.taskId} timed out after ${waitTimeoutMs}ms waiting for a slot`,
      ),
    );
    // Removing a blocked head task can make the next task dispatchable.
    this.drain();
  }

  private draining = false;

  private drain(): void {
    // Re-entrancy guard: a task's run() may release synchronously.
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.globalInFlight < this.globalMaxConcurrent && this.userOrder.length > 0) {
        if (!this.dispatchNextEligibleUserTask()) break;
      }
    } finally {
      this.draining = false;
    }
  }

  private dispatchNextEligibleUserTask(): boolean {
    // Least-recently-served user first (never-served users first, in arrival
    // order). Unlike a rotating cursor this stays fair when a user's queue
    // empties and refills between dispatches.
    let pick: { userId: string; queue: QueuedTask[]; served: number; order: number } | null = null;
    for (const [order, userId] of this.userOrder.entries()) {
      const queue = this.queues.get(userId);
      if (!queue || queue.length === 0) continue;
      // This user's own concurrency/key cap is saturated: give the turn to someone else.
      if (!queue[0]!.canRunNow()) continue;
      const served = this.lastServed.get(userId) ?? -1;
      if (!pick || served < pick.served || (served === pick.served && order < pick.order)) {
        pick = { userId, queue, served, order };
      }
    }
    if (!pick) return false;
    const head = pick.queue.shift()!;
    if (pick.queue.length === 0) this.removeUser(pick.userId);
    this.lastServed.set(pick.userId, ++this.serveSeq);
    this.globalInFlight++;
    head.start();
    return true;
  }

  private removeUser(userId: string): void {
    const index = this.userOrder.indexOf(userId);
    if (index >= 0) this.userOrder.splice(index, 1);
    this.queues.delete(userId);
    // Keep the service history bounded: forget the oldest idle users.
    if (this.lastServed.size > 10_000) {
      for (const id of this.lastServed.keys()) {
        if (this.lastServed.size <= 5_000) break;
        if (!this.queues.has(id)) this.lastServed.delete(id);
      }
    }
  }
}
