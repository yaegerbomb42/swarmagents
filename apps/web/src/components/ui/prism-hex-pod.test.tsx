import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrismHexPod, {
  hashSeed,
  hudTelemetry,
  prismSheen,
  tiltFromPointer,
} from './prism-hex-pod';

describe('PrismHexPod pure simulation', () => {
  it('hashSeed is deterministic and bounded [0,1)', () => {
    expect(hashSeed('a')).toBe(hashSeed('a'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
    const v = hashSeed('swarmagents.prism.v1');
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('hudTelemetry is deterministic and keeps bounded ranges', () => {
    const a = hudTelemetry(12.5, 0.42);
    const b = hudTelemetry(12.5, 0.42);
    expect(a).toEqual(b); // pure: same (t, seed) => same metrics
    expect(a.signal).toBeGreaterThanOrEqual(0.4);
    expect(a.signal).toBeLessThanOrEqual(1);
    expect(a.load).toBeGreaterThanOrEqual(0.25);
    expect(a.load).toBeLessThanOrEqual(0.95);
    expect(a.temp).toBeGreaterThanOrEqual(38);
    expect(a.temp).toBeLessThanOrEqual(56);
  });

  it('prismSheen loops within [0,1)', () => {
    expect(prismSheen(0)).toBe(0);
    expect(prismSheen(14, 7)).toBe(0); // wraps at period
    const v = prismSheen(3.5);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('tiltFromPointer clamps and centers at zero', () => {
    expect(tiltFromPointer(50, 50, 100, 100)).toEqual({ rx: 0, ry: 0 });
    const tl = tiltFromPointer(0, 0, 100, 100);
    expect(tl.ry).toBeLessThanOrEqual(0);
    expect(Math.abs(tl.ry)).toBeLessThanOrEqual(10);
    // degenerate size returns zero tilt
    expect(tiltFromPointer(0, 0, 0, 0)).toEqual({ rx: 0, ry: 0 });
  });
});

describe('<PrismHexPod />', () => {
  it('renders region, pod, brackets and label', () => {
    render(<PrismHexPod label="SWARM FRONT" />);
    const pod = screen.getByTestId('prism-hex-pod');
    expect(pod.getAttribute('role')).toBe('region');
    expect(pod.getAttribute('aria-label')).toContain('SWARM FRONT');
    expect(screen.getByTestId('prism-hex-pod-pod')).toBeDefined();
    expect(screen.getAllByTestId('prism-hex-pod-bracket')).toHaveLength(4);
  });

  it('renders three bounded telemetry rows plus thermal', () => {
    render(<PrismHexPod />);
    const rows = screen.getAllByTestId('prism-hex-pod-row');
    expect(rows).toHaveLength(3);
    const bars = screen.getAllByTestId('prism-hex-pod-bar');
    expect(bars).toHaveLength(3);
    expect(screen.getByText('THERMAL')).toBeDefined();
  });

  it('renders deterministic initial metrics text', () => {
    render(<PrismHexPod seed="test-seed" />);
    // signal val is a number like "X"; ensure a readout exists
    expect(screen.getAllByText(/\d{2,3}/).length).toBeGreaterThan(0);
  });
});