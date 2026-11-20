import { describe, expect, it } from 'vitest';
import {
  buildFoldedView,
  computeDiff,
  expandFold,
  sideBySideRows,
  splitLines,
  unifiedLines,
  type FoldedView,
} from '../../vscode/src/diff-model.js';

/** `['L1', 'L2', …]` — a numbered file of n lines. */
const lines = (n: number, prefix = 'L'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const text = (ls: readonly string[]): string => ls.join('\n');

/** Fold banner counts in view order. */
const foldCounts = (view: FoldedView): number[] => {
  const counts: number[] = [];
  for (const row of view.rows) if (row.type === 'fold') counts.push(row.count);
  return counts;
};

/** Visible line texts in view order. */
const lineTexts = (view: FoldedView): string[] => {
  const texts: string[] = [];
  for (const row of view.rows) if (row.type === 'line') texts.push(row.line.text);
  return texts;
};

describe('splitLines', () => {
  it('splits on newlines and drops the phantom line after a trailing newline', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('normalizes CRLF and lone CR', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\rb')).toEqual(['a', 'b']);
  });
});

describe('computeDiff', () => {
  it('produces hunks for add/remove/unchanged with 1-based starts', () => {
    expect(computeDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'unchanged', lines: ['a'], oldStart: 1, newStart: 1 },
      { kind: 'removed', lines: ['b'], oldStart: 2, newStart: 2 },
      { kind: 'added', lines: ['x'], oldStart: 3, newStart: 2 },
      { kind: 'unchanged', lines: ['c'], oldStart: 3, newStart: 3 },
    ]);
  });

  it('returns only an unchanged hunk for identical texts, trailing newline included', () => {
    expect(computeDiff('a\nb\n', 'a\nb')).toEqual([
      { kind: 'unchanged', lines: ['a', 'b'], oldStart: 1, newStart: 1 },
    ]);
    expect(computeDiff('', '')).toEqual([]);
  });

  it('handles empty original and proposed', () => {
    expect(computeDiff('', 'x\ny')).toEqual([
      { kind: 'added', lines: ['x', 'y'], oldStart: 1, newStart: 1 },
    ]);
    expect(computeDiff('x\ny', '')).toEqual([
      { kind: 'removed', lines: ['x', 'y'], oldStart: 1, newStart: 1 },
    ]);
  });

  it('normalizes CRLF before diffing', () => {
    expect(computeDiff('a\r\nb\r\n', 'a\nb\nc\n')).toEqual([
      { kind: 'unchanged', lines: ['a', 'b'], oldStart: 1, newStart: 1 },
      { kind: 'added', lines: ['c'], oldStart: 3, newStart: 3 },
    ]);
  });

  it('treats a trailing blank line as a real added line', () => {
    expect(computeDiff('a\n', 'a\n\n')).toEqual([
      { kind: 'unchanged', lines: ['a'], oldStart: 1, newStart: 1 },
      { kind: 'added', lines: [''], oldStart: 2, newStart: 2 },
    ]);
  });

  it('keeps repeated lines aligned by position, not by content', () => {
    const hunks = computeDiff('x\nx\nx', 'x\nx');
    expect(hunks).toEqual([
      { kind: 'unchanged', lines: ['x', 'x'], oldStart: 1, newStart: 1 },
      { kind: 'removed', lines: ['x'], oldStart: 3, newStart: 3 },
    ]);
  });
});

describe('folding', () => {
  it('keeps unchanged runs of 6 or fewer lines expanded', () => {
    const old = lines(13);
    const next = [...old];
    next[6] = 'CHANGED';
    const view = buildFoldedView(computeDiff(text(old), text(next)));
    expect(foldCounts(view)).toEqual([]);
    expect(view.folds).toEqual([]);
    // 12 unchanged + 1 removed + 1 added.
    expect(lineTexts(view)).toHaveLength(14);
  });

  it('folds unchanged runs longer than 6 with the folded count', () => {
    const old = lines(15);
    const next = [...old];
    next[7] = 'CHANGED';
    const view = buildFoldedView(computeDiff(text(old), text(next)));
    expect(foldCounts(view)).toEqual([7, 7]);
    expect(view.folds.map((f) => f.lines.length)).toEqual([7, 7]);
  });

  it('expands exactly 3 lines at each edge and updates the remaining count', () => {
    const old = lines(30);
    const next = [...old];
    next[14] = 'CHANGED';
    const folded = buildFoldedView(computeDiff(text(old), text(next)));
    expect(foldCounts(folded)).toEqual([14, 15]);
    const expanded = expandFold(folded, 0);
    expect(foldCounts(expanded)).toEqual([8, 15]);
    const rows = expanded.rows;
    expect(rows[0]).toEqual({
      type: 'line',
      line: { kind: 'unchanged', oldLine: 1, newLine: 1, text: 'L1' },
    });
    expect(rows[2]).toEqual({
      type: 'line',
      line: { kind: 'unchanged', oldLine: 3, newLine: 3, text: 'L3' },
    });
    expect(rows[3]).toEqual({ type: 'fold', foldId: 0, count: 8 });
    expect(rows[4]).toEqual({
      type: 'line',
      line: { kind: 'unchanged', oldLine: 12, newLine: 12, text: 'L12' },
    });
    expect(rows[6]).toEqual({
      type: 'line',
      line: { kind: 'unchanged', oldLine: 14, newLine: 14, text: 'L14' },
    });
    // The changed lines follow the first fold, in order.
    expect(lineTexts(expanded).slice(6, 8)).toEqual(['L15', 'CHANGED']);
  });

  it('unfolds fully once the remaining run is 6 lines or fewer', () => {
    const old = lines(30);
    const next = [...old];
    next[14] = 'CHANGED';
    const folded = buildFoldedView(computeDiff(text(old), text(next)));
    const twice = expandFold(expandFold(folded, 0), 0);
    expect(foldCounts(twice)).toEqual([15]);
    expect(twice.folds.map((f) => f.id)).toEqual([1]);
    expect(lineTexts(twice).slice(0, 14)).toEqual(lines(14));
  });

  it('unfolds a 7-line run on the first click (3 + 3 leaves 1)', () => {
    const old = lines(15);
    const next = [...old];
    next[7] = 'CHANGED';
    const folded = buildFoldedView(computeDiff(text(old), text(next)));
    const expanded = expandFold(folded, 0);
    expect(foldCounts(expanded)).toEqual([7]);
    expect(lineTexts(expanded).slice(0, 7)).toEqual(lines(7));
  });

  it('does not mutate the input view and ignores unknown fold ids', () => {
    const old = lines(30);
    const next = [...old];
    next[14] = 'CHANGED';
    const folded = buildFoldedView(computeDiff(text(old), text(next)));
    const expanded = expandFold(folded, 0);
    expect(foldCounts(folded)).toEqual([14, 15]);
    expect(folded.folds[0]?.revealedTop).toBe(0);
    expect(expandFold(folded, 99)).toBe(folded);
    expect(expanded).not.toBe(folded);
  });
});

describe('sideBySideRows', () => {
  it('pairs unchanged lines and nulls the empty side for adds and removes', () => {
    expect(sideBySideRows(computeDiff('a\nb\nc', 'a\nx\nc'))).toEqual([
      { old: 'a', new: 'a' },
      { old: 'b', new: null },
      { old: null, new: 'x' },
      { old: 'c', new: 'c' },
    ]);
  });
});

describe('unifiedLines', () => {
  it('orders removed lines before added lines, with line numbers', () => {
    expect(unifiedLines(computeDiff('a\nb\nc', 'a\nx\nc'))).toEqual([
      { kind: 'unchanged', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'removed', oldLine: 2, newLine: null, text: 'b' },
      { kind: 'added', oldLine: null, newLine: 2, text: 'x' },
      { kind: 'unchanged', oldLine: 3, newLine: 3, text: 'c' },
    ]);
  });
});
