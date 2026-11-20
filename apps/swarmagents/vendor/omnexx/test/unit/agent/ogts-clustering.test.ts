import { describe, expect, it } from 'vitest';
import {
  behavioralHash,
  clusterCandidates,
  computeBehavioralSignature,
  hashExecutionVectors,
  selectRepresentatives,
} from '../../../src/agent/ogts/clustering.js';

describe('ogts behavioral clustering', () => {
  it('hashes execution vectors deterministically', () => {
    const v = [{ stdout: 'ok', stderr: '', exitCode: 0 }];
    expect(hashExecutionVectors(v)).toBe(hashExecutionVectors(v));
    expect(hashExecutionVectors(v)).toBe(behavioralHash(v));
  });

  it('groups duplicates and selects one representative per cluster', () => {
    const cands = [
      { id: 'a', outputs: [{ stdout: 'x', stderr: '', exitCode: 0 }] },
      { id: 'b', outputs: [{ stdout: 'x', stderr: '', exitCode: 0 }] },
      { id: 'c', outputs: [{ stdout: 'y', stderr: '', exitCode: 1 }] },
    ];
    const clusters = clusterCandidates(cands);
    expect(clusters.length).toBe(2);
    const reps = selectRepresentatives(clusters);
    expect(reps.length).toBe(2);
  });

  it('computeBehavioralSignature uses provided signature', () => {
    const c = { signature: 'abc', outputs: [] };
    expect(computeBehavioralSignature(c)).toBe('abc');
  });
});
