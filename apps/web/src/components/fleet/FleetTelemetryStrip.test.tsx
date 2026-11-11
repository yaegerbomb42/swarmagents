import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FleetTelemetryStrip, {
  computeTokenVelocity,
  formatCompact,
} from './FleetTelemetryStrip';

const HEALTH = {
  status: 'healthy',
  active_agents: 6,
  total_agents: 8,
  tasks_queued: 3,
  tasks_running: 2,
  tasks_completed: 41,
  tasks_failed: 1,
  avg_latency_ms: 340,
  uptime_seconds: 8100,
  uptime_human: '2h 15m',
  throughput: 12,
  total_tokens: 1_234_567,
};

function mockHealth(payload: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    json: async () => payload,
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockHealth(HEALTH));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('computeTokenVelocity', () => {
  it('returns null without a previous sample', () => {
    expect(computeTokenVelocity(null, { totalTokens: 100, at: 1000 })).toBeNull();
  });

  it('derives tokens per second from the sample delta', () => {
    expect(
      computeTokenVelocity({ totalTokens: 1000, at: 0 }, { totalTokens: 3000, at: 1000 }),
    ).toBe(2000);
  });

  it('returns null on a counter reset (engine restart)', () => {
    expect(
      computeTokenVelocity({ totalTokens: 5000, at: 0 }, { totalTokens: 12, at: 1000 }),
    ).toBeNull();
  });

  it('returns null when no time elapsed', () => {
    expect(
      computeTokenVelocity({ totalTokens: 10, at: 500 }, { totalTokens: 90, at: 500 }),
    ).toBeNull();
  });
});

describe('formatCompact', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1200, '1.2k'],
    [1_234_567, '1.23M'],
    [2_500_000_000, '2.50B'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatCompact(input)).toBe(expected);
  });

  it('guards non-finite input', () => {
    expect(formatCompact(Number.NaN)).toBe('—');
  });
});

describe('FleetTelemetryStrip', () => {
  it('renders live fleet metrics from the engine health payload', async () => {
    render(<FleetTelemetryStrip refreshIntervalMs={60_000} />);

    expect(screen.getByTestId('fleet-telemetry-strip')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('telemetry-status')).toHaveTextContent('healthy');
    });

    expect(screen.getByTestId('metric-latency')).toHaveTextContent('340ms');
    expect(screen.getByTestId('metric-throughput')).toHaveTextContent('12/m');
    expect(screen.getByTestId('metric-agents')).toHaveTextContent('6/8');
    expect(screen.getByTestId('metric-queue')).toHaveTextContent('3+2');
    expect(screen.getByTestId('metric-tokens')).toHaveTextContent('1.23M');
    expect(screen.getByTestId('metric-uptime')).toHaveTextContent('2h 15m');
  });

  it('shows a placeholder for token velocity on the first sample', async () => {
    render(<FleetTelemetryStrip refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('metric-tokens')).toHaveTextContent('1.23M');
    });
    expect(screen.getByTestId('metric-velocity')).toHaveTextContent('—');
  });

  it('derives token velocity across two polls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => HEALTH })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...HEALTH, total_tokens: 1_236_567 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(0);
    render(<FleetTelemetryStrip refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    now.mockReturnValue(1000);
    fireEvent.click(screen.getByLabelText('Refresh fleet telemetry'));

    await waitFor(() => {
      // 2000 tokens in 1000ms => 2000 tok/s
      expect(screen.getByTestId('metric-velocity')).toHaveTextContent('2.0k');
    });
    now.mockRestore();
  });

  it('degrades to an offline beacon when the engine health probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    render(<FleetTelemetryStrip refreshIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('telemetry-status')).toHaveTextContent('offline');
    });
    expect(screen.getByText('ECONNREFUSED')).toBeInTheDocument();
    expect(screen.getByTestId('metric-tokens')).toHaveTextContent('—');
  });

  it('reports non-2xx health responses as offline', async () => {
    vi.stubGlobal('fetch', mockHealth({}, false));
    render(<FleetTelemetryStrip refreshIntervalMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('telemetry-status')).toHaveTextContent('offline');
    });
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
  });

  it('narrates the strip for assistive tech via a live region', async () => {
    render(<FleetTelemetryStrip refreshIntervalMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Engine healthy');
    });
  });
});
