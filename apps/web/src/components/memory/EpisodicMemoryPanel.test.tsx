import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import EpisodicMemoryPanel from './EpisodicMemoryPanel';

vi.mock('@/lib/memoryApi', () => ({
  fetchEpisodicMemory: vi.fn(),
}));

import { fetchEpisodicMemory } from '@/lib/memoryApi';

describe('EpisodicMemoryPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders episodic lessons from engine API', async () => {
    vi.mocked(fetchEpisodicMemory).mockResolvedValue({
      entries: [
        {
          lesson_id: 'l1',
          lesson_text: 'Always run migrations before seeds.',
          lesson_type: 'constraint',
          occurrences: 2,
        },
      ],
      count: 1,
      active_goal: { goal_id: 'goal-abc' },
    });

    render(<EpisodicMemoryPanel />);

    await waitFor(() => {
      expect(screen.getByText('Always run migrations before seeds.')).toBeDefined();
    });
    expect(screen.getByText('goal-abc')).toBeDefined();
  });
});
