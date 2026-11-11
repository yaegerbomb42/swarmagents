import { describe, expect, it, vi } from 'vitest';
import {
  applySnapshot, burnPerMin, burnSeries, createRunDerived, deriveUpTo, K, percentile,
  reduceEvent, RibbonRing, RunStore, summarizeEvent,
} from './runStore';
import { normalizeEvent, type RunEvent } from '@/types/runEvents';

const T0 = 1_790_000_000; // epoch seconds, like python time.time()
let seq = 0;
function ev(kind: string, extra: Record<string, unknown> = {}): RunEvent {
  seq += 1;
  return normalizeEvent({ v: 2, seq, ts: T0 + seq, run_id: 'run-abc', step: 1, kind, ...extra }, -1)!;
}

describe('normalizeEvent', () => {
  it('keeps v2 seq, synthesizes for legacy, maps legacy state kind and status strings', () => {
    expect(normalizeEvent({ kind: 'tool_call', seq: 5 }, -9)!.seq).toBe(5);
    const legacy = normalizeEvent({ kind: 'tool_call', tool: 'x' }, -9)!;
    expect(legacy.seq).toBe(-9);
    expect(legacy._localSeq).toBe(true);
    expect(normalizeEvent({ kind: 'state', status: 'running' }, 1)!.kind).toBe('run.state');
    expect(normalizeEvent('finished', 2)).toMatchObject({ kind: 'run.state', status: 'finished' });
    expect(normalizeEvent(null, 1)).toBeNull();
  });

  it('never trusts seq on synthetic frames', () => {
    const e = normalizeEvent({ kind: 'run.state', status: 'running', seq: 7, synthetic: true }, -3)!;
    expect(e.seq).toBe(-3);
    expect(e._localSeq).toBe(true);
  });

  it('preserves unknown kinds verbatim', () => {
    const e = normalizeEvent({ kind: 'weird.thing', seq: 1, foo: 1 }, 0) as Record<string, unknown>;
    expect(e.kind).toBe('weird.thing');
    expect(e.foo).toBe(1);
  });
});

describe('reduceEvent', () => {
  it('dedupes by seq and tracks lastSeq only from server seqs', () => {
    const d = createRunDerived('run-abc');
    const e = ev('checkpoint.saved');
    expect(reduceEvent(d, e)).toBe(true);
    expect(reduceEvent(d, e)).toBe(false);
    expect(d.events).toHaveLength(1);
    expect(d.lastSeq).toBe(e.seq);
    const synth = normalizeEvent({ kind: 'run.state', status: 'finished', seq: e.seq, synthetic: true }, -2e9)!;
    expect(reduceEvent(d, synth)).toBe(true);
    expect(d.status).toBe('finished');
    expect(d.lastSeq).toBe(e.seq);
  });

  it('tracks status, pause, open llm span and provider', () => {
    const d = createRunDerived('r');
    reduceEvent(d, ev('run.state', { status: 'running' }));
    expect(d.status).toBe('running');
    reduceEvent(d, ev('llm.request', { span: 's1', model: 'm1' }));
    expect(d.openSpan).toMatchObject({ kind: 'llm', model: 'm1' });
    reduceEvent(d, ev('llm.response', { span: 's1', latency_ms: 2000, usage: { prompt: 10, completion: 5, total: 15 }, provider: 'p', model: 'm2', attempts: 2, ok: true }));
    expect(d.openSpan).toBeUndefined();
    expect(d.provider).toEqual({ provider: 'p', model: 'm2', attempts: 2 });
    expect(d.llmLatency).toEqual([2000]);
    expect(d.usageSeen).toBe(true);
    reduceEvent(d, ev('control.pause', { at_step: 1 }));
    expect(d.paused).toBe(true);
    reduceEvent(d, ev('control.resume', { at_step: 1 }));
    expect(d.paused).toBe(false);
    reduceEvent(d, ev('run.state', { status: 'finished' }));
    expect(d.endedAt).toBeDefined();
  });

  it('builds ribbon columns with tokens from preceding llm usage and honest ok', () => {
    const d = createRunDerived('r');
    reduceEvent(d, ev('llm.response', { usage: { total: 100 }, latency_ms: 10 }));
    reduceEvent(d, ev('tool_call', { step: 3, tool: 'shell_exec', params: { command: 'pytest' }, confidence: 0.7 }));
    reduceEvent(d, ev('tool_result', { step: 3, tool: 'shell_exec', ok: true, exit_code: 1, ms: 2800, result: { stdout: 'a\nb\nE fail' } }));
    const R = d.ribbon;
    expect(R.length).toBe(1);
    const j = R.idx(0);
    expect(R.kind[j]).toBe(K.SHELL);
    expect(R.ok[j]).toBe(0); // exit_code != 0 overrides ok:true
    expect(R.tokens[j]).toBe(100);
    expect(R.conf[j]).toBeCloseTo(0.7);
    expect(d.lastShell).toMatchObject({ command: 'pytest', exit_code: 1, ok: false, step: 3 });
    expect(d.lastShell!.tail).toContain('E fail');
    expect(d.failures).toBe(1);
    expect(d.confidence).toEqual([{ step: 3, value: 0.7 }]);
    expect(d.toolLatency).toEqual([2800]);
  });

  it('reconstructs diffs from params, then lets file.diff supersede them', () => {
    const d = createRunDerived('r');
    reduceEvent(d, ev('tool_call', { step: 1, tool: 'file_write', params: { filepath: 'a.ts', content: 'x\n' } }));
    reduceEvent(d, ev('tool_result', { step: 1, tool: 'file_write', ok: true, ms: 3 }));
    let f = d.files.get('a.ts')!;
    expect(f.edits).toBe(1);
    expect(f.revisions[0].reconstructed).toBe(true);
    expect(f.revisions[0].adds).toBe(1);
    reduceEvent(d, ev('file.diff', { step: 1, path: 'a.ts', op: 'write', adds: 4, dels: 0, patch: '--- a\n+++ b\n+x' }));
    f = d.files.get('a.ts')!;
    expect(f.revisions).toHaveLength(1);
    expect(f.revisions[0]).toMatchObject({ reconstructed: false, adds: 4 });
    // v2: content hashed away → touch recorded, no fake patch
    reduceEvent(d, ev('tool_call', { step: 2, tool: 'file_append', params: { filepath: 'a.ts', content_sha: 'abc' } }));
    reduceEvent(d, ev('tool_result', { step: 2, tool: 'file_append', ok: true }));
    expect(d.files.get('a.ts')!.revisions[1].patch).toBe('');
  });

  it('marks failed writes', () => {
    const d = createRunDerived('r');
    reduceEvent(d, ev('tool_call', { step: 4, tool: 'file_write', params: { filepath: 'README.md', content: 'x' } }));
    reduceEvent(d, ev('tool_result', { step: 4, tool: 'file_write', ok: false, result: 'error: denied' }));
    expect(d.files.get('README.md')).toMatchObject({ failed: true, failReason: 'error: denied' });
  });

  it('tracks decisions, steers, approvals and markers', () => {
    const d = createRunDerived('r');
    reduceEvent(d, ev('decision', { step: 2, title: 'JWT in middleware', confidence: 0.78 }));
    reduceEvent(d, ev('steer.received', { id: 's1', text: 'use tests' }));
    reduceEvent(d, ev('steer.applied', { id: 's1' }));
    reduceEvent(d, ev('approval.requested', { id: 'a1', tool: 'shell_exec', params_summary: 'rm -rf x' }));
    reduceEvent(d, ev('checkpoint.saved'));
    reduceEvent(d, ev('context.compacted', { kept_msgs: 4, dropped: 8 }));
    expect(d.decisions[0]).toMatchObject({ title: 'JWT in middleware', confidence: 0.78 });
    expect(d.steers.get('s1')!.appliedSeq).toBeDefined();
    expect(d.approvals.get('a1')!.decision).toBeUndefined();
    reduceEvent(d, ev('approval.resolved', { id: 'a1', decision: 'reject' }));
    expect(d.approvals.get('a1')!.decision).toBe('reject');
    const kinds = Array.from({ length: d.ribbon.length }, (_, i) => d.ribbon.kind[d.ribbon.idx(i)]);
    expect(kinds).toEqual([K.DECISION, K.STEER, K.APPROVAL, K.CHECKPOINT, K.COMPACTION]);
  });

  it('uses tokens_est deltas for burn until real usage arrives', () => {
    const d = createRunDerived('r');
    applySnapshot(d, { tokens_est: 1000 }, 0);
    reduceEvent(d, ev('budget.tick', { tokens_est: 1600, steps_done: 3, elapsed_s: 10, budgets: { max_steps: 50 } }));
    expect(d.tokenSamples.map((s) => s[1])).toEqual([600]);
    expect(d.budgets.max_steps).toBe(50);
    expect(d.stepsDone).toBe(3);
    reduceEvent(d, ev('llm.response', { usage: { total: 50 } }));
    expect(d.tokenSamples.map((s) => s[1])).toEqual([50]);
  });
});

describe('selectors', () => {
  it('burnPerMin sums the trailing window', () => {
    const s: Array<[number, number]> = [[0, 100], [30_000, 200], [59_000, 300], [120_000, 50]];
    expect(burnPerMin(s, 60_000)).toBe(600);
    expect(burnPerMin(s, 120_000)).toBe(50);
    expect(burnSeries(s, 60_000, 6, 10_000).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('percentile p50/p95', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile([], 50)).toBeUndefined();
  });

  it('deriveUpTo replays a prefix', () => {
    const d = createRunDerived('r');
    const evs = [ev('run.state', { status: 'running' }), ev('decision', { title: 'a' }), ev('decision', { title: 'b' })];
    evs.forEach((e) => reduceEvent(d, e));
    const p = deriveUpTo('r', d.events, 1);
    expect(p.decisions.map((x) => x.title)).toEqual(['a']);
    expect(p.status).toBe('running');
  });

  it('summaries are one line and never JSON', () => {
    const call = { tool: 'file_write', params: { filepath: 'src/api/auth.ts' } };
    const s = summarizeEvent(ev('tool_result', { step: 131, tool: 'file_write', ok: true, ms: 42 }), call);
    expect(s).toBe('#131 file_write src/api/auth.ts · 42ms · ok');
    expect(summarizeEvent(ev('mystery', { step: 2, blob: { a: 1 } }))).toBe('#2 mystery');
  });
});

describe('RibbonRing', () => {
  it('wraps at capacity and keeps order', () => {
    const r = new RibbonRing(4);
    for (let i = 0; i < 6; i++) r.push(i, 0, 1, 0, 0, i);
    expect(r.length).toBe(4);
    expect(Array.from({ length: 4 }, (_, i) => r.step[r.idx(i)])).toEqual([2, 3, 4, 5]);
  });

  it('handles 10k steps quickly', () => {
    const d = createRunDerived('r');
    const t = performance.now();
    for (let i = 1; i <= 10_000; i++) {
      reduceEvent(d, { kind: 'tool_call', seq: i * 2, step: i, tool: 'file_read', params: { filepath: 'x' } } as RunEvent);
      reduceEvent(d, { kind: 'tool_result', seq: i * 2 + 1, step: i, tool: 'file_read', ok: true, ms: 5 } as RunEvent);
    }
    expect(d.ribbon.length).toBe(10_000);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('RunStore', () => {
  it('batches notifications and acks controls/steers from events', () => {
    vi.useFakeTimers();
    try {
      const s = new RunStore('run-x', 250);
      const l = vi.fn();
      const unsub = s.subscribe(l);
      s.ingest([{ v: 2, seq: 1, kind: 'run.state', status: 'running' }, { v: 2, seq: 2, kind: 'checkpoint.saved' }]);
      expect(l).not.toHaveBeenCalled();
      vi.advanceTimersByTime(260);
      expect(l).toHaveBeenCalledTimes(1);
      expect(s.getView().d.events).toHaveLength(2);

      s.setControl('pause', { phase: 'sent', sentAfterSeq: 2, at: 0 });
      s.upsertSteer({ localId: 'l1', text: 'go left', phase: 'sent', serverId: 'st-1', at: 0 });
      s.ingest([{ v: 2, seq: 3, kind: 'control.pause', at_step: 1 }, { v: 2, seq: 4, kind: 'steer.received', id: 'st-1', text: 'go left' }, { v: 2, seq: 5, kind: 'steer.applied', id: 'st-1' }]);
      vi.advanceTimersByTime(260);
      const v = s.getView();
      expect(v.controls.pause!.phase).toBe('acked');
      expect(v.steersLocal[0].phase).toBe('applied');
      // duplicates (e.g. SSE backlog overlapping REST) are ignored
      expect(s.ingest([{ v: 2, seq: 3, kind: 'control.pause' }])).toBe(0);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });
});
