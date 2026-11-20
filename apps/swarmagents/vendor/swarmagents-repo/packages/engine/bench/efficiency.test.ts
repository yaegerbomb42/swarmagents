import { describe, expect, it } from 'vitest';
import {
  BOOKKEEPING_TOOLS,
  efficiency,
  IDLE_GAP_MS,
  type RunEvent,
} from './efficiency.js';

describe('efficiency', () => {
  it('returns zeroed metrics for an empty event list', () => {
    const eff = efficiency([]);
    expect(eff.wall_ms).toBe(0);
    expect(eff.covered_ms).toBe(0);
    expect(eff.idle_ms).toBe(0);
    expect(eff.gate_ms).toBe(0);
    expect(eff.tool_calls).toBe(0);
    expect(eff.bookkeeping_share).toBe(0);
  });

  it('computes gate time from loop.gates ms and verify.gates durationMs', () => {
    const events: RunEvent[] = [
      { type: 'turn', ts: 0, ms: 100 },
      { type: 'loop.gates', ts: 200, ms: 1500 },
      { type: 'verify.gates', ts: 300, gates: [{ durationMs: 500 }, { durationMs: 250 }] },
      { type: 'tool.call', ts: 400, tool: 'read', ms: 20 },
    ];
    const eff = efficiency(events);
    expect(eff.gate_ms).toBe(1500 + 500 + 250);
    expect(eff.tool_calls).toBe(1);
    expect(eff.wall_ms).toBe(400);
  });

  it('counts bookkeeping calls as a share of tool calls', () => {
    const events: RunEvent[] = [
      { type: 'tool.call', ts: 0, tool: 'todo' },
      { type: 'tool.call', ts: 10, tool: 'read' },
      { type: 'tool.call', ts: 20, tool: 'running_context' },
    ];
    const eff = efficiency(events);
    expect(eff.tool_calls).toBe(3);
    expect(eff.bookkeeping_calls).toBe(2);
    expect(eff.bookkeeping_share).toBeCloseTo(2 / 3);
  });

  it('ignores gaps at or below the idle threshold', () => {
    const events: RunEvent[] = [
      { type: 'tool.call', ts: 0, tool: 'read', ms: 10 },
      { type: 'tool.call', ts: IDLE_GAP_MS + 1, tool: 'read', ms: 10 },
      { type: 'tool.call', ts: IDLE_GAP_MS * 2 + 5, tool: 'read', ms: 10 },
    ];
    const eff = efficiency(events);
    expect(eff.idle_ms).toBe(0);
  });

  it('accumulates idle gaps beyond the threshold', () => {
    const events: RunEvent[] = [
      { type: 'tool.call', ts: 0, tool: 'read', ms: 10 },
      { type: 'tool.call', ts: IDLE_GAP_MS + 900, tool: 'read', ms: 10 },
    ];
    const eff = efficiency(events);
    expect(eff.idle_ms).toBe(IDLE_GAP_MS + 900 - 10);
  });

  it('exposes the bookkeeping tool set', () => {
    expect(BOOKKEEPING_TOOLS.has('todo')).toBe(true);
    expect(BOOKKEEPING_TOOLS.has('read')).toBe(false);
  });
});
