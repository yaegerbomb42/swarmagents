import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SwarmGrid from './SwarmGrid';
import type { GridAgent } from './swarmGridTypes';

const AGENTS: GridAgent[] = [
  {
    id: 'a1',
    name: 'Architect-1',
    roleId: 'orchestrator',
    model: 'claude-opus-5-5',
    status: 'working',
    turnCounter: 12,
    taskBrief: 'Design the schema',
    toolWhitelist: ['shell', 'search'],
  },
  {
    id: 'a2',
    name: 'Researcher-1',
    roleId: 'researcher',
    model: 'claude-sonnet-5-5',
    status: 'idle',
    turnCounter: 3,
  },
];

describe('SwarmGrid', () => {
  it('renders one card per agent with role badge, model, status, and turns', () => {
    render(<SwarmGrid agents={AGENTS} />);
    expect(screen.getByText('Architect-1')).toBeInTheDocument();
    expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-5-5')).toBeInTheDocument();
    expect(screen.getByText('working')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Researcher-1')).toBeInTheDocument();
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows an empty state when no agents are provided', () => {
    render(<SwarmGrid agents={[]} />);
    expect(screen.getByText('No active swarm agents.')).toBeInTheDocument();
  });

  it('fires onSelect and previews task brief + tool whitelist on click', () => {
    const onSelect = vi.fn();
    render(<SwarmGrid agents={AGENTS} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Architect-1'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: 'a1' });
    expect(screen.getByText('Design the schema')).toBeInTheDocument();
    expect(screen.getByText('shell')).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
  });

  it('can dismiss the inspector', () => {
    render(<SwarmGrid agents={AGENTS} />);
    fireEvent.click(screen.getByText('Architect-1'));
    expect(screen.getByText('Design the schema')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close inspector'));
    expect(screen.queryByText('Design the schema')).not.toBeInTheDocument();
  });
});
