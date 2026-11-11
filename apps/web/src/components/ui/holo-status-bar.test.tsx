import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import HoloStatusBar from './holo-status-bar';
import { unifiedApi } from '@/lib/api_client';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    fleetStatus: vi.fn(),
  },
}));

afterEach(() => vi.clearAllMocks());

describe('HoloStatusBar', () => {
  it('renders live fleet telemetry from /api/v1/fleet/status', async () => {
    vi.mocked(unifiedApi.fleetStatus).mockResolvedValue({
      ok: true,
      mode: 'CODER_WORKER',
      counts: { pending: 3, completed: 12, blocked: 1 },
      next_pending: [],
      active_locks: [{ file_path: 'a.py', worker_id: 'w1' }],
    });

    render(<HoloStatusBar refreshIntervalMs={60000} />);

    await waitFor(() => {
      expect(screen.getByTestId('holo-stat-pending')).toHaveTextContent('3');
    });
    expect(screen.getByTestId('holo-stat-shipped')).toHaveTextContent('12');
    expect(screen.getByTestId('holo-stat-blocked')).toHaveTextContent('1');
    expect(screen.getByTestId('holo-stat-locks')).toHaveTextContent('1');
    expect(screen.getByText('mode: CODER_WORKER')).toBeInTheDocument();
    expect(screen.getByTestId('holo-status-bar')).toBeInTheDocument();
  });

  it('degrades to offline state when the fleet snapshot fails', async () => {
    vi.mocked(unifiedApi.fleetStatus).mockRejectedValue(new Error('boom'));

    render(<HoloStatusBar refreshIntervalMs={60000} />);

    await waitFor(() => {
      expect(screen.getByText('fleet offline')).toBeInTheDocument();
    });
    expect(screen.getByTestId('holo-stat-pending')).toHaveTextContent('0');
  });

  it('shows a ticking UTC clock', () => {
    vi.mocked(unifiedApi.fleetStatus).mockRejectedValue(new Error('offline'));
    render(<HoloStatusBar refreshIntervalMs={60000} />);
    expect(screen.getByText(/UTC$/)).toBeInTheDocument();
  });
});
