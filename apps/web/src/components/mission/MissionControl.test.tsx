import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MissionControl from './MissionControl';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    missionSnapshot: vi.fn(),
    hamiltonianPlan: vi.fn(),
    missionEvents: vi.fn(),
    groupchatConsensus: vi.fn(),
    fleetStatus: vi.fn(),
  },
}));

vi.mock('@/components/timeline/TrajectoryTimeline', () => ({
  default: () => <div data-testid="trajectory-timeline" />,
}));
vi.mock('@/components/terminal/FleetTerminal', () => ({
  default: () => <div data-testid="fleet-terminal" />,
}));
vi.mock('@/components/terminal/PtyTerminal', () => ({
  default: () => <div data-testid="pty-terminal" />,
}));
vi.mock('./MissionTerminalFeed', () => ({
  default: () => <div data-testid="mission-terminal-feed" />,
}));
vi.mock('@/components/logs/LogViewer', () => ({
  default: () => <div data-testid="log-viewer" />,
}));
vi.mock('@/components/audio/VoiceBriefing', () => ({
  default: () => <div data-testid="voice-briefing" />,
}));
vi.mock('@/components/fleet/FleetTaskTree', () => ({
  default: () => <div data-testid="fleet-task-tree" />,
}));
vi.mock('@/components/fleet/WorkerHeatmap', () => ({
  default: () => <div data-testid="worker-heatmap" />,
}));
vi.mock('@/components/swarm/ConsensusReplay', () => ({
  default: () => <div data-testid="consensus-replay" />,
}));
vi.mock('@/components/ui/holo-status-bar', () => ({
  default: () => <div data-testid="holo-status-bar" />,
}));
vi.mock('./SwarmPulseTicker', () => ({
  default: () => <div data-testid="swarm-pulse-ticker" />,
}));

import { unifiedApi } from '@/lib/api_client';

afterEach(() => vi.clearAllMocks());

describe('MissionControl', () => {
  it('renders launch command center with hamiltonian viz', async () => {
    vi.mocked(unifiedApi.missionSnapshot).mockResolvedValue({
      ok: true,
      launch_mode: 'CODER_WORKER',
      fleet: {
        mode: 'CODER_WORKER',
        counts: { pending: 2, completed: 10, blocked: 0 },
        active_locks: [],
      },
      checkpoints: [
        { id: 'plan', label: 'Plan', status: 'complete' },
        { id: 'implement', label: 'Implement', status: 'active' },
        { id: 'verify', label: 'Verify', status: 'pending' },
        { id: 'ship', label: 'Ship', status: 'pending' },
      ],
    });
    vi.mocked(unifiedApi.hamiltonianPlan).mockResolvedValue({
      ok: true,
      plan: { actions: ['plan', 'code', 'ship'], total_energy: 4, steps: [] },
    });

    render(<MissionControl />);
    await waitFor(() => {
      expect(screen.getByTestId('mission-control')).toBeDefined();
    });
    expect(screen.getByTestId('hamiltonian-viz')).toBeDefined();
    expect(screen.getByTestId('fleet-terminal')).toBeDefined();
    expect(screen.getByText('Mission Control')).toBeDefined();
  });
});
