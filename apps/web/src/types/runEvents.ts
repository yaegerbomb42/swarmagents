/**
 * Shared harness run types — the event contract for `/v1/runs/{id}/events`.
 *
 * v2 envelope: `{v:2, seq, ts, run_id, step, kind, ...payload}`.
 * Legacy v1 records (no `v`/`seq`) are tolerated: the store assigns a
 * synthetic negative local seq (arrival order).
 * Unknown kinds are preserved as `GenericRunEvent` so nothing is dropped.
 */

export type RunStatus =
  | 'queued' | 'running' | 'paused' | 'finished'
  | 'step_budget' | 'time_budget' | 'token_budget' | 'step_limit'
  | 'stalled' | 'error' | 'cancelled' | 'interrupted' | 'unavailable';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'finished', 'step_budget', 'time_budget', 'token_budget', 'stalled',
  'error', 'cancelled', 'interrupted', 'unavailable',
]);

export interface RunBudgets {
  max_steps?: number | null;
  max_wallclock_s?: number | null;
  max_tokens?: number | null;
}

export interface RunSnapshot {
  ok?: boolean;
  run_id: string;
  status: RunStatus | string;
  task?: string;
  workspace?: string;
  steps_done?: number;
  tokens_est?: number;
  budgets?: RunBudgets;
  started_at?: number;
  ended_at?: number;
  detail?: string;
  files_written?: string[];
  summary?: string;
  events_url?: string;
  stream_url?: string;
}

export interface StartRunInput {
  task: string;
  workspace: string;
  requirements?: string[];
  acceptance?: string[];
  max_steps?: number;
  max_wallclock_s?: number;
  max_tokens?: number;
  invocation_steps?: number;
  llm_endpoint?: string;
  llm_api_key?: string;
  llm_model?: string;
  llm_type?: string;
}

export interface EventsPage {
  ok: boolean;
  run_id: string;
  status: string;
  events: unknown[];
}

/* ------------------------------------------------------------------ */
/* Envelope + payloads                                                  */
/* ------------------------------------------------------------------ */

export interface Envelope {
  v?: number;
  /** Monotonic per-run sequence. Absent on legacy v1 records. */
  seq: number;
  ts?: number;
  run_id?: string;
  step?: number;
  /** True when seq was synthesized client-side (legacy record). */
  _localSeq?: boolean;
}

type E<K extends string, P> = Envelope & { kind: K } & P;

export type ToolCallEvent = E<'tool_call', {
  tool: string; params?: Record<string, unknown>; thought?: string;
  confidence?: number; intent?: string;
}>;
export type ToolResultEvent = E<'tool_result', {
  tool: string; ok?: boolean; ms?: number; exit_code?: number | null; result?: unknown;
}>;
export type ErrorEvent = E<'error', { error: string }>;
export type FinishEvent = E<'finish', { params?: Record<string, unknown> }>;
export type RunStateEvent = E<'run.state', { status: string; detail?: string }>;
export type LlmRequestEvent = E<'llm.request', {
  span?: string; provider?: string; model?: string; prompt_tokens_est?: number;
}>;
export type LlmUsage = { prompt?: number; completion?: number; total?: number };
export type LlmResponseEvent = E<'llm.response', {
  span?: string; latency_ms?: number; usage?: LlmUsage | null; provider?: string;
  model?: string; attempts?: number; ok?: boolean; error?: string;
}>;
export type ControlKind = 'control.pause' | 'control.resume' | 'control.cancel' | 'control.interrupt';
export type ControlEvent = E<ControlKind, { at_step?: number }>;
export type SteerReceivedEvent = E<'steer.received', { id: string; text?: string }>;
export type SteerAppliedEvent = E<'steer.applied', { id: string }>;
export type BudgetTickEvent = E<'budget.tick', {
  steps_done?: number; tokens_est?: number; elapsed_s?: number; budgets?: RunBudgets;
}>;
export type GuardRepeatEvent = E<'guard.repeat', { tool?: string }>;
export type ActionInvalidEvent = E<'action.invalid', { error?: string }>;
export type ActionScaffoldEvent = E<'action.scaffold', { tool?: string }>;
export type ContextCompactedEvent = E<'context.compacted', {
  kept_msgs?: number; dropped?: number; prompt_tokens_est?: number;
}>;
export type CheckpointSavedEvent = E<'checkpoint.saved', Record<string, never>>;
export type FileDiffEvent = E<'file.diff', {
  path: string; op?: string; adds?: number; dels?: number;
  before_sha?: string; after_sha?: string; patch?: string; truncated?: boolean;
}>;
export type DecisionEvent = E<'decision', { title: string; rationale?: string; confidence?: number }>;
export type ApprovalRequestedEvent = E<'approval.requested', {
  id: string; tool?: string; params_summary?: string;
}>;
export type ApprovalResolvedEvent = E<'approval.resolved', { id: string; decision?: string }>;

/** Any kind we don't model. Payload is kept verbatim. */
export type GenericRunEvent = Envelope & { kind: string; [k: string]: unknown };

export type KnownRunEvent =
  | ToolCallEvent | ToolResultEvent | ErrorEvent | FinishEvent | RunStateEvent
  | LlmRequestEvent | LlmResponseEvent | ControlEvent | SteerReceivedEvent | SteerAppliedEvent
  | BudgetTickEvent | GuardRepeatEvent | ActionInvalidEvent | ActionScaffoldEvent
  | ContextCompactedEvent | CheckpointSavedEvent | FileDiffEvent | DecisionEvent
  | ApprovalRequestedEvent | ApprovalResolvedEvent;

export type RunEvent = KnownRunEvent | GenericRunEvent;

export const KNOWN_KINDS = [
  'tool_call', 'tool_result', 'error', 'finish', 'run.state', 'llm.request', 'llm.response',
  'control.pause', 'control.resume', 'control.cancel', 'control.interrupt',
  'steer.received', 'steer.applied', 'budget.tick', 'guard.repeat', 'action.invalid',
  'action.scaffold', 'context.compacted', 'checkpoint.saved', 'file.diff', 'decision',
  'approval.requested', 'approval.resolved',
] as const;

export type KnownKind = (typeof KNOWN_KINDS)[number];

export function isKind<K extends KnownKind>(
  ev: RunEvent, kind: K,
): ev is Extract<KnownRunEvent, { kind: K }> {
  return ev.kind === kind;
}

/**
 * Normalize an arbitrary JSON record into a RunEvent. Returns null for
 * non-objects. `fallbackSeq` is used for legacy records without `seq`.
 * Legacy `event: status` frames (`data: running`) map to `run.state`.
 */
export function normalizeEvent(raw: unknown, fallbackSeq: number): RunEvent | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    return { kind: 'run.state', status: s, seq: fallbackSeq, _localSeq: true } as RunStateEvent;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === 'string' ? r.kind : typeof r.type === 'string' ? r.type : 'unknown';
  // Synthetic frames (engine SSE connect/close run.state) repeat the last real
  // seq: never dedupe them against it nor advance the resume cursor.
  const hasSeq = r.synthetic !== true && typeof r.seq === 'number' && Number.isFinite(r.seq);
  const ev: Record<string, unknown> = { ...r, kind, seq: hasSeq ? r.seq : fallbackSeq };
  if (!hasSeq) ev._localSeq = true;
  // legacy engine emitted kind "state"
  if (kind === 'state') ev.kind = 'run.state';
  return ev as RunEvent;
}
