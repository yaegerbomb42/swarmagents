"use client";

export type AgentEventType =
  | "thought"
  | "tool_call"
  | "tool_result"
  | "memory"
  | "state"
  | "error";

export interface AgentEvent {
  id: string;
  agentId: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface AgentStreamState {
  agentId: string;
  lastSeen: number;
  eventCount: number;
  lastEvent?: AgentEvent;
  recentTypes: AgentEventType[];
  sparkline: number[];
}

const MAX_AGENTS = 1000;
const SPARK_LEN = 20;
const EVENT_BUFFER = 500;
const TICK_MS = 1000;

type Listener = () => void;

class AgentStreamStore {
  private agents = new Map<string, AgentStreamState>();
  /** Absolute tick index (timestamp / TICK_MS) of the newest sparkline bucket per agent. */
  private sparkHead = new Map<string, number>();
  private buffer: AgentEvent[] = [];
  private listeners = new Set<Listener>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  // Cached snapshots invalidated when state changes so that
  // useSyncExternalStore consumers receive referentially stable getSnapshot
  // results between notifies. Without this, React 18's
  // "getSnapshot should be cached" guard fires and the consumer loops.
  private agentsCache: AgentStreamState[] | null = null;
  private bufferCache: AgentEvent[] | null = null;

  ingest(evt: AgentEvent): void {
    this.buffer.push(evt);
    if (this.buffer.length > EVENT_BUFFER) this.buffer.splice(0, this.buffer.length - EVENT_BUFFER);

    let s = this.agents.get(evt.agentId);
    if (!s) {
      if (this.agents.size >= MAX_AGENTS) return;
      s = {
        agentId: evt.agentId,
        lastSeen: 0,
        eventCount: 0,
        recentTypes: [],
        sparkline: new Array(SPARK_LEN).fill(0),
      };
      this.agents.set(evt.agentId, s);
    }
    s.lastSeen = evt.timestamp;
    s.eventCount += 1;
    s.lastEvent = evt;
    s.recentTypes.push(evt.type);
    if (s.recentTypes.length > 8) s.recentTypes.shift();
    const tick = Math.floor(evt.timestamp / TICK_MS);
    this.rollSparkline(s, tick);
    const head = this.sparkHead.get(s.agentId) ?? tick;
    // Events older than the window are dropped rather than aliased onto a fresh bucket.
    if (tick > head - SPARK_LEN) {
      const bucket = ((tick % SPARK_LEN) + SPARK_LEN) % SPARK_LEN;
      s.sparkline[bucket] = (s.sparkline[bucket] ?? 0) + 1;
    }
    this.dirty = true;
    this.agentsCache = null;
    this.bufferCache = null;
  }

  /**
   * Advance an agent's ring to `tick`, zeroing every bucket that has been
   * skipped since the previous head so stale counts from SPARK_LEN seconds
   * ago never alias into the current window.
   */
  private rollSparkline(s: AgentStreamState, tick: number): boolean {
    const head = this.sparkHead.get(s.agentId);
    if (head === undefined) {
      this.sparkHead.set(s.agentId, tick);
      return false;
    }
    if (tick <= head) return false;
    const steps = Math.min(tick - head, SPARK_LEN);
    const next = s.sparkline.slice();
    for (let i = 1; i <= steps; i++) {
      const b = (((head + i) % SPARK_LEN) + SPARK_LEN) % SPARK_LEN;
      next[b] = 0;
    }
    s.sparkline = next;
    this.sparkHead.set(s.agentId, tick);
    return true;
  }

  /** Decay sparklines of quiet agents up to wall-clock `now`. */
  advance(now: number = Date.now()): void {
    const tick = Math.floor(now / TICK_MS);
    let changed = false;
    this.agents.forEach((s) => {
      if (this.rollSparkline(s, tick)) changed = true;
    });
    if (changed) {
      this.dirty = true;
      this.agentsCache = null;
    }
  }

  ingestMany(evts: AgentEvent[]): void {
    for (const e of evts) this.ingest(e);
  }

  agentsSnapshot(): AgentStreamState[] {
    if (this.agentsCache === null) {
      this.agentsCache = Array.from(this.agents.values());
    }
    return this.agentsCache;
  }

  size(): number {
    return this.agents.size;
  }

  bufferSnapshot(): AgentEvent[] {
    if (this.bufferCache === null) {
      this.bufferCache = this.buffer.slice();
    }
    return this.bufferCache;
  }

  clear(): void {
    this.agents.clear();
    this.sparkHead.clear();
    this.buffer = [];
    this.agentsCache = null;
    this.bufferCache = null;
    this.emit();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    this.startTick();
    return () => this.listeners.delete(l);
  }

  private startTick(): void {
    if (this.tickTimer) return;
    let ticks = 0;
    this.tickTimer = setInterval(() => {
      if (++ticks % 4 === 0) this.advance();
      if (!this.dirty) return;
      this.dirty = false;
      // Snapshots were invalidated by ingest; emit now so subscribers
      // re-call getSnapshot and land on the freshly-rebuilt cached arrays.
      this.emit();
    }, 250);
  }

  private emit(): void {
    this.listeners.forEach((l) => {
      try {
        l();
      } catch {
        /* noop */
      }
    });
  }
}

const KEY = "__agent_stream_store__";
function getStore(): AgentStreamStore {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new AgentStreamStore();
  return g[KEY] as AgentStreamStore;
}

export const agentStreamStore = getStore();
