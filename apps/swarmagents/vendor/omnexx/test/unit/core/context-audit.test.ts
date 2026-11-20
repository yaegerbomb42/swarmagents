/**
 * Subsystem 4 audit — Context Architecture & 3-Level Prompt Topology.
 *
 * Each claim in the audit is backed by a reproducing unit test here:
 *  1. Strict 3-level hierarchy: no dynamic variables reach Level 0/Level 1, and the
 *     frozen-prefix fingerprint is stable under Level-2-only changes.
 *  2. clampSlotTail / clampSlot edge cases: overflow keeps the newest living state and
 *     never returns more than the budget, even for tiny budgets.
 *  3. Canonicalization: NFC + CRLF normalization and $REPO path substitution that only
 *     fires on whole path segments (no prefix collisions).
 */
import { describe, expect, it } from 'vitest';
import { canonicalizePrefixText, clampSlot, clampSlotTail } from '../../../src/agent/context.js';
import { CacheOptimizedAssembler } from '../../../src/core/prompt-assembler.js';
import type { ToolSpec } from '../../../src/providers/types.js';

const REPO = '/Users/developer/workspace/project';

/* ------------------------------------------------------------------ */
/* 3. Canonicalization: $REPO whole-segment substitution              */
/* ------------------------------------------------------------------ */
describe('Subsystem 4 audit: $REPO canonicalization boundary', () => {
  it('replaces the repo root as a whole path segment (followed by space or separator)', () => {
    const raw = `The repo is at ${REPO} and files are in ${REPO}/src`;
    expect(canonicalizePrefixText(raw, REPO)).toBe(
      'The repo is at $REPO and files are in $REPO/src',
    );
  });

  it('does NOT substitute when the root is a prefix of a longer path segment', () => {
    // "projector" starts with the repo root but is a different directory.
    expect(canonicalizePrefixText(`${REPO}or/src/main.ts`, REPO)).toBe(`${REPO}or/src/main.ts`);
    // A sibling directory that merely has the root as a filename prefix must stay intact.
    expect(canonicalizePrefixText(`${REPO}.bak/x.ts`, REPO)).toBe(`${REPO}.bak/x.ts`);
    expect(canonicalizePrefixText(`${REPO}-backup/x.ts`, REPO)).toBe(`${REPO}-backup/x.ts`);
  });

  it('handles a trailing-slash root and an exact end-of-text match', () => {
    const withSlash = canonicalizePrefixText('path: ' + REPO, `${REPO}/`);
    expect(withSlash).toBe('path: $REPO');
    expect(canonicalizePrefixText(REPO, REPO)).toBe('$REPO');
  });

  it('normalizes NFC and CRLF before substitution', () => {
    const decomposed = `café\r\ntest\r\n${REPO}/x\r\n`;
    expect(canonicalizePrefixText(decomposed, REPO)).toBe('café\ntest\n$REPO/x\n');
  });
});

/* ------------------------------------------------------------------ */
/* 2. clampSlotTail / clampSlot edge cases                            */
/* ------------------------------------------------------------------ */
function longLivingState(): string {
  return Array.from({ length: 200 }, (_, i) => `entry ${i}`).join('\n');
}

describe('Subsystem 4 audit: clampSlotTail keeps the newest living state', () => {
  it('returns the input unchanged when it fits within the budget', () => {
    const text = 'entry 1\nentry 2';
    expect(clampSlotTail(text, 10_000)).toBe(text);
  });

  it('drops the oldest head and preserves the newest tail within budget', () => {
    const text = longLivingState();
    const maxChars = 500;
    const out = clampSlotTail(text, maxChars);
    expect(out.length).toBeLessThanOrEqual(maxChars);
    expect(out).toContain('...[slot-truncated: oldest dropped]');
    // The newest living-state entries must survive verbatim at the end.
    expect(out.endsWith(text.slice(-40))).toBe(true);
  });

  it('never exceeds the budget even for a budget smaller than the marker (edge case)', () => {
    const text = longLivingState();
    for (const maxChars of [0, 5, 10, 32, 33, 40]) {
      const out = clampSlotTail(text, maxChars);
      expect(out.length).toBeLessThanOrEqual(Math.max(0, maxChars));
    }
  });
});

describe('Subsystem 4 audit: clampSlot bounded truncation', () => {
  it('truncates the head and never exceeds the budget for tiny budgets', () => {
    const text = longLivingState();
    for (const maxChars of [0, 5, 10, 20, 24, 40]) {
      const out = clampSlot(text, maxChars);
      expect(out.length).toBeLessThanOrEqual(Math.max(0, maxChars));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 1. Strict 3-level hierarchy + frozen-prefix fingerprint            */
/* ------------------------------------------------------------------ */
function sampleTools(): ToolSpec[] {
  return [
    {
      name: 'read_file',
      description: 'Read file lines',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
    {
      name: 'bash',
      description: 'Run bash command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ];
}

const L0 = { systemPrompt: 'You are the omnexx worker agent.', tools: sampleTools() };
const L1 = {
  repoMap: 'src/core/loop.ts\nsrc/agent/context.ts',
  goal: 'Build high-performance coding agent runtime',
  facts: 'Node 22 ESM',
  repoRoot: REPO,
};

describe('Subsystem 4 audit: strict 3-level hierarchy (assembler)', () => {
  it('keeps dynamic Level-2 variables out of Level 0/Level 1 system blocks', () => {
    const assembler = new CacheOptimizedAssembler();
    const topology = assembler.assemble(L0, L1, {
      taskId: 'M1.T01',
      taskTitle: 'DO_THE_TASK',
      clock: 'CLOCK_VALUE_XY',
      edgeSummary: 'EDGE_SUMMARY_XY',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'convo' }] }],
    });

    const systemText = topology.system.map((b) => b.text).join('\n');
    expect(systemText).toContain('You are the omnexx worker agent.');
    expect(systemText).not.toContain('DO_THE_TASK');
    expect(systemText).not.toContain('CLOCK_VALUE_XY');
    expect(systemText).not.toContain('EDGE_SUMMARY_XY');
    // All Level 0/Level 1 blocks are non-volatile.
    expect(topology.system.every((b) => b.volatile === false)).toBe(true);
  });

  it('computes a stable frozen-prefix fingerprint across Level-2-only changes', () => {
    const assembler = new CacheOptimizedAssembler();
    const turn1 = assembler.assemble(L0, L1, {
      taskId: 'M1.T01',
      taskTitle: 'Bootstrap runtime',
      clock: '# Clock: Elapsed 10s',
      messages: [],
    });
    const turn2 = assembler.assemble(L0, L1, {
      taskId: 'M1.T01',
      taskTitle: 'Bootstrap runtime',
      clock: '# Clock: Elapsed 25s (pace: on track)',
      edgeSummary: 'Completed initial directory check',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Inspecting…' }] }],
    });

    expect(turn1.prefixHash).toHaveLength(64);
    expect(turn1.prefixHash).toBe(turn2.prefixHash);
  });

  it('changes the fingerprint when a Level-0/Level-1 block mutates', () => {
    const assembler = new CacheOptimizedAssembler();
    const base = assembler.assemble(L0, L1, { taskId: 'T', taskTitle: 't', messages: [] });
    const mutated = assembler.assemble({ ...L0, systemPrompt: 'You are a DIFFERENT worker.' }, L1, {
      taskId: 'T',
      taskTitle: 't',
      messages: [],
    });
    expect(mutated.prefixHash).not.toBe(base.prefixHash);
  });
});
