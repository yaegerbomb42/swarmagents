/**
 * Serialized gate queue for ClaudeCodeRunner.
 *
 * Gates (approvals, questions, handoffs, System-1 / Decision-Brain hooks,
 * role switches) run one at a time in arrival order, and run finalization
 * awaits the queue. The queue never rejects: an unexpected throw inside any
 * gate is isolated by `onError` and the queue keeps serving later gates, so
 * one failing gate can never permanently poison the chain and silently skip
 * every subsequent gate in the run.
 *
 * Fail-closed vs fail-open lives in the caller's `onError`: approval /
 * role / desktop gates halt the run by setting `haltedReason`, while
 * System-1 / Decision-Brain hooks already fail open internally and pass no
 * `onError` (or one that only logs).
 */
export class GateQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  /**
   * Queue `task` behind every gate already queued. The returned promise
   * resolves with the task's value, or `undefined` when the task throws
   * (after `onError` runs). It never rejects.
   */
  enqueue<T>(task: () => Promise<T>, opts: { onError?: (err: unknown) => void } = {}): Promise<T | undefined> {
    this.pending += 1;

    let resolveResult!: (value: T | undefined) => void;
    const resultPromise = new Promise<T | undefined>((resolve) => {
      resolveResult = resolve;
    });

    this.tail = this.tail.then(async () => {
      try {
        resolveResult(await task());
      } catch (err) {
        opts.onError?.(err);
        resolveResult(undefined);
      } finally {
        this.pending -= 1;
      }
    });

    return resultPromise;
  }

  /** Wait until all currently queued gates have settled. Never rejects. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
