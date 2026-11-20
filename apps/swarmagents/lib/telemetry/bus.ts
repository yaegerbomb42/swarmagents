import { getRunsDir } from "./paths";
import {
  appendRunEvent,
  flushRunLogs,
  MAX_RUN_LOG_BYTES,
  tailRunLogLastSeq,
} from "./run-log";
import { updateRunIndex } from "../runtime/run-index";

export interface TelemetryEvent {
  type: string;
  data?: unknown;
}

export interface SequencedEvent extends TelemetryEvent {
  seq: number;
  runId: string;
  ts: number;
}

export type TelemetryListener = (event: SequencedEvent) => void;

export interface TelemetryBusOptions {
  capacity?: number;
  idleMs?: number;
  /** Append every event to `<runsDir>/<runId>.jsonl` when true. */
  persist?: boolean;
  /** Resolved lazily so an env change or test hook can redirect the log. */
  runsDir?: () => string | null;
  /** Rotate the per-run log once it would exceed this many bytes. */
  maxLogBytes?: number;
}

interface RunState {
  seq: number;
  buffer: SequencedEvent[];
  listeners: Set<TelemetryListener>;
  lastActivity: number;
}

export class TelemetryBus {
  private readonly runs = new Map<string, RunState>();
  /**
   * Bounded fast path for the last known seq per run. It survives eviction so
   * a rebuilt run continues numbering instead of restarting at 1 (which froze
   * reconnecting streams and duplicated seqs in the durable log).
   */
  private readonly lastSeqs = new Map<string, number>();
  private readonly capacity: number;
  private readonly idleMs: number;
  private readonly persist: boolean;
  private readonly resolveRunsDir: () => string | null;
  private readonly maxLogBytes: number;

  constructor(options: TelemetryBusOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 1000);
    this.idleMs = Math.max(0, options.idleMs ?? 60_000);
    this.persist = options.persist ?? false;
    this.resolveRunsDir = options.runsDir ?? getRunsDir;
    this.maxLogBytes = Math.max(1024, options.maxLogBytes ?? MAX_RUN_LOG_BYTES);
  }

  publish(runId: string, event: TelemetryEvent): SequencedEvent {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        seq: this.recoverLastSeq(runId),
        buffer: [],
        listeners: new Set(),
        lastActivity: Date.now(),
      };
      this.runs.set(runId, run);
    }
    const sequenced: SequencedEvent = {
      ...event,
      seq: ++run.seq,
      runId,
      ts: Date.now(),
    };
    run.buffer.push(sequenced);
    if (run.buffer.length > this.capacity) {
      run.buffer.splice(0, run.buffer.length - this.capacity);
    }
    run.lastActivity = sequenced.ts;
    this.rememberSeq(runId, sequenced.seq);
    if (this.persist) {
      const dir = this.resolveRunsDir();
      if (dir) {
        appendRunEvent(sequenced, dir, this.maxLogBytes);
        // Keep the durable summary index in step with the log so listing a
        // run never has to parse its event segments.
        updateRunIndex(sequenced, dir);
      }
    }
    for (const listener of [...run.listeners]) {
      try {
        listener(sequenced);
      } catch (err) {
        console.error("telemetry listener failed:", err);
      }
    }
    return sequenced;
  }

  subscribe(runId: string, fromSeq: number, listener: TelemetryListener): () => void {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        seq: this.recoverLastSeq(runId),
        buffer: [],
        listeners: new Set(),
        lastActivity: Date.now(),
      };
      this.runs.set(runId, run);
    }
    run.listeners.add(listener);
    for (const event of run.buffer) {
      if (event.seq > fromSeq) listener(event);
    }
    return () => {
      run.listeners.delete(listener);
    };
  }

  subscriberCount(runId: string): number {
    return this.runs.get(runId)?.listeners.size ?? 0;
  }

  /**
   * Flush persisted run logs to disk. Appends are synchronous today, so this
   * fsyncs the log files — but it is the seam a future buffered writer must
   * implement so the shutdown handler can guarantee telemetry is durable
   * before the process exits.
   */
  flush(): void {
    flushRunLogs(this.resolveRunsDir());
  }

  latestSeq(runId: string): number {
    return this.runs.get(runId)?.seq ?? this.lastSeqs.get(runId) ?? 0;
  }

  evictIdleRuns(now: number = Date.now()): number {
    let evicted = 0;
    for (const [runId, run] of this.runs) {
      if (run.listeners.size === 0 && now - run.lastActivity >= this.idleMs) {
        this.runs.delete(runId);
        evicted++;
      }
    }
    return evicted;
  }

  private rememberSeq(runId: string, seq: number): void {
    this.lastSeqs.set(runId, seq);
    // Bound the fast-path map so eviction's memory win stays real.
    if (this.lastSeqs.size > this.capacity * 4) {
      const oldest = this.lastSeqs.keys().next().value;
      if (oldest !== undefined) this.lastSeqs.delete(oldest);
    }
  }

  /**
   * Recover the last seq emitted for a run whose in-memory state was evicted.
   * Prefers the bounded fast path; for persisted logs it falls back to a cheap
   * tail read of the durable log (also correct across a process restart).
   */
  private recoverLastSeq(runId: string): number {
    const cached = this.lastSeqs.get(runId);
    if (cached !== undefined) return cached;
    let last = 0;
    if (this.persist) {
      const dir = this.resolveRunsDir();
      if (dir) last = tailRunLogLastSeq(runId, dir);
    }
    if (last > 0) this.rememberSeq(runId, last);
    return last;
  }
}

// One bus per server process, even when Next loads this module in several bundles.
const g = globalThis as typeof globalThis & { __swarmTelemetryBus?: TelemetryBus };
export const telemetryBus: TelemetryBus =
  g.__swarmTelemetryBus ??
  (g.__swarmTelemetryBus = new TelemetryBus({ persist: true, runsDir: getRunsDir }));
if (!(g as { __swarmTelemetryEvict?: unknown }).__swarmTelemetryEvict) {
  const t = setInterval(() => telemetryBus.evictIdleRuns(), 60_000);
  t.unref?.();
  (g as { __swarmTelemetryEvict?: unknown }).__swarmTelemetryEvict = t;
}
