import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HamiltonianViz, { planToHamiltonianGraph } from './HamiltonianViz';

describe('HamiltonianViz', () => {
  it('renders energy landscape canvas', () => {
    const { nodes, edges } = planToHamiltonianGraph(['plan', 'code', 'ship'], 1);
    render(
      <HamiltonianViz nodes={nodes} edges={edges} activeNodeId="code" totalEnergy={3.5} />,
    );
    expect(screen.getByTestId('hamiltonian-viz')).toBeDefined();
    expect(screen.getByText('E=3.50')).toBeDefined();
  });

  it('builds graph from plan actions', () => {
    const { nodes, edges } = planToHamiltonianGraph(['a', 'b', 'c'], 0);
    expect(nodes.length).toBe(3);
    expect(edges.length).toBe(2);
  });
});
