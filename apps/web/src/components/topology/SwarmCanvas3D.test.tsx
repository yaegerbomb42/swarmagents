import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('three', () => ({
  Scene: class {
    add = vi.fn();
  },
  PerspectiveCamera: class {
    position = { z: 0 };
    aspect = 1;
    updateProjectionMatrix = vi.fn();
  },
  WebGLRenderer: class {
    domElement = document.createElement('canvas');
    setPixelRatio = vi.fn();
    setClearColor = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
  },
  BufferGeometry: class {
    setAttribute = vi.fn();
    getAttribute = vi.fn(() => ({ array: new Float32Array(9), needsUpdate: false }));
    dispose = vi.fn();
  },
  BufferAttribute: class {},
  PointsMaterial: class {
    dispose = vi.fn();
  },
  Points: class {
    rotation = { y: 0 };
  },
  AdditiveBlending: 2,
}));

vi.mock('../swarm/SwarmTopologyVisualizer', () => ({
  default: ({ agents, connected }: { agents: unknown[]; connected?: boolean }) => (
    <div data-testid="topology-mock">
      {agents.length} agents · {connected ? 'live' : 'off'}
    </div>
  ),
}));

import SwarmCanvas3D from './SwarmCanvas3D';

const AGENTS = [
  {
    id: 'a1',
    roleId: 'architect',
    parentId: null,
    status: 'running' as const,
    label: 'Root',
    activity: 'working' as const,
    live: true,
  },
];

describe('SwarmCanvas3D', () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders particle field and topology layer', () => {
    render(<SwarmCanvas3D agents={AGENTS} connected />);
    expect(screen.getByTestId('swarm-canvas-3d')).toBeInTheDocument();
    expect(screen.getByTestId('swarm-particle-field')).toBeInTheDocument();
    expect(screen.getByTestId('topology-mock')).toHaveTextContent('1 agents · live');
    expect(screen.getByTestId('swarm-canvas-hud')).toHaveTextContent('1 nodes');
  });

  it('shows selected agent in HUD', () => {
    render(<SwarmCanvas3D agents={AGENTS} connected selectedAgentId="a1" />);
    expect(screen.getByTestId('swarm-canvas-hud')).toHaveTextContent('Root');
    expect(screen.getByTestId('swarm-canvas-hud')).toHaveTextContent('working');
  });
});
