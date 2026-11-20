// Per-user reader/writer lock: many exec/read/write operations may run
// concurrently, while destructive operations (reset/stop/snapshot) get
// exclusive access. Waiting writers block new readers so a reset cannot be
// starved by a stream of execs.

type Waiter =
  | { type: "read"; resolve: () => void }
  | { type: "write"; resolve: () => void };

export class RwLock {
  private readers = 0;
  private writer = false;
  private queue: Waiter[] = [];

  async acquireRead(): Promise<void> {
    if (!this.writer && this.queue.length === 0) {
      this.readers++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push({ type: "read", resolve }));
  }

  releaseRead(): void {
    if (this.readers > 0) this.readers--;
    this.drain();
  }

  async acquireWrite(): Promise<void> {
    if (!this.writer && this.readers === 0 && this.queue.length === 0) {
      this.writer = true;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push({ type: "write", resolve }));
  }

  releaseWrite(): void {
    this.writer = false;
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.type === "write") {
        if (this.writer || this.readers > 0) return;
        this.queue.shift();
        this.writer = true;
        next.resolve();
        return;
      }
      if (this.writer) return;
      while (this.queue.length > 0 && this.queue[0].type === "read") {
        const reader = this.queue.shift()!;
        this.readers++;
        reader.resolve();
      }
    }
  }
}