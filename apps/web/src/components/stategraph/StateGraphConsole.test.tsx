import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import StateGraphConsole from './StateGraphConsole';

vi.mock('@/components/auth/RequireAuth', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ConsoleShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('./api', () => ({
  startStateGraphRun: vi.fn(),
  fetchStateGraphStatus: vi.fn(),
}));

describe('StateGraphConsole', () => {
  it('renders goal input and run button', () => {
    render(<StateGraphConsole />);
    expect(screen.getByPlaceholderText('Project goal…')).toBeDefined();
    expect(screen.getByText('Run async')).toBeDefined();
  });
});
