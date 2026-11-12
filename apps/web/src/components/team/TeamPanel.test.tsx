import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeamPanel } from './TeamPanel';
import type { TeamRun } from '@/lib/team/types';

function run(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    runId: 'team-test-1',
    goal: 'Build the onboarding flow',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: [
      { id: 't1', title: 'Design the schema', detail: '', roleId: 'architect', agentId: 'a1', status: 'merged' },
      { id: 't2', title: 'Write the endpoints', detail: '', roleId: 'implementer', agentId: 'a2', status: 'rework' },
      { id: 't3', title: 'Test the flow', detail: '', roleId: 'qa-engineer', agentId: 'a3', status: 'pending' },
    ],
    agents: [
      {
        agentId: 'planner',
        kind: 'planner',
        roleId: 'planner',
        roleName: 'Planner',
        glyph: 'P',
        color: 'from-cyan-400 to-sky-500',
        taskId: null,
        taskTitle: null,
        status: 'merged',
        currentAction: 'Plan ready — 3 tasks',
        provider: 'Groq',
        model: 'llama-3.3-70b',
        worktree: 'team',
        attempts: 0,
        tokens: 900,
        costUsd: 0.0004,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        takenOver: false,
        lastNote: null,
      },
      {
        agentId: 'a2',
        kind: 'worker',
        roleId: 'implementer',
        roleName: 'Implementer',
        glyph: 'I',
        color: 'from-emerald-400 to-teal-500',
        taskId: 't2',
        taskTitle: 'Write the endpoints',
        status: 'rework',
        currentAction: 'Fixing review feedback…',
        provider: 'Cerebras',
        model: 'llama3.3',
        worktree: 'team-test-1/a2',
        attempts: 1,
        tokens: 1500,
        costUsd: 0.0012,
        startedAt: Date.now(),
        finishedAt: null,
        takenOver: false,
        lastNote: 'add the missing test',
      },
    ],
    budget: { tokenCap: 120_000, tokensUsed: 2400, costCapUsd: 2, costUsedUsd: 0.0016 },
    concurrency: { limit: 3, active: 1 },
    mergedFiles: ['merged/t1.md'],
    error: null,
    rotationCursor: 2,
    userId: 'local',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TeamPanel', () => {
  it('renders the plan checklist, lanes and live status', () => {
    render(<TeamPanel run={run()} />);

    expect(screen.getByTestId('team-run-status')).toHaveTextContent('Running');
    expect(screen.getByTestId('team-plan')).toBeInTheDocument();
    expect(screen.getByTestId('team-plan-t1')).toHaveAttribute('data-status', 'merged');
    expect(screen.getByTestId('team-plan-t2')).toHaveAttribute('data-status', 'rework');
    expect(screen.getByTestId('team-plan-t3')).toHaveAttribute('data-status', 'pending');

    expect(screen.getByTestId('team-lane-planner')).toBeInTheDocument();
    expect(screen.getByTestId('team-lane-a2')).toHaveAttribute('data-status', 'rework');
    expect(screen.getByTestId('team-lane-status-a2')).toHaveTextContent('Rework');
    expect(screen.getByTestId('team-lane-action-a2')).toHaveTextContent('Fixing review feedback');
    expect(screen.getByTestId('team-lane-cost-a2')).toHaveTextContent('$0.0012');
    expect(screen.getByTestId('team-lane-count')).toHaveTextContent('1/3');
    expect(screen.getByTestId('team-token-budget')).toHaveTextContent('2,400 / 120,000 · 2%');
  });

  it('takes over an agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<TeamPanel run={run()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Take over Implementer' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/team/team-test-1/takeover');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ agentId: 'a2' });
  });

  it('disables takeover for lanes that already finished', () => {
    render(<TeamPanel run={run()} />);
    expect(screen.getByRole('button', { name: 'Take over Planner' })).toBeDisabled();
  });
});