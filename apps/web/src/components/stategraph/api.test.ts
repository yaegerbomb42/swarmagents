import { describe, it, expect } from 'vitest';
import type { NodeEvent, StateGraphStatus } from '@/components/stategraph/api';

describe('stategraph api types', () => {
  it('NodeEvent has required shape', () => {
    const ev: NodeEvent = {
      node: 'coder',
      event: 'enter',
      step: 1,
      timestamp: 1234567890,
      detail: 'task_1',
      data: { tasks: ['a', 'b'] },
    };
    expect(ev.node).toBe('coder');
    expect(ev.event).toBe('enter');
    expect(ev.step).toBe(1);
    expect(ev.data?.tasks).toHaveLength(2);
  });

  it('StateGraphStatus supports terminal states', () => {
    const s: StateGraphStatus = {
      run_id: 'sg_test',
      goal: 'test goal',
      status: 'complete',
      current_node: 'complete',
      started_at: 0,
      finished_at: 1000,
      current_tasks: ['t1', 't2'],
      active_task_index: 2,
      code_diffs: { t1: 'diff1' },
      verification_logs: 'ok',
      retry_counts: { coder: 0, verifier: 0 },
      logs: ['a', 'b'],
      node_history: [],
    };
    expect(s.status).toBe('complete');
    expect(s.active_task_index).toBe(2);
    expect(s.current_tasks).toHaveLength(2);
  });

  it('node_history events map to graph nodes', () => {
    const history: NodeEvent[] = [
      { node: 'graph', event: 'start', step: 0, timestamp: 0 },
      { node: 'pm', event: 'enter', step: 0, timestamp: 1 },
      { node: 'pm', event: 'exit', step: 0, timestamp: 2, detail: '3 tasks' },
      { node: 'coder', event: 'enter', step: 1, timestamp: 3 },
      { node: 'coder', event: 'exit', step: 1, timestamp: 4 },
      { node: 'verifier', event: 'enter', step: 2, timestamp: 5 },
      { node: 'verifier', event: 'exit', step: 2, timestamp: 6 },
      { node: 'graph', event: 'complete', step: 3, timestamp: 7 },
    ];
    const nodes = new Set(history.map((e) => e.node));
    expect(nodes.has('pm')).toBe(true);
    expect(nodes.has('coder')).toBe(true);
    expect(nodes.has('verifier')).toBe(true);
    expect(nodes.has('graph')).toBe(true);
    const complete = history.find((e) => e.event === 'complete');
    expect(complete).toBeDefined();
    expect(complete?.node).toBe('graph');
  });
});
