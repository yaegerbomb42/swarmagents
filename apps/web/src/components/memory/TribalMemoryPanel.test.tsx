import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import TribalMemoryPanel from './TribalMemoryPanel';

vi.mock('@/lib/tribal', () => ({
  fetchTribalRules: vi.fn(),
  fetchTribalStats: vi.fn(),
}));

import { fetchTribalRules, fetchTribalStats } from '@/lib/tribal';

const RULES = {
  rules: [
    {
      id: 'learned-0',
      rule: 'DB migrations must run before seeds.',
      confidence: 0.8,
      learned_at: '2026-08-19T12:00:00+00:00',
      source_task: 'task-abc',
      source: 'learned',
      section: 'Database',
    },
    {
      id: 'agmd-1',
      rule: 'Never commit broken lints.',
      confidence: 0.5,
      learned_at: null,
      source_task: null,
      source: 'agents_md',
      section: 'Never Do',
    },
  ],
  available: true,
  count: 2,
};

const STATS = {
  available: true,
  total_rules: 2,
  learned_rules: 1,
  static_rules: 1,
  flush_every: 25,
  tasks_since_flush: 3,
  last_flush_at: null,
};

beforeEach(() => {
  vi.mocked(fetchTribalRules).mockResolvedValue(RULES as any);
  vi.mocked(fetchTribalStats).mockResolvedValue(STATS as any);
});

afterEach(cleanup);

describe('TribalMemoryPanel', () => {
  it('renders learned rules with confidence and source task', async () => {
    render(<TribalMemoryPanel />);
    expect(await screen.findByText(/DB migrations must run before seeds/)).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/task task-abc/)).toBeInTheDocument();
    expect(screen.getByText(/What the swarm learned/)).toBeInTheDocument();
  });

  it('renders stats header with flush cadence', async () => {
    render(<TribalMemoryPanel />);
    expect(await screen.findByText('Total Rules')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/every 25 tasks · 3 since last/)).toBeInTheDocument();
  });

  it('search filters rules by text', async () => {
    render(<TribalMemoryPanel />);
    await screen.findByText(/DB migrations/);
    fireEvent.change(screen.getByPlaceholderText(/Search rules/), { target: { value: 'lints' } });
    expect(screen.queryByText(/DB migrations/)).not.toBeInTheDocument();
    expect(screen.getByText(/Never commit broken lints/)).toBeInTheDocument();
  });

  it('filter toggle narrows to learned only', async () => {
    render(<TribalMemoryPanel />);
    await screen.findByText(/DB migrations/);
    fireEvent.click(screen.getByRole('button', { name: 'Learned' }));
    expect(screen.getByText(/DB migrations/)).toBeInTheDocument();
    expect(screen.queryByText(/Never commit broken lints/)).not.toBeInTheDocument();
  });

  it('shows empty-state copy when swarm has no rules', async () => {
    vi.mocked(fetchTribalRules).mockResolvedValue({ rules: [], available: true, count: 0 } as any);
    render(<TribalMemoryPanel />);
    expect(await screen.findByText(/No tribal rules yet/)).toBeInTheDocument();
  });

  it('shows unavailable copy when cognitive layer is off', async () => {
    vi.mocked(fetchTribalRules).mockResolvedValue({ rules: [], available: false } as any);
    render(<TribalMemoryPanel />);
    expect(await screen.findByText(/Tribal memory unavailable/)).toBeInTheDocument();
  });

  it('shows standby state when fetch fails', async () => {
    vi.mocked(fetchTribalRules).mockRejectedValue(new Error('tribal /tribal/rules failed: 503'));
    render(<TribalMemoryPanel />);
    await waitFor(() =>
      expect(screen.getByText(/Swarm Memory Standby/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});
