import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PtyTerminal from './PtyTerminal';

vi.mock('@/components/ConsoleTerminal', () => ({
  default: ({ initialLines }: { initialLines?: Array<{ text: string }> }) => (
    <div data-testid="console-terminal">{initialLines?.[0]?.text}</div>
  ),
}));

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    terminalWsUrl: () => 'ws://localhost:0/terminal',
    missionSnapshot: vi.fn(),
    missionShell: vi.fn(),
  },
}));

describe('PtyTerminal', () => {
  it('renders PTY terminal shell', () => {
    render(<PtyTerminal />);
    expect(screen.getByTestId('pty-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('console-terminal')).toBeInTheDocument();
  });
});
