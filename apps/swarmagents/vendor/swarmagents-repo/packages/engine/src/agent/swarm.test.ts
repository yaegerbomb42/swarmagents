import { describe, expect, it } from 'vitest';
import {
  aggregateConsensus,
  consensusThreshold,
  DelegationBus,
  type ConsensusVote,
} from './swarm.js';

describe('consensusThreshold', () => {
  it('returns a simple majority (floor(n/2)+1)', () => {
    expect(consensusThreshold(1)).toBe(1);
    expect(consensusThreshold(3)).toBe(2);
    expect(consensusThreshold(4)).toBe(3);
    expect(consensusThreshold(5)).toBe(3);
  });
});

describe('aggregateConsensus', () => {
  const votes = (decisions: Array<ConsensusVote['decision']>): ConsensusVote[] =>
    decisions.map((decision, i) => ({ seat: `seat-${i}`, decision, reason: '' }));

  it('approves when votes reach the threshold', () => {
    const result = aggregateConsensus('r1', votes(['approve', 'approve', 'approve', 'reject']), 4);
    expect(result.approved).toBe(true);
    expect(result.votesFor).toBe(3);
    expect(result.votesAgainst).toBe(1);
    expect(result.threshold).toBe(3);
    expect(result.summary).toBe('Consensus: 3/4 approved');
  });

  it('rejects when the threshold is not met and counts abstentions', () => {
    const result = aggregateConsensus(
      'r1',
      votes(['approve', 'approve', 'abstain', 'abstain']),
      4,
    );
    expect(result.approved).toBe(false);
    expect(result.votesFor).toBe(2);
    expect(result.votesAbstain).toBe(2);
    expect(result.summary).toContain('need 3');
  });
});

describe('DelegationBus', () => {
  it('publishes enriched messages, notifies subscribers, and keeps history', () => {
    const bus = new DelegationBus({ now: () => 42 });
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe((message) => received.push(message));

    const published = bus.publish({
      type: 'propose_plan',
      from: 'coordinator',
      payload: { goal: 'build x', roundId: 'r1', subTasks: [] },
    });

    expect(published.id).toMatch(/^msg-42-/);
    expect(published.timestamp).toBe(42);
    expect(received).toHaveLength(1);
    expect(bus.history()).toHaveLength(1);

    unsubscribe();
    bus.publish({
      type: 'peer_review',
      from: 'auditor',
      payload: {
        proposalId: 'p1',
        roundId: 'r1',
        reviewer: 'auditor',
        scores: { security: 90, speed: 80, correctness: 85 },
        verdict: 'approve',
        notes: [],
      },
    });
    expect(received).toHaveLength(1);
    expect(bus.history()).toHaveLength(2);
  });
});
