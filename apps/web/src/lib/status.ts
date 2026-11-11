/**
 * Canonical status system (design audit §4.2).
 *
 * Every status vocabulary in the app (sandbox, task enum, worker, health,
 * DAG, seats, milestones, header) maps into these 11 canonical states via
 * `toCanonical`, and every indicator reads its label / color / glyph /
 * motion from `statusMeta`. Colors are CSS custom properties defined in the
 * design tokens; fallbacks keep things legible if a token is missing.
 */

export const CANONICAL_STATUSES = [
  'queued',
  'planning',
  'thinking',
  'running',
  'validating',
  'paused',
  'blocked',
  'done',
  'failed',
  'cancelled',
  'offline',
] as const;

export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

export type StatusGlyph =
  | 'ring' // hollow ring
  | 'arc' // ring with rotating arc (planning)
  | 'dot' // filled dot
  | 'dot-dashed' // filled dot + dashed ring (validating)
  | 'bars' // ❙❙ paused
  | 'dot-outline' // filled dot + outline (blocked)
  | 'check' // done
  | 'bang' // failed
  | 'ring-strike'; // cancelled

export type StatusAnimation = 'none' | 'spin' | 'breath' | 'halo';

export interface StatusMeta {
  status: CanonicalStatus;
  label: string;
  /** CSS color expression, e.g. `var(--st-done, #5bd295)` */
  colorVar: string;
  glyph: StatusGlyph;
  animate: StatusAnimation;
}

const META: Record<CanonicalStatus, StatusMeta> = {
  queued: { status: 'queued', label: 'Queued', colorVar: 'var(--fg-3, #8b8b92)', glyph: 'ring', animate: 'none' },
  planning: { status: 'planning', label: 'Planning', colorVar: 'var(--st-thinking, #b199f4)', glyph: 'arc', animate: 'spin' },
  thinking: { status: 'thinking', label: 'Thinking', colorVar: 'var(--st-thinking, #b199f4)', glyph: 'dot', animate: 'breath' },
  running: { status: 'running', label: 'Running', colorVar: 'var(--st-running, #56d9e7)', glyph: 'dot', animate: 'halo' },
  validating: { status: 'validating', label: 'Validating', colorVar: 'var(--st-validating, #7fbef3)', glyph: 'dot-dashed', animate: 'none' },
  paused: { status: 'paused', label: 'Paused', colorVar: 'var(--fg-2, #bdbdc1)', glyph: 'bars', animate: 'none' },
  blocked: { status: 'blocked', label: 'Blocked', colorVar: 'var(--st-blocked, #f6b84d)', glyph: 'dot-outline', animate: 'none' },
  done: { status: 'done', label: 'Done', colorVar: 'var(--st-done, #5bd295)', glyph: 'check', animate: 'none' },
  failed: { status: 'failed', label: 'Failed', colorVar: 'var(--st-failed, #f3625d)', glyph: 'bang', animate: 'none' },
  cancelled: { status: 'cancelled', label: 'Cancelled', colorVar: 'var(--fg-4, #5d5d64)', glyph: 'ring-strike', animate: 'none' },
  offline: { status: 'offline', label: 'Idle', colorVar: 'var(--fg-4, #5d5d64)', glyph: 'ring', animate: 'none' },
};

const ALIASES: Record<string, CanonicalStatus> = {
  // queued
  queued: 'queued',
  pending: 'queued',
  ready: 'queued',
  assigned: 'queued',
  waiting: 'queued',
  scheduled: 'queued',
  // planning
  planning: 'planning',
  decomposing: 'planning',
  // thinking
  thinking: 'thinking',
  think: 'thinking',
  reasoning: 'thinking',
  // running
  running: 'running',
  executing: 'running',
  busy: 'running',
  working: 'running',
  active: 'running',
  in_progress: 'running',
  started: 'running',
  // validating
  validating: 'validating',
  verifying: 'validating',
  reviewing: 'validating',
  // paused
  paused: 'paused',
  cooldown: 'paused',
  suspended: 'paused',
  // blocked
  blocked: 'blocked',
  stalled: 'blocked',
  degraded: 'blocked',
  rate_limited: 'blocked',
  // done
  done: 'done',
  completed: 'done',
  complete: 'done',
  merged: 'done',
  passed: 'done',
  success: 'done',
  succeeded: 'done',
  ok: 'done',
  // failed
  failed: 'failed',
  error: 'failed',
  errored: 'failed',
  missed: 'failed',
  crashed: 'failed',
  unhealthy: 'failed',
  // cancelled
  cancelled: 'cancelled',
  canceled: 'cancelled',
  aborted: 'cancelled',
  killed: 'cancelled',
  // offline / idle
  offline: 'offline',
  idle: 'offline',
  disconnected: 'offline',
  unknown: 'offline',
};

/** Map any raw status string from any vocabulary to a canonical state. */
export function toCanonical(raw: string | null | undefined): CanonicalStatus {
  if (!raw) return 'offline';
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[key] ?? 'offline';
}

export function statusMeta(status: CanonicalStatus | string | null | undefined): StatusMeta {
  const s = (CANONICAL_STATUSES as readonly string[]).includes(String(status))
    ? (status as CanonicalStatus)
    : toCanonical(status as string);
  return META[s];
}

/** True for states that are "in flight" (the only ones allowed to animate). */
export function isActiveStatus(status: CanonicalStatus): boolean {
  return status === 'running' || status === 'thinking' || status === 'planning';
}

/** Terminal states: nothing more will happen without user action. */
export function isTerminalStatus(status: CanonicalStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

export interface StatusEdgeStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  opacity: number;
  /** Whether a flow animation is appropriate (still gated by reduced motion). */
  animated: boolean;
}

/** DAG edge stroke style keyed by the *target* node's canonical status. */
export function statusEdgeStyle(status: CanonicalStatus | string): StatusEdgeStyle {
  const meta = statusMeta(status);
  switch (meta.status) {
    case 'running':
    case 'thinking':
    case 'planning':
      return { stroke: meta.colorVar, strokeWidth: 1.75, strokeDasharray: '6 4', opacity: 0.95, animated: true };
    case 'done':
      return { stroke: meta.colorVar, strokeWidth: 1.5, opacity: 0.8, animated: false };
    case 'failed':
      return { stroke: meta.colorVar, strokeWidth: 1.75, opacity: 0.9, animated: false };
    case 'blocked':
      return { stroke: meta.colorVar, strokeWidth: 1.5, strokeDasharray: '2 3', opacity: 0.9, animated: false };
    case 'validating':
      return { stroke: meta.colorVar, strokeWidth: 1.5, strokeDasharray: '4 3', opacity: 0.85, animated: false };
    case 'cancelled':
      return { stroke: meta.colorVar, strokeWidth: 1, strokeDasharray: '1 4', opacity: 0.6, animated: false };
    default:
      return { stroke: 'var(--fg-4, #5d5d64)', strokeWidth: 1, opacity: 0.7, animated: false };
  }
}
