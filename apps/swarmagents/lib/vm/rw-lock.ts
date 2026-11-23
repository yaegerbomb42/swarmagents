// Per-user reader/writer lock: many exec/read/write operations may run
// concurrently, while destructive operations (reset/stop/snapshot) get
// exclusive access. Waiting writers block new readers so a reset cannot be
// starved by a stream of execs.
//
// Acquires may pass a timeout: without one, a single leaked release (an
// exception path that skips release) wedges every later waiter for that
// user forever, silently. With a timeout the waiter is dequeued and the
// acquire rejects with LockTimeoutError instead.

export class LockTimeoutError extends Error {
  readonly code = "LOCK_TIMEOUT";

  constructor(message = "Timed out waiting to acquire the lock") {
    super(message);
    this.name = "LockTimeoutError";
  }
}

type Waiter = {
  type: "read" | "write";
  resolve: () => void;
  reject: (err: Error) => void;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export class RwLock {
  private readers = 0;
  private writer = false;
  private queue: Waiter[] = [];

  async acquireRead(timeoutMs?: number): Promise<void> {
    if (!this.writer && this.queue.length === 0) {
      this.readers++;
      return;
    }
    await this.enqueueWaiter("read", timeoutMs);
  }

  releaseRead(): void {
    if (this.readers > 0) this.readers--;
    this.drain();
  }

  async acquireWrite(timeoutMs?: number): Promise<void> {
    if (!this.writer && this.readers === 0 && this.queue.length === 0) {
      this.writer = true;
      return;
    }
    await this.enqueueWaiter("write", timeoutMs);
  }

  releaseWrite(): void {
    this.writer = false;
    this.drain();
  }

  private enqueueWaiter(type: "read" | "write", timeoutMs?: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { type, resolve, reject, cancelled: false };
      // Only finite timeouts arm a timer: setTimeout(Infinity) fires almost
      // immediately in Node, which would invert the caller's intent.
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(() => {
          waiter.cancelled = true;
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(
            new LockTimeoutError(
              `Timed out after ${timeoutMs}ms waiting for ${type} access`,
            ),
          );
          // Removing a head waiter can unblock the waiters behind it
          // (e.g. readers queued behind a timed-out writer).
          this.drain();
        }, timeoutMs);
      }
      this.queue.push(waiter);
    });
  }

  private grant(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.resolve();
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (next.cancelled) {
        this.queue.shift();
        continue;
      }
      if (next.type === "write") {
        if (this.writer || this.readers > 0) return;
        this.queue.shift();
        this.writer = true;
        this.grant(next);
        return;
      }
      if (this.writer) return;
      while (this.queue.length > 0 && this.queue[0]!.type === "read") {
        const reader = this.queue.shift()!;
        if (reader.cancelled) continue;
        this.readers++;
        this.grant(reader);
      }
    }
  }
}
