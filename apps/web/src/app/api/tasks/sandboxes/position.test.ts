import { describe, expect, it } from 'vitest';
import { computeAgentCanvasPosition } from '@/lib/canvasPositions';

describe('computeAgentCanvasPosition', () => {
  it('returns deterministic coordinates within canvas bounds', () => {
    const a = computeAgentCanvasPosition(0, 3, 'running');
    const b = computeAgentCanvasPosition(0, 3, 'running');
    expect(a).toEqual(b);
    expect(a.x).toBeGreaterThan(0);
    expect(a.y).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(800);
    expect(a.y).toBeLessThan(420);
  });

  it('pulls active agents closer to center than idle agents', () => {
    const active = computeAgentCanvasPosition(2, 5, 'running');
    const idle = computeAgentCanvasPosition(2, 5, 'idle');
    const cx = 400;
    const cy = 210;
    const activeDist = Math.hypot(active.x - cx, active.y - cy);
    const idleDist = Math.hypot(idle.x - cx, idle.y - cy);
    expect(activeDist).toBeLessThan(idleDist);
  });
});
