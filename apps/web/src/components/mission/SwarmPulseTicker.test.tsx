import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SwarmPulseTicker from './SwarmPulseTicker';
import { unifiedApi } from '@/lib/api_client';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    sseLogsUrl: vi.fn(() => 'http://localhost:8410/api/v1/sse/logs'),
  },
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor() {
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

vi.stubGlobal('EventSource', MockEventSource);

afterEach(() => {
  MockEventSource.instances = [];
  vi.clearAllMocks();
});

describe('SwarmPulseTicker', () => {
  it('renders idle ribbon before any events arrive', () => {
    render(<SwarmPulseTicker />);
    expect(screen.getByTestId('swarm-pulse-ticker')).toBeInTheDocument();
    expect(screen.getAllByText(/awaiting swarm activity/i).length).toBeGreaterThan(0);
    expect(screen.getByText('reconnecting')).toBeInTheDocument();
  });

  it('streams live SSE events into the ribbon with dedupe', async () => {
    render(<SwarmPulseTicker maxEvents={5} />);
    const es = MockEventSource.instances[0];
    es.onopen?.();

    await waitFor(() => {
      expect(screen.getByText('swarm pulse')).toBeInTheDocument();
    });

    const frame = (kind: string, message: string, ts: number) =>
      es.onmessage?.({ data: JSON.stringify({ ts, kind, message }) });

    frame('task', 'Queued: wire SSE feed', 1000);
    frame('lock', 'Worker w1 holds engine/api/main.py', 1001);
    frame('task', 'Queued: wire SSE feed', 1000); // duplicate — must be ignored

    await waitFor(() => {
      expect(screen.getAllByText('Queued: wire SSE feed').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Worker w1 holds engine/api/main.py').length).toBeGreaterThan(0);
    expect(screen.getAllByText('[task]').length).toBe(2); // dedupe: one per ribbon copy
  });

  it('closes the EventSource on unmount', () => {
    const { unmount } = render(<SwarmPulseTicker />);
    const es = MockEventSource.instances[0];
    unmount();
    expect(es.closed).toBe(true);
  });
});
