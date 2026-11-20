import { describe, expect, it } from 'vitest';
import { UsageLedger } from '../../../src/providers/usage-ledger.js';
import { tempDir } from '../../support/tmp.js';
import { join } from 'node:path';

describe('Step 4.6: Real-Time Tier Cost Accounting Ledger', () => {
  it('attributes token counts and dollar spend across tiers and calculates baseline savings', async () => {
    const dir = await tempDir();
    const ledger = new UsageLedger(join(dir, 'ledger.jsonl'), 'run-1', 'bench-task');

    // Simulate benchmark turns:
    // Turn 1-4: Tier 1 deterministic / fast-path ($0.00 / call, 20,000 tokens)
    ledger.recordTierUsage(1, 20_000, 0.0);

    // Turn 5-6: Tier 2 mid-tier edit ($0.25 / 1M tokens = $0.00025 / 1k tokens, 10,000 tokens)
    // 10k tokens * $0.00025 / 1k = $0.0025
    ledger.recordTierUsage(2, 10_000, 0.0025);

    // Turn 7: Tier 3 frontier model ($10.00 / 1M tokens = $0.010 / 1k tokens, 5,000 tokens)
    // 5k tokens * $0.010 / 1k = $0.050
    ledger.recordTierUsage(3, 5_000, 0.05);

    // Baseline frontier rate: $0.01 per 1k tokens ($10 / 1M)
    const stats = ledger.getTierStats(0.01);

    expect(stats.tier1_tokens).toBe(20_000);
    expect(stats.tier2_tokens).toBe(10_000);
    expect(stats.tier3_tokens).toBe(5_000);

    expect(stats.tier1_cost).toBe(0.0);
    expect(stats.tier2_cost).toBeCloseTo(0.0025, 4);
    expect(stats.tier3_cost).toBeCloseTo(0.05, 4);

    // Total cost = 0.0 + 0.0025 + 0.050 = $0.0525
    expect(stats.total_cost).toBeCloseTo(0.0525, 4);

    // If all 35,000 tokens ran on frontier model:
    // 35,000 / 1000 * $0.01 = $0.35
    expect(stats.all_frontier_baseline_cost).toBeCloseTo(0.35, 2);

    // Savings = 0.35 - 0.0525 = $0.2975
    expect(stats.estimated_savings_usd).toBeCloseTo(0.2975, 4);

    // Savings percent = 0.2975 / 0.35 = 85.0% (> 65% acceptance threshold!)
    expect(stats.savings_percent).toBeGreaterThan(65);
    expect(stats.savings_percent).toBeCloseTo(85.0, 1);
  });

  it('records tier attribution through recordCall metadata', async () => {
    const dir = await tempDir();
    const ledger = new UsageLedger(join(dir, 'ledger.jsonl'), 'run-2', 'bench-task-2');

    ledger.recordCall(
      {
        purpose: 'main',
        tier: 2,
      },
      {
        model: 'claude-3-5-haiku',
        provider: 'anthropic',
        usage: {
          uncached: 4000,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 1000,
          output: 500,
        },
        usd: 0.002,
      },
    );

    const stats = ledger.getTierStats(0.01);
    expect(stats.tier2_cost).toBe(0.002);
    expect(stats.tier2_tokens).toBe(5500); // 4000 uncached + 1000 cacheRead + 500 output
    expect(stats.tier1_cost).toBe(0);
    expect(stats.tier3_cost).toBe(0);
  });
});
