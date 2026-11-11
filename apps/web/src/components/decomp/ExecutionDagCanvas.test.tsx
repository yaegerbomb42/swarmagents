import { describe, it, expect } from 'vitest';
import { buildDemoDagNodes } from './demoNodes';

describe('buildDemoDagNodes', () => {
  it('returns a connected multi-status preview graph', () => {
    const nodes = buildDemoDagNodes('Demo mission');
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(nodes.some((n) => n.status === 'executing')).toBe(true);
    expect(nodes.some((n) => n.status === 'completed')).toBe(true);
    expect(nodes.some((n) => n.status === 'failed')).toBe(true);
    expect(nodes.some((n) => n.status === 'pending' || n.status === 'ready')).toBe(true);
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      if (n.parent_id) expect(ids.has(n.parent_id)).toBe(true);
    }
  });

  it('puts the mission text on the root description', () => {
    const nodes = buildDemoDagNodes('Custom goal text');
    const root = nodes.find((n) => !n.parent_id);
    expect(root?.description).toContain('Custom goal text');
  });
});
