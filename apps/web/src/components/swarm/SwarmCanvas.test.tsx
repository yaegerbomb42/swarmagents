import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    groupchatMessages: vi.fn().mockResolvedValue({
      messages: [],
      has_more: false,
      oldest_id: null,
      newest_id: null,
      next_before_id: null,
      count: 0,
    }),
  },
}));

vi.mock('@/hooks/useAgentTelemetry', () => ({
  useAgentTelemetry: vi.fn(() => ({
    sandboxes: [
      {
        id: 'sbx-1',
        agentId: 'worker-a',
        nodeId: 'n1',
        label: 'Worker A',
        mode: 'shell',
        status: 'running',
        tools: [],
        logs: [],
        toolCallCount: 0,
        position: { x: 400, y: 210 },
      },
    ],
    connected: true,
    latencyMs: 12,
    error: null,
    updateSandbox: vi.fn(),
  })),
}));

import SwarmCanvas from './SwarmCanvas';

describe('SwarmCanvas', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('WebSocket', undefined);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      setTransform: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('smoke: mounts canvas HUD with groupchat + telemetry live state', () => {
    render(<SwarmCanvas sessionId="sess-1" />);
    expect(screen.getByTestId('swarm-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('swarm-canvas-hud')).toHaveTextContent('live');
  });

  it('accepts sessionId for telemetry-driven positions', () => {
    render(<SwarmCanvas sessionId="sess-abc" className="h-64" />);
    expect(screen.getByLabelText('Swarm agent position canvas')).toBeInTheDocument();
  });
});
