import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import FleetTaskTree from './FleetTaskTree';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    fleetStatus: vi.fn().mockResolvedValue({
      next_pending: [
        { id: 'T-1', title: 'Wire terminal', priority: 9 },
        { id: 'T-2', title: 'Ship diff viewer', priority: 8 },
      ],
    }),
    reorderTasks: vi.fn().mockResolvedValue({ ok: true, updated: [], count: 0 }),
  },
}));

describe('FleetTaskTree', () => {
  it('renders pending tasks from fleet status', async () => {
    render(<FleetTaskTree />);
    await waitFor(() => {
      expect(screen.getByText('Wire terminal')).toBeInTheDocument();
      expect(screen.getByText('Ship diff viewer')).toBeInTheDocument();
    });
  });
});
