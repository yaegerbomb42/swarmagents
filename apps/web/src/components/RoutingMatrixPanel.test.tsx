import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RoutingMatrixPanel from './RoutingMatrixPanel';

const mockMatrix = {
  version: 1 as const,
  updatedAt: new Date().toISOString(),
  routes: [
    {
      role: 'architect' as const,
      label: 'Architect',
      description: 'Planning',
      provider: 'azure',
      model: 'DeepSeek-V4-Flash',
      rpmLimit: 30,
      dailyBudgetUsd: 10,
      maxConcurrent: 2,
      fallbacks: [],
      enabled: true,
    },
  ],
  usage: [
    {
      role: 'architect' as const,
      callsToday: 0,
      tokensToday: 0,
      spendUsd: 0,
      rpmWindow: 0,
    },
  ],
};

const mockProviderMetrics = {
  providers: [
    {
      name: 'azure',
      model: 'gpt-5-nano',
      keys_total: 2,
      keys_available: 2,
      keys_in_cooldown: 0,
      in_cooldown: false,
      circuit_state: 'closed',
      avg_latency_ms: 42.5,
      success_rate: 0.95,
      configured: true,
    },
    {
      name: 'groq',
      model: 'qwen/qwen3-8-27b',
      keys_total: 1,
      keys_available: 0,
      keys_in_cooldown: 1,
      in_cooldown: true,
      circuit_state: 'closed',
      avg_latency_ms: 88.0,
      success_rate: 0.4,
      configured: true,
    },
    {
      name: 'mistral',
      model: 'mistral-large-latest',
      keys_total: 0,
      keys_available: 0,
      keys_in_cooldown: 0,
      in_cooldown: false,
      circuit_state: 'closed',
      avg_latency_ms: 0,
      success_rate: 0,
      configured: false,
    },
  ],
  updated_at: Date.now() / 1000,
};

const mockRouterMetrics = {
  total_decisions: 10,
  current_accuracy: 0.9,
  branch_probabilities: {
    actions: { split: 0.5, execute: 0.5 },
    thinking_styles: { systematic_analysis: 1.0 },
  },
};

describe('RoutingMatrixPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/quantum/router/metrics')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockRouterMetrics,
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            matrix: mockMatrix,
            failoverEvents: [],
            routerMetrics: mockRouterMetrics,
            providerMetrics: mockProviderMetrics,
          }),
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders Azure/Groq/Mistral provider health rows', async () => {
    render(<RoutingMatrixPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('provider-row-azure')).toBeDefined();
      expect(screen.getByTestId('provider-row-groq')).toBeDefined();
      expect(screen.getByTestId('provider-row-mistral')).toBeDefined();
    });
    expect(screen.getByText('Provider health (live)')).toBeDefined();
    expect(screen.getByText('cooldown')).toBeDefined();
    expect(screen.getByTestId('router-probability-panel')).toBeDefined();
    expect(screen.getByTestId('branch-split')).toBeDefined();
  });
});
