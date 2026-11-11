import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentHealthMatrixCard from './AgentHealthMatrixCard';

// ─── Mock useSwarmTelemetry ────────────────────────────────────
vi.mock('@/hooks/useSwarmTelemetry', () => ({
  useSwarmTelemetry: vi.fn(() => ({
    workers: [],
    journal: [],
    phase: 'idle',
    engineReachable: false,
    lastUpdate: 0,
    counts: {
      agents: 0,
      activeTasks: 0,
      queuedTasks: 0,
      completedTasks: 0,
      totalTokens: null,
      avgLatencyMs: null,
      throughput: null,
      health: null,
    },
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────

function mockFetch(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

// ─── Tests ────────────────────────────────────────────────────

describe('AgentHealthMatrixCard', () => {
  beforeEach(() => {
    // Default: /api/swarm/agents returns 404 → falls back to demo agents
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Honest empty state ────────────────────────────────────

  it('shows an unavailable state (no fake agents) when the API returns 404', async () => {
    render(<AgentHealthMatrixCard refreshMs={60_000} />);
    expect(screen.getByTestId('agent-health-matrix-card')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('agent-matrix-empty')).toHaveTextContent(/unavailable/i);
    });
    expect(screen.getByTestId('agent-count-badge')).toHaveTextContent('0');
    expect(screen.queryByTestId('agent-cell-arch')).not.toBeInTheDocument();
  });

  it('has the correct ARIA label on the root section', async () => {
    render(<AgentHealthMatrixCard refreshMs={60_000} />);
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /agent health matrix — 0 agents/i }),
      ).toBeInTheDocument();
    });
  });

  // ── Live data replaces demo agents ────────────────────────

  it('renders live API data and a canonical legend when /api/swarm/agents succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        { id: 'live-1', status: 'healthy', model: 'gpt-4o', role: 'Orchestrator' },
        { id: 'live-2', status: 'busy',    model: 'mistral', role: 'Worker' },
      ]),
    );

    render(<AgentHealthMatrixCard refreshMs={60_000} />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-cell-live-1')).toBeInTheDocument();
      expect(screen.getByTestId('agent-cell-live-2')).toBeInTheDocument();
      expect(screen.queryByTestId('agent-cell-arch')).not.toBeInTheDocument();
      expect(screen.getByTestId('agent-count-badge')).toHaveTextContent('2');
    });
    expect(screen.getByTestId('status-legend').textContent).toMatch(/ready|running/i);
  });

  // ── Agent selection ───────────────────────────────────────

  it('fires onSelectAgent callback and shows tooltip on cell click', async () => {
    const user = userEvent.setup();
    const onSelectAgent = vi.fn();

    vi.stubGlobal('fetch', mockFetch([{ id: 'arch', status: 'ready', role: 'Architect' }]));
    render(<AgentHealthMatrixCard refreshMs={60_000} onSelectAgent={onSelectAgent} />);

    // Wait for cells to render
    const archCell = await screen.findByTestId('agent-cell-arch');
    await user.click(archCell);

    expect(onSelectAgent).toHaveBeenCalledWith('arch');
    expect(screen.getByTestId('agent-tooltip')).toBeInTheDocument();
  });

  // ── Phase label ───────────────────────────────────────────

  it('renders the phase label from useSwarmTelemetry', async () => {
    render(<AgentHealthMatrixCard refreshMs={60_000} />);
    await waitFor(() => {
      expect(screen.getByTestId('phase-label')).toHaveTextContent('idle');
    });
  });
});
