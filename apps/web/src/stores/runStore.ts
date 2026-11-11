/**
 * runStore — one store per harness run, fed by useRunStream.
 *
 * The derived state (`RunDerived`) is a mutable accumulator updated by the
 * pure-ish `reduceEvent` (it only mutates the object it's given, no I/O),
 * so 10k+ events stay O(1) per event. Subscribers are notified on a 250 ms
 * dirty tick (same pattern as lib/agentStreamStore.ts) through
 * useSyncExternalStore; each flush produces a new `{version, d}` view.
 */

import { useSyncExternalStore } from 'react';
import { buildUnifiedDiff } from '@/lib/parseDiff';
import {
  normalizeEvent,
  TERMINAL_STATUSES,
  type RunBudgets,
  type RunEvent,
  type RunSnapshot,
} from '@/types/runEvents';

/* ------------------------------------------------------------------ */
/* Ribbon kind codes                                                    */
/* ------------------------------------------------------------------ */

export const K = {
  READ: 0, WRITE: 1, SHELL: 2, VCS: 3, SEARCH: 4, TOOL: 5, REPAIR: 6, FINISH: 7, DECISION: 8,
  // markers (no column of their own)
  CHECKPOINT: 20, COMPACTION: 21, STEER: 22, PAUSE: 23, RESUME: 24, CANCEL: 25, APPROVAL: 26,
} as const;
export const MARKER_MIN = 20;

const TOOL_CATEGORY: Record<string, number> = {
  file_read: K.READ, file_list: K.READ,
  file_write: K.WRITE, file_append: K.WRITE, file_delete: K.WRITE,
  shell_exec: K.SHELL,
  git_status: K.VCS, git_commit: K.VCS,
  web_search: K.SEARCH, web_fetch: K.SEARCH,
  finish: K.FINISH,
};
export function toolKindCode(tool: string): number {
  return TOOL_CATEGORY[tool] ?? K.TOOL;
}

/* ------------------------------------------------------------------ */
/* Typed-array ring                                                     */
/* ------------------------------------------------------------------ */

export class RibbonRing {
  readonly cap: number;
  step: Int32Array; kind: Uint8Array; ok: Int8Array; ms: Float32Array;
  tokens: Float32Array; evIdx: Int32Array; conf: Float32Array;
  /** total ever pushed; index i (0..len-1) maps to (start+i)%cap */
  total = 0;
  constructor(cap = 65536) {
    this.cap = cap;
    this.step = new Int32Array(cap); this.kind = new Uint8Array(cap); this.ok = new Int8Array(cap);
    this.ms = new Float32Array(cap); this.tokens = new Float32Array(cap);
    this.evIdx = new Int32Array(cap); this.conf = new Float32Array(cap);
  }
  get length(): number { return Math.min(this.total, this.cap); }
  private start(): number { return this.total > this.cap ? this.total % this.cap : 0; }
  idx(i: number): number { return (this.start() + i) % this.cap; }
  push(step: number, kind: number, ok: number, ms: number, tokens: number, evIdx: number, conf = -1): number {
    const j = this.total % this.cap;
    this.step[j] = step; this.kind[j] = kind; this.ok[j] = ok; this.ms[j] = ms;
    this.tokens[j] = tokens; this.evIdx[j] = evIdx; this.conf[j] = conf;
    this.total++;
    return j;
  }
}

/* ------------------------------------------------------------------ */
/* Derived state                                                        */
/* ------------------------------------------------------------------ */

export interface FileRevision { step: number; seq: number; patch: string; adds: number; dels: number; op: string; reconstructed: boolean }
export interface FileEntry {
  path: string; edits: number; lastStep: number; lastSeq: number; lastTs: number;
  failed: boolean; failReason?: string; op: string; revisions: FileRevision[];
}
export interface ShellResult {
  step: number; seq: number; command?: string; exit_code?: number | null; ms?: number;
  ok?: boolean; tail: string;
}
export interface Decision { step: number; seq: number; title: string; rationale?: string; confidence?: number }
export interface OpenSpan { span?: string; provider?: string; model?: string; startMs: number; step: number; kind: 'llm' | 'tool'; tool?: string }
export interface SteerNote { id: string; text?: string; receivedSeq: number; appliedSeq?: number; step?: number }
export interface Approval { id: string; tool?: string; params_summary?: string; decision?: string; seq: number; step: number }

export interface RunDerived {
  runId: string;
  status: string;
  detail?: string;
  task?: string;
  step: number;
  stepsDone: number;
  tokensEst: number;
  budgets: RunBudgets;
  startedAt?: number; // epoch ms
  endedAt?: number;
  elapsedS?: number; // from budget.tick
  paused: boolean;
  events: RunEvent[];
  seen: Set<number>;
  lastSeq: number; // highest server seq (−1 when none)
  hasServerSeq: boolean;
  /** token samples for burn: [epochMs, tokens] */
  tokenSamples: Array<[number, number]>;
  usageSeen: boolean;
  llmLatency: number[];
  toolLatency: number[];
  files: Map<string, FileEntry>;
  fileContent: Map<string, string>;
  lastShell?: ShellResult;
  decisions: Decision[];
  confidence: Array<{ step: number; value: number }>;
  openSpan?: OpenSpan;
  provider?: { provider?: string; model?: string; attempts?: number };
  steers: Map<string, SteerNote>;
  approvals: Map<string, Approval>;
  pendingCalls: Map<number, { tool: string; params: Record<string, unknown>; seq: number; confidence?: number }>;
  pendingLlmTokens: number;
  pendingLlmMs: number;
  lastControl?: { kind: string; seq: number };
  ribbon: RibbonRing;
  failures: number;
}

export function createRunDerived(runId: string, ringCap?: number): RunDerived {
  return {
    runId, status: 'unknown', step: 0, stepsDone: 0, tokensEst: 0, budgets: {}, paused: false,
    events: [], seen: new Set(), lastSeq: -1, hasServerSeq: false,
    tokenSamples: [], usageSeen: false, llmLatency: [], toolLatency: [],
    files: new Map(), fileContent: new Map(), decisions: [], confidence: [],
    steers: new Map(), approvals: new Map(), pendingCalls: new Map(),
    pendingLlmTokens: 0, pendingLlmMs: 0, ribbon: new RibbonRing(ringCap), failures: 0,
  };
}

const MAX_LAT = 4000;
const MAX_CONTENT = 256 * 1024;

/** Engine ts may be epoch seconds (python time.time()) or ms. */
export function tsToMs(ts: unknown, fallback: number): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return fallback;
  return ts < 1e12 ? ts * 1000 : ts;
}

function pushCapped(arr: number[], v: number) {
  arr.push(v);
  if (arr.length > MAX_LAT) arr.splice(0, arr.length - MAX_LAT);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function countLines(patch: string): { adds: number; dels: number } {
  let adds = 0, dels = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) adds++;
    else if (line.startsWith('-')) dels++;
  }
  return { adds, dels };
}

function tailOf(result: unknown, lines = 12): string {
  if (result == null) return '';
  let text: string;
  if (typeof result === 'string') text = result;
  else if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const parts = [r.stdout, r.stderr, r.output, r.error].filter((x) => typeof x === 'string' && x) as string[];
    text = parts.length ? parts.join('\n') : JSON.stringify(result);
  } else text = String(result);
  const arr = text.replace(/\s+$/, '').split('\n');
  return arr.slice(-lines).join('\n');
}

function fileEntry(d: RunDerived, path: string): FileEntry {
  let f = d.files.get(path);
  if (!f) {
    f = { path, edits: 0, lastStep: 0, lastSeq: -1, lastTs: 0, failed: false, op: 'write', revisions: [] };
    d.files.set(path, f);
  }
  return f;
}

function addRevision(d: RunDerived, path: string, rev: FileRevision, tsMs: number) {
  const f = fileEntry(d, path);
  // file.diff supersedes a reconstructed revision at the same step
  const last = f.revisions[f.revisions.length - 1];
  if (last && last.step === rev.step && last.reconstructed && !rev.reconstructed) {
    f.revisions[f.revisions.length - 1] = rev;
  } else if (!(last && last.step === rev.step && !last.reconstructed && rev.reconstructed)) {
    f.revisions.push(rev);
    f.edits++;
  }
  if (f.revisions.length > 200) f.revisions.splice(0, f.revisions.length - 200);
  f.lastStep = rev.step; f.lastSeq = rev.seq; f.lastTs = tsMs; f.op = rev.op;
  f.failed = false; f.failReason = undefined;
}

/**
 * Apply one normalized event. Returns false when it was a duplicate.
 * `nowMs` is used when the event carries no ts.
 */
export function reduceEvent(d: RunDerived, ev: RunEvent, nowMs = Date.now()): boolean {
  if (d.seen.has(ev.seq)) return false;
  d.seen.add(ev.seq);
  if (!ev._localSeq) {
    d.hasServerSeq = true;
    if (ev.seq > d.lastSeq) d.lastSeq = ev.seq;
  }
  d.events.push(ev);
  const I = d.events.length - 1;
  const e = ev as Record<string, any>;
  const step = typeof ev.step === 'number' ? ev.step : d.step;
  if (step > d.step) d.step = step;
  const t = tsToMs(ev.ts, nowMs);
  const R = d.ribbon;

  switch (ev.kind) {
    case 'run.state': {
      d.status = String(e.status ?? d.status);
      if (e.detail != null) d.detail = String(e.detail);
      d.paused = d.status === 'paused';
      if (TERMINAL_STATUSES.has(d.status)) { d.openSpan = undefined; d.endedAt ??= t; }
      if (d.status === 'running' && d.startedAt == null) d.startedAt = t;
      break;
    }
    case 'tool_call': {
      const tool = String(e.tool ?? '?');
      const params = (e.params && typeof e.params === 'object' ? e.params : {}) as Record<string, unknown>;
      const conf = typeof e.confidence === 'number' ? e.confidence : undefined;
      d.pendingCalls.set(step, { tool, params, seq: ev.seq, confidence: conf });
      if (conf != null) d.confidence.push({ step, value: conf });
      d.openSpan = { kind: 'tool', tool, startMs: t, step };
      break;
    }
    case 'tool_result': {
      const tool = String(e.tool ?? '?');
      const ok = e.ok !== false && !(typeof e.exit_code === 'number' && e.exit_code !== 0);
      const ms = typeof e.ms === 'number' ? e.ms : 0;
      if (typeof e.ms === 'number') pushCapped(d.toolLatency, e.ms);
      const call = d.pendingCalls.get(step);
      d.pendingCalls.delete(step);
      if (d.openSpan?.kind === 'tool') d.openSpan = undefined;
      if (!ok) d.failures++;
      R.push(step, toolKindCode(tool), ok ? 1 : 0, ms, d.pendingLlmTokens, I, call?.confidence ?? -1);
      d.pendingLlmTokens = 0; d.pendingLlmMs = 0;
      const params = call?.params ?? {};
      const path = str(params.filepath) ?? str(params.path);
      if (path && (tool === 'file_write' || tool === 'file_append' || tool === 'file_delete')) {
        if (!ok) {
          const f = fileEntry(d, path);
          f.failed = true; f.lastStep = step; f.lastSeq = ev.seq; f.lastTs = t;
          f.failReason = tailOf(e.result, 1) || 'failed';
        } else {
          // v2 engines replace params.content with content_sha; then file.diff
          // carries the patch and we only record the touch here.
          const content = str(params.content);
          const known = d.fileContent.has(path);
          const before = d.fileContent.get(path) ?? '';
          let patch = '';
          if (tool === 'file_delete') {
            if (known) patch = buildUnifiedDiff(path, before, '');
            d.fileContent.delete(path);
          } else if (content == null) {
            d.fileContent.delete(path);
          } else {
            const after = tool === 'file_write' ? content : before + content;
            patch = buildUnifiedDiff(path, before, after);
            if (after.length <= MAX_CONTENT) d.fileContent.set(path, after); else d.fileContent.delete(path);
          }
          const { adds, dels } = countLines(patch);
          const op = tool === 'file_write' ? 'write' : tool === 'file_append' ? 'append' : 'delete';
          addRevision(d, path, { step, seq: ev.seq, patch, adds, dels, op, reconstructed: true }, t);
        }
      }
      if (tool === 'shell_exec') {
        d.lastShell = {
          step, seq: ev.seq, command: str(params.command), ms, ok,
          exit_code: typeof e.exit_code === 'number' ? e.exit_code
            : (e.result && typeof e.result === 'object' && typeof e.result.exit_code === 'number' ? e.result.exit_code : undefined),
          tail: tailOf(e.result),
        };
      }
      break;
    }
    case 'error': case 'action.invalid': case 'guard.repeat': case 'action.scaffold': {
      if (ev.kind !== 'action.scaffold') d.failures++;
      R.push(step, K.REPAIR, ev.kind === 'action.scaffold' ? 1 : 0, 0, d.pendingLlmTokens, I);
      d.pendingLlmTokens = 0;
      if (d.openSpan?.kind === 'tool') d.openSpan = undefined;
      break;
    }
    case 'finish': {
      R.push(step, K.FINISH, 1, 0, d.pendingLlmTokens, I);
      d.pendingLlmTokens = 0;
      break;
    }
    case 'decision': {
      const conf = typeof e.confidence === 'number' ? e.confidence : undefined;
      d.decisions.push({ step, seq: ev.seq, title: String(e.title ?? ''), rationale: str(e.rationale), confidence: conf });
      if (conf != null) d.confidence.push({ step, value: conf });
      R.push(step, K.DECISION, 1, 0, 0, I, conf ?? -1);
      break;
    }
    case 'llm.request': {
      d.openSpan = { kind: 'llm', span: str(e.span), provider: str(e.provider), model: str(e.model), startMs: t, step };
      break;
    }
    case 'llm.response': {
      if (d.openSpan?.kind === 'llm' && (!e.span || !d.openSpan.span || d.openSpan.span === e.span)) d.openSpan = undefined;
      if (typeof e.latency_ms === 'number') { pushCapped(d.llmLatency, e.latency_ms); d.pendingLlmMs += e.latency_ms; }
      d.provider = { provider: str(e.provider), model: str(e.model), attempts: typeof e.attempts === 'number' ? e.attempts : undefined };
      const u = e.usage;
      if (u && typeof u === 'object') {
        const tot = typeof u.total === 'number' ? u.total : (Number(u.prompt) || 0) + (Number(u.completion) || 0);
        if (tot > 0) {
          if (!d.usageSeen) d.tokenSamples = []; // real usage replaces estimate deltas
          d.usageSeen = true;
          d.tokenSamples.push([t, tot]);
          d.pendingLlmTokens += tot;
        }
      }
      break;
    }
    case 'control.pause': d.paused = true; d.lastControl = { kind: ev.kind, seq: ev.seq }; R.push(step, K.PAUSE, 1, 0, 0, I); break;
    case 'control.resume': d.paused = false; d.lastControl = { kind: ev.kind, seq: ev.seq }; R.push(step, K.RESUME, 1, 0, 0, I); break;
    case 'control.cancel': case 'control.interrupt':
      d.lastControl = { kind: ev.kind, seq: ev.seq }; R.push(step, K.CANCEL, 1, 0, 0, I);
      if (ev.kind === 'control.interrupt') d.openSpan = undefined;
      break;
    case 'steer.received': {
      const id = String(e.id ?? ev.seq);
      d.steers.set(id, { ...(d.steers.get(id) ?? {}), id, text: str(e.text), receivedSeq: ev.seq, step });
      break;
    }
    case 'steer.applied': {
      const id = String(e.id ?? '');
      const s = d.steers.get(id) ?? { id, receivedSeq: ev.seq };
      s.appliedSeq = ev.seq; s.step = step;
      d.steers.set(id, s);
      R.push(step, K.STEER, 1, 0, 0, I);
      break;
    }
    case 'budget.tick': {
      if (typeof e.steps_done === 'number') d.stepsDone = e.steps_done;
      if (typeof e.elapsed_s === 'number') d.elapsedS = e.elapsed_s;
      if (e.budgets && typeof e.budgets === 'object') d.budgets = { ...d.budgets, ...e.budgets };
      if (typeof e.tokens_est === 'number') setTokensEst(d, e.tokens_est, t);
      break;
    }
    case 'context.compacted': R.push(step, K.COMPACTION, 1, 0, 0, I); break;
    case 'checkpoint.saved': R.push(step, K.CHECKPOINT, 1, 0, 0, I); break;
    case 'file.diff': {
      const path = String(e.path ?? '');
      if (!path) break;
      const patch = str(e.patch) ?? '';
      const counted = countLines(patch);
      addRevision(d, path, {
        step, seq: ev.seq, patch, op: str(e.op) ?? 'write', reconstructed: false,
        adds: typeof e.adds === 'number' ? e.adds : counted.adds,
        dels: typeof e.dels === 'number' ? e.dels : counted.dels,
      }, t);
      break;
    }
    case 'approval.requested': {
      const id = String(e.id ?? ev.seq);
      d.approvals.set(id, { id, tool: str(e.tool), params_summary: str(e.params_summary), seq: ev.seq, step });
      R.push(step, K.APPROVAL, 1, 0, 0, I);
      break;
    }
    case 'approval.resolved': {
      const id = String(e.id ?? '');
      const a = d.approvals.get(id);
      if (a) a.decision = str(e.decision) ?? 'resolved';
      break;
    }
    default: break;
  }
  return true;
}

function setTokensEst(d: RunDerived, tokens: number, tMs: number) {
  const delta = tokens - d.tokensEst;
  if (!d.usageSeen && delta > 0 && d.tokensEst > 0) d.tokenSamples.push([tMs, delta]);
  if (d.tokenSamples.length > 5000) d.tokenSamples.splice(0, d.tokenSamples.length - 5000);
  d.tokensEst = Math.max(d.tokensEst, tokens);
}

export function applySnapshot(d: RunDerived, s: Partial<RunSnapshot>, nowMs = Date.now()): void {
  if (s.status) {
    // The event stream is authoritative once it has spoken about state.
    const streamSpoke = d.events.some((e) => e.kind === 'run.state');
    if (!streamSpoke || TERMINAL_STATUSES.has(String(s.status))) d.status = String(s.status);
    d.paused = d.status === 'paused';
  }
  if (s.detail) d.detail = s.detail;
  if (s.task) d.task = s.task;
  if (typeof s.steps_done === 'number') { d.stepsDone = Math.max(d.stepsDone, s.steps_done); if (s.steps_done > d.step) d.step = s.steps_done; }
  if (typeof s.tokens_est === 'number') setTokensEst(d, s.tokens_est, nowMs);
  if (s.budgets) d.budgets = { ...d.budgets, ...s.budgets };
  if (typeof s.started_at === 'number' && s.started_at > 0) d.startedAt = tsToMs(s.started_at, nowMs);
  if (typeof s.ended_at === 'number' && s.ended_at > 0) d.endedAt = tsToMs(s.ended_at, nowMs);
  for (const fp of s.files_written ?? []) if (!d.files.has(fp)) {
    d.files.set(fp, { path: fp, edits: 0, lastStep: 0, lastSeq: -1, lastTs: 0, failed: false, op: 'write', revisions: [] });
  }
}

/* ------------------------------------------------------------------ */
/* Selectors                                                            */
/* ------------------------------------------------------------------ */

/** tokens/min over the trailing `windowMs` ending at `nowMs`. */
export function burnPerMin(samples: Array<[number, number]>, nowMs: number, windowMs = 60_000): number {
  let sum = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const [t, v] = samples[i];
    if (t < nowMs - windowMs) break;
    if (t <= nowMs) sum += v;
  }
  return (sum * 60_000) / windowMs;
}

/** Burn series: one value per bucket over `buckets` × `bucketMs` ending at nowMs. */
export function burnSeries(samples: Array<[number, number]>, nowMs: number, buckets = 30, bucketMs = 10_000): number[] {
  const out = new Array(buckets).fill(0);
  const start = nowMs - buckets * bucketMs;
  for (const [t, v] of samples) {
    if (t < start || t > nowMs) continue;
    out[Math.min(buckets - 1, Math.floor((t - start) / bucketMs))] += v;
  }
  return out.map((x) => (x * 60_000) / bucketMs);
}

export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/** Rebuild derived state from events[0..uptoIndex] (for scrubbing). */
export function deriveUpTo(runId: string, events: RunEvent[], uptoIndex: number, base?: Partial<RunSnapshot>): RunDerived {
  const d = createRunDerived(runId, 4096);
  if (base) applySnapshot(d, { ...base, status: undefined, steps_done: undefined, tokens_est: undefined, ended_at: undefined, files_written: undefined });
  const n = Math.min(events.length - 1, uptoIndex);
  for (let i = 0; i <= n; i++) reduceEvent(d, events[i], 0);
  return d;
}

/** One-line human summary for an event (tooltips, drawers). Never raw JSON. */
export function summarizeEvent(ev: RunEvent, call?: { tool: string; params: Record<string, unknown> }): string {
  const e = ev as Record<string, any>;
  const at = `#${ev.step ?? '·'}`;
  switch (ev.kind) {
    case 'tool_result': {
      const p = call?.params ?? {};
      const target = str(p.filepath) ?? str(p.path) ?? str(p.command) ?? str(p.query) ?? str(p.url) ?? '';
      const ms = typeof e.ms === 'number' ? ` · ${fmtMs(e.ms)}` : '';
      const exit = typeof e.exit_code === 'number' ? ` · exit ${e.exit_code}` : '';
      return `${at} ${e.tool}${target ? ' ' + clip(target, 60) : ''}${exit}${ms} · ${e.ok === false ? 'failed' : 'ok'}`;
    }
    case 'tool_call': return `${at} → ${e.tool}${e.thought ? ' — ' + clip(String(e.thought), 80) : ''}`;
    case 'error': return `${at} error: ${clip(String(e.error ?? ''), 90)}`;
    case 'action.invalid': return `${at} invalid action: ${clip(String(e.error ?? ''), 80)}`;
    case 'action.scaffold': return `${at} action scaffolded (repair)`;
    case 'guard.repeat': return `${at} repeat guard: ${e.tool ?? ''}`;
    case 'finish': return `${at} finish`;
    case 'decision': return `${at} ◆ ${clip(String(e.title ?? ''), 80)}${typeof e.confidence === 'number' ? ` · conf ${e.confidence.toFixed(2)}` : ''}`;
    case 'checkpoint.saved': return `${at} checkpoint saved`;
    case 'context.compacted': return `${at} context compacted · kept ${e.kept_msgs ?? '—'} · dropped ${e.dropped ?? '—'}`;
    case 'steer.applied': return `${at} steer applied (${e.id})`;
    case 'steer.received': return `${at} steer received: ${clip(String(e.text ?? ''), 70)}`;
    case 'control.pause': case 'control.resume': case 'control.cancel': case 'control.interrupt':
      return `${at} ${ev.kind.slice(8)}${e.at_step != null ? ` @ step ${e.at_step}` : ''}`;
    case 'approval.requested': return `${at} approval requested: ${e.tool ?? ''} ${clip(String(e.params_summary ?? ''), 60)}`;
    case 'approval.resolved': return `${at} approval ${e.decision ?? 'resolved'}`;
    case 'llm.request': return `${at} llm request ${e.model ?? ''}`;
    case 'llm.response': return `${at} llm ${e.model ?? ''} · ${typeof e.latency_ms === 'number' ? fmtMs(e.latency_ms) : '—'} · ${e.usage?.total ?? '—'} tok${e.ok === false ? ' · failed' : ''}`;
    case 'run.state': return `run ${e.status}${e.detail ? ' — ' + clip(String(e.detail), 60) : ''}`;
    case 'file.diff': return `${at} ${e.op ?? 'diff'} ${e.path} +${e.adds ?? 0} −${e.dels ?? 0}`;
    case 'budget.tick': return `${at} budget tick`;
    default: return `${at} ${ev.kind}`;
  }
}

function clip(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
export function fmtMs(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
export function fmtNum(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}
export function fmtDur(s: number | undefined | null): string {
  if (s == null || !Number.isFinite(s) || s < 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Local control state (optimistic → acked by events)                   */
/* ------------------------------------------------------------------ */

export type ControlName = 'pause' | 'resume' | 'cancel' | 'interrupt';
export type ControlPhase = 'idle' | 'sending' | 'sent' | 'acked' | 'error';
export interface ControlState { phase: ControlPhase; sentAfterSeq: number; error?: string; at: number }
export interface LocalSteer { localId: string; text: string; phase: 'sending' | 'sent' | 'received' | 'applied' | 'error'; serverId?: string; error?: string; interrupt?: boolean; at: number }

/* ------------------------------------------------------------------ */
/* Store                                                                */
/* ------------------------------------------------------------------ */

export interface RunView {
  version: number;
  d: RunDerived;
  controls: Partial<Record<ControlName, ControlState>>;
  approvalsLocal: Record<string, { phase: 'sending' | 'sent' | 'error'; decision: string; error?: string }>;
  steersLocal: LocalSteer[];
  conn: ConnState;
  snapshot?: RunSnapshot;
}
export interface ConnState { phase: 'idle' | 'connecting' | 'open' | 'retrying' | 'closed' | 'error'; attempt: number; lastByteAt?: number; error?: string; nextRetryMs?: number }

export class RunStore {
  d: RunDerived;
  private listeners = new Set<() => void>();
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private version = 0;
  private view: RunView;
  private localSeq = 0;
  controls: RunView['controls'] = {};
  approvalsLocal: RunView['approvalsLocal'] = {};
  steersLocal: LocalSteer[] = [];
  conn: ConnState = { phase: 'idle', attempt: 0 };
  snapshot?: RunSnapshot;

  constructor(public readonly runId: string, private readonly tickMs = 250) {
    this.d = createRunDerived(runId);
    this.view = this.makeView();
  }

  private makeView(): RunView {
    return {
      version: this.version, d: this.d, controls: { ...this.controls },
      approvalsLocal: { ...this.approvalsLocal }, steersLocal: [...this.steersLocal],
      conn: { ...this.conn }, snapshot: this.snapshot,
    };
  }

  /** Ingest raw records (REST page or SSE frames). Returns count of new events. */
  ingest(raw: unknown[], opts: { fallbackBase?: number } = {}): number {
    let n = 0;
    raw.forEach((r, i) => {
      // Legacy (seq-less) records get negative synthetic seqs so they can't
      // collide with server seqs. REST pages pass their offset for stability.
      const fb = opts.fallbackBase != null ? -1e9 + opts.fallbackBase + i : -2e9 + this.localSeq++;
      const ev = normalizeEvent(r, fb);
      if (ev && this.ingestEvent(ev, false)) n++;
    });
    if (n) this.markDirty();
    return n;
  }

  ingestEvent(ev: RunEvent, mark = true): boolean {
    const added = reduceEvent(this.d, ev);
    if (!added) return false;
    this.reconcileLocal(ev);
    if (mark) this.markDirty();
    return true;
  }

  private reconcileLocal(ev: RunEvent) {
    const e = ev as Record<string, any>;
    const ack = (name: ControlName) => {
      const c = this.controls[name];
      if (c && (c.phase === 'sent' || c.phase === 'sending')) this.controls[name] = { ...c, phase: 'acked' };
    };
    if (ev.kind === 'control.pause') ack('pause');
    if (ev.kind === 'control.resume') ack('resume');
    if (ev.kind === 'control.cancel') ack('cancel');
    if (ev.kind === 'control.interrupt') ack('interrupt');
    if (ev.kind === 'run.state') {
      if (e.status === 'paused') ack('pause');
      if (e.status === 'running') ack('resume');
      if (e.status === 'cancelled') ack('cancel');
    }
    if (ev.kind === 'steer.received') {
      const s = this.steersLocal.find((x) => (x.serverId && x.serverId === e.id) || (!x.serverId && x.phase === 'sent' && x.text === e.text));
      if (s) { s.serverId = String(e.id); s.phase = 'received'; }
    }
    if (ev.kind === 'steer.applied') {
      const s = this.steersLocal.find((x) => x.serverId === String(e.id));
      if (s) s.phase = 'applied';
      else {
        // legacy engines don't echo steer.received; ack oldest sent note
        const first = this.steersLocal.find((x) => x.phase === 'sent' || x.phase === 'received');
        if (first) { first.phase = 'applied'; first.serverId = String(e.id); }
      }
    }
    if (ev.kind === 'approval.resolved') delete this.approvalsLocal[String(e.id)];
  }

  applySnapshot(s: RunSnapshot) {
    this.snapshot = s;
    applySnapshot(this.d, s);
    if (TERMINAL_STATUSES.has(String(s.status))) {
      for (const k of Object.keys(this.controls) as ControlName[]) {
        const c = this.controls[k];
        if (c?.phase === 'sent' && k === 'cancel' && s.status === 'cancelled') this.controls[k] = { ...c, phase: 'acked' };
      }
    }
    this.markDirty();
  }

  setControl(name: ControlName, c: ControlState) { this.controls[name] = c; this.flushNow(); }
  setConn(c: Partial<ConnState>) { this.conn = { ...this.conn, ...c }; this.markDirty(); }
  upsertSteer(s: LocalSteer) {
    const i = this.steersLocal.findIndex((x) => x.localId === s.localId);
    if (i >= 0) this.steersLocal[i] = s; else this.steersLocal.push(s);
    if (this.steersLocal.length > 50) this.steersLocal.splice(0, this.steersLocal.length - 50);
    this.flushNow();
  }
  setApprovalLocal(id: string, v: RunView['approvalsLocal'][string] | null) {
    if (v) this.approvalsLocal[id] = v; else delete this.approvalsLocal[id];
    this.flushNow();
  }

  markDirty() { this.dirty = true; if (!this.timer && this.listeners.size === 0) { /* flush on subscribe */ } }

  flushNow() {
    this.dirty = false;
    this.version++;
    this.view = this.makeView();
    this.listeners.forEach((l) => { try { l(); } catch { /* noop */ } });
  }

  getView = (): RunView => this.view;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    if (!this.timer) {
      this.timer = setInterval(() => { if (this.dirty) this.flushNow(); }, this.tickMs);
    }
    if (this.dirty) queueMicrotask(() => this.dirty && this.flushNow());
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
    };
  };

  reset() {
    this.d = createRunDerived(this.runId);
    this.localSeq = 0;
    this.flushNow();
  }
}

const stores = new Map<string, RunStore>();
export function getRunStore(runId: string, variant = 'live'): RunStore {
  const key = `${variant}:${runId}`;
  let s = stores.get(key);
  if (!s) { s = new RunStore(runId); stores.set(key, s); }
  return s;
}
export function dropRunStore(runId: string, variant = 'live') { stores.delete(`${variant}:${runId}`); }

export function useRunView(store: RunStore): RunView {
  return useSyncExternalStore(store.subscribe, store.getView, store.getView);
}
