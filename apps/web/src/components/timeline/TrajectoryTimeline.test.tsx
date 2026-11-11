import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TrajectoryTimeline, { type TrajectoryStep } from './TrajectoryTimeline';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: { hamiltonianPlan: vi.fn() },
}));

import { unifiedApi } from '@/lib/api_client';

const STEPS: TrajectoryStep[] = [
  { id: 's0', label: 'THINK', energy: 1 },
  { id: 's1', label: 'EDIT', energy: 2 },
  { id: 's2', label: 'TEST', energy: 1.5 },
];

afterEach(() => vi.clearAllMocks());

describe('TrajectoryTimeline', () => {
  it('renders provided steps with playback controls', () => {
    render(<TrajectoryTimeline steps={STEPS} autoLoadDemo={false} />);
    expect(screen.getByTestId('trajectory-timeline')).toBeDefined();
    expect(screen.getByTestId('trajectory-step-0')).toBeDefined();
    expect(screen.getByLabelText('Play')).toBeDefined();
  });

  it('advances to next step on next button', async () => {
    const user = userEvent.setup();
    render(<TrajectoryTimeline steps={STEPS} autoLoadDemo={false} />);
    await user.click(screen.getByLabelText('Next step'));
    expect(screen.getByText('2 / 3 steps')).toBeDefined();
    expect(screen.getByTestId('trajectory-step-1').className).toContain('border-cyan');
  });

  it('loads demo plan from hamiltonian API', async () => {
    vi.mocked(unifiedApi.hamiltonianPlan).mockResolvedValue({
      ok: true,
      plan: {
        actions: ['plan', 'edit', 'submit'],
        total_energy: 3.5,
        steps: [],
      },
    });
    render(<TrajectoryTimeline autoLoadDemo />);
    await waitFor(() => {
      expect(screen.getByTestId('trajectory-step-0')).toBeDefined();
    });
    expect(unifiedApi.hamiltonianPlan).toHaveBeenCalled();
  });
});
