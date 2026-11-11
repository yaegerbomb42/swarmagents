import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RouterProbabilityPanel from './RouterProbabilityPanel';

const mockMetrics = {
  total_decisions: 120,
  current_accuracy: 0.88,
  branch_probabilities: {
    actions: {
      split: 0.45,
      execute: 0.35,
      merge: 0.2,
    },
    thinking_styles: {
      systematic_analysis: 0.6,
      creative_exploration: 0.4,
    },
  },
};

describe('RouterProbabilityPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockMetrics,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders live branch probability bars for actions and thinking styles', async () => {
    render(<RouterProbabilityPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('router-probability-panel')).toBeDefined();
      expect(screen.getByTestId('branch-split')).toBeDefined();
      expect(screen.getByTestId('branch-systematic_analysis')).toBeDefined();
    });
    expect(screen.getByText('45%')).toBeDefined();
    expect(screen.getByText('60%')).toBeDefined();
    expect(screen.getByText(/120 decisions/)).toBeDefined();
  });
});
