import { describe, expect, it } from 'vitest';
import {
  condense,
  emptyNote,
  MAX_THREADS,
  parseRollingNote,
  renderRollingNote,
  ROLLING_NOTE_CHAR_CAP,
  shouldCondense,
  type RollingNote,
  type RollingThread,
} from './rolling-memory.js';

function priorWithThreads(count: number): RollingNote {
  const threads: RollingThread[] = Array.from({ length: count }, (_, i) => ({
    line: `thread ${i + 1}`,
    turn: i + 1,
  }));
  return { ...emptyNote('goal', 0), threads, coversTo: count };
}

describe('renderRollingNote', () => {
  it('never exceeds the character cap, even with thousands of threads', () => {
    const note = priorWithThreads(5_000);
    const rendered = renderRollingNote(note);
    expect(rendered.length).toBeLessThanOrEqual(ROLLING_NOTE_CHAR_CAP);
    expect(rendered).toMatch(/older threads?/);
    expect(rendered).toContain('recall them from logs/transcript.md');
  });

  it('round-trips the goal, decisions and collapse count', () => {
    const note: RollingNote = {
      ...emptyNote('ship the thing', 12),
      decisions: ['use sqlite'],
      failed: ['npx tsc timed out'],
      threads: [{ line: 'read a.ts', turn: 3 }],
      collapsed: { count: 7, fromTurn: 1, toTurn: 2 },
    };
    const parsed = parseRollingNote(renderRollingNote(note));
    expect(parsed?.goal).toBe('ship the thing');
    expect(parsed?.decisions).toEqual(['use sqlite']);
    expect(parsed?.failed).toEqual(['npx tsc timed out']);
    expect(parsed?.collapsed).toEqual({ count: 7, fromTurn: 1, toTurn: 2 });
  });
});

describe('condense', () => {
  it('bounds the in-memory thread list and records what it collapsed', async () => {
    const note = await condense([], priorWithThreads(MAX_THREADS + 100), {
      goal: 'goal',
      turn: 10,
      headLastTurn: 5,
    });
    expect(note.threads).toHaveLength(MAX_THREADS);
    expect(note.collapsed).toEqual({ count: 100, fromTurn: 1, toTurn: 100 });
    // Newest threads are the ones kept.
    expect(note.threads[0]?.turn).toBe(MAX_THREADS + 100);
    expect(note.threads.at(-1)?.turn).toBe(101);
  });

  it('accumulates the collapse counter across condensations instead of dropping it', async () => {
    const first = await condense([], priorWithThreads(MAX_THREADS + 50), {
      goal: 'goal',
      turn: 10,
      headLastTurn: 5,
    });
    const second = await condense([], first, {
      goal: 'goal',
      turn: 20,
      headLastTurn: 15,
    });
    expect(second.threads.length).toBeLessThanOrEqual(MAX_THREADS);
    expect(second.collapsed?.count).toBe(50);
    // The rendered note still accounts for at least all threads collapsed in memory.
    const parsed = parseRollingNote(renderRollingNote(second));
    expect(parsed?.collapsed?.count).toBeGreaterThanOrEqual(50);
  });
});

describe('shouldCondense', () => {
  it('folds on the configured cadence', () => {
    expect(shouldCondense(19, 0, 20)).toBe(false);
    expect(shouldCondense(20, 0, 20)).toBe(true);
    expect(shouldCondense(40, 20, 20)).toBe(true);
  });
});
