import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import LiveLogStreamTerminal from './LiveLogStreamTerminal';
// Mock framer-motion to avoid animation issues in test environment
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.ComponentPropsWithoutRef<'div'>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock useSwarmTelemetry
vi.mock('@/hooks/useSwarmTelemetry', () => ({
  useSwarmTelemetry: () => ({
    workers: [],
    journal: ['swarm idle · 0 agents · 0 active / 0 queued'],
    phase: 'idle',
    engineReachable: false,
    lastUpdate: Date.now(),
    counts: {
      agents: 0, activeTasks: 0, queuedTasks: 0, completedTasks: 0,
      totalTokens: null, avgLatencyMs: null, throughput: null, health: null,
    },
  }),
}));

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  close() {}
  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  simulateOpen() {
    this.onopen?.();
  }
  simulateError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  // jsdom doesn't implement scrollIntoView
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LiveLogStreamTerminal', () => {
  it('renders the terminal section with correct test id', () => {
    render(<LiveLogStreamTerminal />);
    expect(screen.getByTestId('live-log-stream-terminal')).toBeInTheDocument();
  });

  it('shows "STREAM" status initially (not live)', () => {
    render(<LiveLogStreamTerminal />);
    expect(screen.getByText('STREAM')).toBeInTheDocument();
  });

  it('shows "LIVE" after EventSource opens', async () => {
    render(<LiveLogStreamTerminal />);
    await act(async () => {
      MockEventSource.instances[0]?.simulateOpen();
    });
    await waitFor(() => {
      expect(screen.getByText('LIVE')).toBeInTheDocument();
    });
  });

  it('renders incoming log messages', async () => {
    render(<LiveLogStreamTerminal />);
    await act(async () => {
      MockEventSource.instances[0]?.simulateOpen();
      MockEventSource.instances[0]?.simulateMessage({
        kind: 'system', message: 'Agent started', ts: Date.now(),
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Agent started')).toBeInTheDocument();
    });
  });

  it('shows error badge when log kind is error', async () => {
    render(<LiveLogStreamTerminal />);
    await act(async () => {
      MockEventSource.instances[0]?.simulateOpen();
      MockEventSource.instances[0]?.simulateMessage({
        kind: 'error', message: 'Tool failed', ts: Date.now(),
      });
    });
    await waitFor(() => {
      expect(screen.getByText('1 err')).toBeInTheDocument();
    });
  });

  it('shows filter bar when filter button is clicked', async () => {
    render(<LiveLogStreamTerminal />);
    const filterBtn = screen.getByRole('button', { name: /toggle filter/i });
    fireEvent.click(filterBtn);
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: /search log messages/i })).toBeInTheDocument();
    });
  });

  it('filters lines by kind', async () => {
    render(<LiveLogStreamTerminal />);
    await act(async () => {
      MockEventSource.instances[0]?.simulateOpen();
      MockEventSource.instances[0]?.simulateMessage({ kind: 'system', message: 'SystemMsg', ts: Date.now() });
      MockEventSource.instances[0]?.simulateMessage({ kind: 'error', message: 'ErrorMsg', ts: Date.now() });
    });
    // Open filter bar
    fireEvent.click(screen.getByRole('button', { name: /toggle filter/i }));
    // Click 'error' kind filter pill — use getAllByRole to pick the button (not the log badge span)
    await waitFor(() => screen.getAllByRole('button', { name: /^error$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^error$/i })[0]);
    await waitFor(() => {
      expect(screen.queryByText('SystemMsg')).not.toBeInTheDocument();
      expect(screen.getByText('ErrorMsg')).toBeInTheDocument();
    });
  });

  it('collapses and expands on toggle', () => {
    render(<LiveLogStreamTerminal defaultExpanded />);
    const collapseBtn = screen.getByRole('button', { name: /collapse terminal/i });
    fireEvent.click(collapseBtn);
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /expand terminal/i }));
    expect(screen.getByRole('log')).toBeInTheDocument();
  });

  it('clears log lines when clear button is clicked', async () => {
    render(<LiveLogStreamTerminal />);
    await act(async () => {
      MockEventSource.instances[0]?.simulateOpen();
      MockEventSource.instances[0]?.simulateMessage({ kind: 'output', message: 'Hello log', ts: Date.now() });
    });
    await waitFor(() => expect(screen.getByText('Hello log')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /clear log terminal/i }));
    await waitFor(() => expect(screen.queryByText('Hello log')).not.toBeInTheDocument());
  });

  it('renders the log aria-live region', () => {
    render(<LiveLogStreamTerminal />);
    expect(screen.getByRole('log')).toBeInTheDocument();
  });

  it('has correct accessible label', () => {
    render(<LiveLogStreamTerminal />);
    const section = screen.getByRole('region', { name: /live execution log terminal/i });
    expect(section).toBeInTheDocument();
  });
});
