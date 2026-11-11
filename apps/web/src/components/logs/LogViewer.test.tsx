import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import LogViewer from './LogViewer';

type MockEsHandler = {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
};

const mockInstances: Array<{ url: string; handlers: MockEsHandler }> = [];

class MockEventSource {
  handlers: MockEsHandler = { onopen: null, onmessage: null, onerror: null };

  constructor(public url: string) {
    mockInstances.push({ url, handlers: this.handlers });
  }

  set onopen(fn: (() => void) | null) {
    this.handlers.onopen = fn;
  }
  get onopen() {
    return this.handlers.onopen;
  }

  set onmessage(fn: ((ev: { data: string }) => void) | null) {
    this.handlers.onmessage = fn;
  }
  get onmessage() {
    return this.handlers.onmessage;
  }

  set onerror(fn: (() => void) | null) {
    this.handlers.onerror = fn;
  }
  get onerror() {
    return this.handlers.onerror;
  }

  close() {}
}

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    sseLogsUrl: () => 'http://test/api/v1/sse/logs',
  },
}));

describe('LogViewer', () => {
  beforeEach(() => {
    mockInstances.length = 0;
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders and connects to sse logs url', async () => {
    render(<LogViewer />);
    expect(screen.getByTestId('log-viewer')).toBeInTheDocument();
    expect(mockInstances[0]?.url).toBe('http://test/api/v1/sse/logs');

    await act(async () => {
      mockInstances[0]?.handlers.onopen?.();
    });

    await waitFor(() => {
      expect(screen.getByText('Execution logs')).toBeInTheDocument();
    });
  });

  it('appends streamed log lines', async () => {
    render(<LogViewer />);
    await act(async () => {
      mockInstances[0]?.handlers.onopen?.();
      mockInstances[0]?.handlers.onmessage?.({
        data: JSON.stringify({
          ts: 1_700_000_000,
          kind: 'task',
          message: 'Queued: Wire terminal',
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Queued: Wire terminal')).toBeInTheDocument();
    });
  });
});
