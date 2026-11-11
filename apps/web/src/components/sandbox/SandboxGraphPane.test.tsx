import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../topology/SwarmCanvas3D', () => ({
  default: ({
    agents,
    onSelectAgent,
  }: {
    agents: Array<{ id: string }>;
    onSelectAgent?: (id: string) => void;
  }) => (
    <div>
      <span>WebGL Topology</span>
      <span>{agents.length} nodes</span>
      <button type="button" onClick={() => onSelectAgent?.(agents[0]?.id ?? '')}>
        select
      </button>
    </div>
  ),
}));

import SandboxGraphPane from './SandboxGraphPane';

describe('SandboxGraphPane', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders WebGL topology with agent and children', () => {
    render(
      <SandboxGraphPane
        agentId="agent-root"
        agentLabel="verifier-07"
        archetype="verifier"
        childIds={['child-a', 'child-b']}
      />,
    );
    expect(screen.getByText('WebGL Topology')).toBeDefined();
    expect(screen.getByText('3 nodes')).toBeDefined();
    expect(screen.getByText(/2 delegates/)).toBeDefined();
  });

  it('shows selected node in footer', async () => {
    render(
      <SandboxGraphPane agentId="agent-root" agentLabel="coder" childIds={['sub-1']} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'select' }));
    expect(screen.getByText(/selected: agent-root/)).toBeDefined();
  });
});
