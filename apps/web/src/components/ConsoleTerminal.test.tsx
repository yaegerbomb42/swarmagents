import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConsoleTerminal from './ConsoleTerminal';

describe('ConsoleTerminal', () => {
  it('runs built-in help command', async () => {
    const user = userEvent.setup();
    render(<ConsoleTerminal />);
    const input = screen.getByPlaceholderText('Enter command…');
    await user.type(input, 'help{Enter}');
    expect(screen.getByText(/SwarmAgents console/)).toBeDefined();
  });

  it('merges feedLines after mount', () => {
    const { rerender } = render(
      <ConsoleTerminal feedLines={[{ id: 'a1', kind: 'output', text: 'hello fleet' }]} />,
    );
    expect(screen.getByText('hello fleet')).toBeDefined();
    rerender(
      <ConsoleTerminal
        feedLines={[
          { id: 'a1', kind: 'output', text: 'hello fleet' },
          { id: 'a2', kind: 'system', text: 'telemetry live' },
        ]}
      />,
    );
    expect(screen.getByText('telemetry live')).toBeDefined();
  });

  it('clears output on clear', async () => {
    const user = userEvent.setup();
    render(<ConsoleTerminal />);
    const input = screen.getByPlaceholderText('Enter command…');
    await user.type(input, 'help{Enter}');
    await user.type(input, 'clear{Enter}');
    expect(screen.queryByText(/SwarmAgents console — built-in commands/)).toBeNull();
  });
});
