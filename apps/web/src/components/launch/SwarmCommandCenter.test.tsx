import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api_client', () => ({
  unifiedApi: {
    launchSnapshot: vi.fn(),
    groupchatConsensus: vi.fn(),
    missionSnapshot: vi.fn(),
    hamiltonianPlan: vi.fn(),
    sseLogsUrl: vi.fn(() => 'http://localhost:8410/api/v1/sse/logs'),
  },
}));

vi.mock('@/components/topology/SwarmCanvas3D', () => ({
  default: () => <div data-testid="swarm-canvas-mock">canvas</div>,
}));

vi.mock('@/components/timeline/TrajectoryTimeline', () => ({
  default: () => <div data-testid="trajectory-mock">trajectory</div>,
}));

vi.mock('@/components/fleet/WorkerHeatmap', () => ({
  default: () => <div data-testid="heatmap-mock">heatmap</div>,
}));

vi.mock('@/components/swarm/ConsensusReplay', () => ({
  default: () => <div data-testid="consensus-mock">consensus</div>,
}));

vi.mock('@/components/quantum/HamiltonianViz', () => ({
  default: () => <div data-testid="hamiltonian-mock">hamiltonian</div>,
  planToHamiltonianGraph: () => ({ nodes: [], edges: [] }),
}));

vi.mock('@/components/logs/LiveLogStreamTerminal', () => ({
  default: () => <div data-testid="live-log-terminal-mock">terminal</div>,
}));

vi.mock('@/components/fleet/AgentHealthMatrixCard', () => ({
  default: () => <div data-testid="agent-health-matrix-mock">health matrix</div>,
}));

vi.mock('@/components/mission/MissionCheckpointBar', () => ({
  default: () => <div data-testid="checkpoint-bar-mock">checkpoints</div>,
}));

import { unifiedApi } from '@/lib/api_client';
import SwarmCommandCenter from './SwarmCommandCenter';

const MOCK_SNAPSHOT = {
  ok: true,
  readiness_pct: 85,
  status: 'launch_ready',
  generated_at: '2026-08-30T00:00:00Z',
  telemetry: { workers_active: 3, queue_depth: 12, mode: 'CODER_WORKER', modal_apps: 2 },
  fleet: {
    counts: { pending: 12, completed: 400, blocked: 0 },
    next_pending: [{ id: 'T-1', title: 'Ship feature', priority: 9 }],
    active_locks: [],
  },
  missions: [
    {
      id: 'tool_qa',
      label: '10m Tool QA',
      budget: '10 minutes',
      description: 'Quick QA mission',
      href: '/decomp?mission=tool_qa',
    },
  ],
};

describe('SwarmCommandCenter', () => {
  beforeEach(() => {
    vi.mocked(unifiedApi.launchSnapshot).mockResolvedValue(MOCK_SNAPSHOT);
    vi.mocked(unifiedApi.groupchatConsensus).mockResolvedValue({
      ok: true,
      consensus: { accepted: true },
    });
    vi.mocked(unifiedApi.missionSnapshot).mockResolvedValue({
      ok: true,
      launch_mode: 'CODER_WORKER',
      fleet: { mode: 'CODER_WORKER', counts: { pending: 0, completed: 0, blocked: 0 }, active_locks: [] },
      checkpoints: [
        { id: 'plan', label: 'Plan', status: 'complete' },
        { id: 'ship', label: 'Ship', status: 'pending' },
      ],
    });
    vi.mocked(unifiedApi.hamiltonianPlan).mockResolvedValue({
      ok: true,
      plan: { actions: ['plan', 'code', 'ship'], total_energy: 4, steps: [] },
    });
  });

  it('renders mission command header and readiness', async () => {
    render(<SwarmCommandCenter />);
    expect(screen.getByTestId('swarm-command-center')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Mission Command Center')).toBeInTheDocument();
      expect(screen.getByLabelText('85%')).toBeInTheDocument();
      expect(screen.getByText('LAUNCH READY')).toBeInTheDocument();
    });
  });

  it('loads sub-panels and mission cards', async () => {
    render(<SwarmCommandCenter />);
    await waitFor(() => {
      expect(screen.queryByTestId('swarm-canvas-mock')).not.toBeInTheDocument();
      expect(screen.getByTestId('trajectory-mock')).toBeInTheDocument();
      expect(screen.getByTestId('live-log-terminal-mock')).toBeInTheDocument();
      expect(screen.getByText('10m Tool QA')).toBeInTheDocument();
      expect(screen.getByText('Launch →')).toBeInTheDocument();
    });
  });

  it('shows fleet queue task', async () => {
    render(<SwarmCommandCenter />);
    await waitFor(() => {
      expect(screen.getByText('T-1')).toBeInTheDocument();
      expect(screen.getByText('Ship feature')).toBeInTheDocument();
    });
  });
});
