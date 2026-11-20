/**
 * Run-efficiency metrics shared by the loop diagnostics: how much of a run's wall time was
 * actual work vs. idle gaps or verification gates, and how much of its tool traffic was
 * bookkeeping. This is the single source of truth `run-diagnosis.ts` reads; it never talks to
 * the network or any agent state.
 */

/** Tools that keep notes rather than do the work (kept in sync with the agent loop). */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  'todo',
  'running_context',
  'remember',
  'context',
  'recall',
]);

/** A gap longer than this between events is idle (no turn, tool, or gate covers it). */
export const IDLE_GAP_MS = 60_000;

/** One gate in a `verify.gates` event. */
export interface RunEventGate {
  durationMs?: number;
}

/** A single recorded event from a completed run. Fields are optional so decoders stay lenient. */
export interface RunEvent {
  type: string;
  /** Monotonic timestamp (ms) when the event was recorded. */
  ts: number;
  /** Elapsed ms the event represents (turns, tool calls, loop gates). */
  ms?: number;
  /** 1-based model turn when known. */
  turn?: number;
  /** Tool name for tool-call events. */
  tool?: string;
  /** Raw tool input; may be an object or a JSON string. */
  input?: unknown;
  /** Token counters on a turn event, if reported. */
  tokens?: unknown;
  /** Error text, when the call failed. */
  error?: string;
  command?: string;
  reason?: string;
  rule?: string;
  isError?: boolean;
  /** Per-gate durations for `verify.gates` events. */
  gates?: RunEventGate[];
}

/** Efficiency summary for one finished run. */
export interface RunEfficiency {
  /** Wall-clock ms between the first and last event. */
  wall_ms: number;
  /** ms covered by turns, tool calls, or gates (never idle). */
  covered_ms: number;
  /** ms of idle gaps beyond {@link IDLE_GAP_MS}. */
  idle_ms: number;
  /** ms spent in verification gates (loop.gates + verify.gates). */
  gate_ms: number;
  tool_calls: number;
  bookkeeping_calls: number;
  /** 0..1 share of tool calls that were bookkeeping. */
  bookkeeping_share: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Milliseconds of real work this event covers (nothing under it counts as idle). */
function coveredMs(e: RunEvent): number {
  if (e.type === 'turn' || e.type === 'tool.call' || e.type === 'loop.gates') return num(e.ms);
  if (e.type !== 'verify.gates' || !Array.isArray(e.gates)) return 0;
  return e.gates.reduce<number>((sum, gate) => sum + num(recordOf(gate)?.durationMs), 0);
}

/** Summarize a run's efficiency from its raw event list. */
export function efficiency(events: readonly RunEvent[]): RunEfficiency {
  const sorted = [...events].filter((e) => Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  const first = sorted[0];
  const last = sorted.at(-1);
  const wall_ms = first && last ? Math.max(0, last.ts - first.ts) : 0;

  let covered_ms = 0;
  let gate_ms = 0;
  let idle_ms = 0;
  let tool_calls = 0;
  let bookkeeping_calls = 0;
  let prevTs = first?.ts ?? 0;

  for (const e of sorted) {
    const cover = coveredMs(e);
    covered_ms += cover;
    if (e.type === 'tool.call') {
      tool_calls += 1;
      if (typeof e.tool === 'string' && BOOKKEEPING_TOOLS.has(e.tool)) {
        bookkeeping_calls += 1;
      }
    }
    if (e.type === 'loop.gates' || e.type === 'verify.gates') gate_ms += cover;

    const gap = e.ts - prevTs - cover;
    if (gap > IDLE_GAP_MS) idle_ms += gap;
    prevTs = e.ts;
  }

  return {
    wall_ms,
    covered_ms,
    idle_ms,
    gate_ms,
    tool_calls,
    bookkeeping_calls,
    bookkeeping_share: tool_calls > 0 ? bookkeeping_calls / tool_calls : 0,
  };
}
