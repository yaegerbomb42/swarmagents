import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import WorkerHeatmap from './WorkerHeatmap';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: { fleetStatus: vi.fn() },
}));

import { unifiedApi } from '@/lib/api_client';

afterEach(() => vi.clearAllMocks());

describe('WorkerHeatmap', () => {
  it('renders worker cells from fleet status locks', async () => {
    vi.mocked(unifiedApi.fleetStatus).mockResolvedValue({
      ok: true,
      mode: 'IDEATION_ARCHITECT',
      counts: { pending: 3, completed: 10, blocked: 0 },
      next_pending: [],
      active_locks: [
        { worker_id: 'w-alpha', file_path: '/a.py' },
        { worker_id: 'w-alpha', file_path: '/b.py' },
        { worker_id: 'w-beta', file_path: '/c.ts' },
      ],
    });

    render(<WorkerHeatmap refreshIntervalMs={60000} />);
    expect(await screen.findByTestId('worker-cell-w-alpha')).toBeDefined();
    expect(screen.getByTestId('worker-cell-w-beta')).toBeDefined();
    expect(screen.getByText('2 locks')).toBeDefined();
  });

  it('shows empty state when no locks', async () => {
    vi.mocked(unifiedApi.fleetStatus).mockResolvedValue({
      ok: true,
      mode: 'IDEATION_ARCHITECT',
      counts: { pending: 0, completed: 0, blocked: 0 },
      next_pending: [],
      active_locks: [],
    });

    render(<WorkerHeatmap refreshIntervalMs={60000} />);
    expect(await screen.findByText('No active file leases')).toBeDefined();
  });
});
