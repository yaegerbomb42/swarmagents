/**
 * Pure line-diff model for the split-diff viewer (Phase 9, roadmap 9.3):
 * deterministic line-based diff plus context folding, with NO `vscode` and
 * NO DOM imports, so it is shared by the webview bundle and unit tests.
 *
 * Line model: CRLF is normalized to LF, and a trailing newline does not
 * create a phantom empty line, so `a\nb\n` and `a\nb` diff as identical.
 * The diff trims the common prefix/suffix first, then runs an LCS dynamic
 * program on the changed middle; a middle too large for a full table
 * (over ~4M cells) falls back to a whole-block replace, so pathological
 * inputs stay bounded instead of blowing up memory.
 *
 * Folding: an unchanged run LONGER than FOLD_THRESHOLD (6) lines folds into
 * one banner row. Each click on the banner reveals FOLD_REVEAL (3) lines at
 * the top edge and 3 at the bottom edge of the remaining run; when the
 * remaining run is FOLD_THRESHOLD lines or fewer, the fold unfolds fully.
 */
export type DiffKind = 'unchanged' | 'added' | 'removed';

export interface DiffHunk {
  kind: DiffKind;
  lines: string[];
  /**
   * 1-based start of the hunk in the original. For a pure insertion (no old
   * lines) this is the number of the old line the new lines land before
   * (one past the end when appending).
   */
  oldStart: number;
  /**
   * 1-based start of the hunk in the proposed text. For a pure deletion this
   * is the number of the new line the removed lines sat before.
   */
  newStart: number;
}

/** One visible diff line, with its 1-based number on each side (null = absent). */
export interface DiffLine {
  kind: DiffKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** One folded unchanged run: hidden lines plus how many edges are revealed. */
export interface FoldState {
  id: number;
  lines: string[];
  oldStart: number;
  newStart: number;
  revealedTop: number;
  revealedBottom: number;
}

export type ViewRow =
  { type: 'line'; line: DiffLine } | { type: 'fold'; foldId: number; count: number };

export interface FoldedView {
  rows: ViewRow[];
  folds: FoldState[];
}

/** Unchanged runs longer than this fold; runs of this length or fewer stay open. */
export const FOLD_THRESHOLD = 6;
/** Lines revealed at each edge of a folded run per click. */
export const FOLD_REVEAL = 3;

/** Largest LCS table (cells) before falling back to a whole-block replace. */
const MAX_DP_CELLS = 4_000_000;

/** Split into lines: CRLF normalized, no phantom line from a trailing newline. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.replace(/\r\n?/g, '\n').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

type Op = ' ' | '-' | '+';

/** LCS edit script for the two middles, as a sequence of keep/remove/add ops. */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((): Op => '+');
  if (m === 0) return a.map((): Op => '-');
  if ((n + 1) * (m + 1) > MAX_DP_CELLS) {
    return [...a.map((): Op => '-'), ...b.map((): Op => '+')];
  }
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      // Uint32Array reads are `number | undefined` under noUncheckedIndexedAccess.
      const diag = dp[(i - 1) * width + (j - 1)] ?? 0;
      const up = dp[(i - 1) * width + j] ?? 0;
      const left = dp[i * width + (j - 1)] ?? 0;
      dp[i * width + j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(up, left);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push(' ');
      i--;
      j--;
    } else if (
      j > 0 &&
      (i === 0 || (dp[i * width + (j - 1)] ?? 0) >= (dp[(i - 1) * width + j] ?? 0))
    ) {
      ops.push('+');
      j--;
    } else {
      ops.push('-');
      i--;
    }
  }
  ops.reverse();
  return ops;
}

/** The DiffLines of one hunk, with 1-based numbers on each side. */
function hunkLines(hunk: DiffHunk): DiffLine[] {
  return hunk.lines.map((text, index): DiffLine => {
    if (hunk.kind === 'unchanged') {
      return {
        kind: 'unchanged',
        oldLine: hunk.oldStart + index,
        newLine: hunk.newStart + index,
        text,
      };
    }
    if (hunk.kind === 'removed') {
      return { kind: 'removed', oldLine: hunk.oldStart + index, newLine: null, text };
    }
    return { kind: 'added', oldLine: null, newLine: hunk.newStart + index, text };
  });
}

/** Line-based diff of two texts, as hunks with 1-based starts on each side. */
export function computeDiff(original: string, proposed: string): DiffHunk[] {
  const oldLines = splitLines(original);
  const newLines = splitLines(proposed);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const ops = diffOps(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
  );

  const hunks: DiffHunk[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  const pushLine = (kind: DiffKind, text: string): void => {
    const last = hunks[hunks.length - 1];
    if (last?.kind === kind) {
      last.lines.push(text);
    } else {
      hunks.push({ kind, lines: [text], oldStart: oldCursor + 1, newStart: newCursor + 1 });
    }
    if (kind === 'unchanged') {
      oldCursor++;
      newCursor++;
    } else if (kind === 'removed') {
      oldCursor++;
    } else {
      newCursor++;
    }
  };
  for (let i = 0; i < prefix; i++) pushLine('unchanged', oldLines[i] ?? '');
  for (const op of ops) {
    if (op === ' ') {
      pushLine('unchanged', oldLines[oldCursor] ?? '');
    } else if (op === '-') {
      pushLine('removed', oldLines[oldCursor] ?? '');
    } else {
      pushLine('added', newLines[newCursor] ?? '');
    }
  }
  for (let i = 0; i < suffix; i++)
    pushLine('unchanged', oldLines[oldLines.length - suffix + i] ?? '');
  return hunks;
}

/** Ordered diff lines: `-` removed, `+` added, context in between, in order. */
export function unifiedLines(hunks: readonly DiffHunk[]): DiffLine[] {
  return hunks.flatMap((hunk) => hunkLines(hunk));
}

/** Aligned rows for a side-by-side table: an added line pairs with null old. */
export function sideBySideRows(hunks: readonly DiffHunk[]): {
  old: string | null;
  new: string | null;
}[] {
  const rows: { old: string | null; new: string | null }[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === 'unchanged') {
      for (const text of hunk.lines) rows.push({ old: text, new: text });
    } else if (hunk.kind === 'removed') {
      for (const text of hunk.lines) rows.push({ old: text, new: null });
    } else {
      for (const text of hunk.lines) rows.push({ old: null, new: text });
    }
  }
  return rows;
}

/**
 * Folded view of hunks: unchanged runs longer than FOLD_THRESHOLD become a
 * single banner row; shorter runs (and all changed lines) stay as line rows.
 */
export function buildFoldedView(hunks: readonly DiffHunk[]): FoldedView {
  const rows: ViewRow[] = [];
  const folds: FoldState[] = [];
  let foldId = 0;
  for (const hunk of hunks) {
    if (hunk.kind === 'unchanged' && hunk.lines.length > FOLD_THRESHOLD) {
      const id = foldId++;
      folds.push({
        id,
        lines: [...hunk.lines],
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        revealedTop: 0,
        revealedBottom: 0,
      });
      rows.push({ type: 'fold', foldId: id, count: hunk.lines.length });
    } else {
      for (const line of hunkLines(hunk)) rows.push({ type: 'line', line });
    }
  }
  return { rows, folds };
}

/**
 * Expand one fold by FOLD_REVEAL lines at each edge. When the remaining
 * folded run is FOLD_THRESHOLD lines or fewer it unfolds fully into line
 * rows and the fold disappears. Pure: returns a new view, input untouched.
 * Unknown fold ids return the view unchanged.
 */
export function expandFold(view: FoldedView, foldId: number): FoldedView {
  const fold = view.folds.find((f) => f.id === foldId);
  if (!fold) return view;
  const rowIndex = view.rows.findIndex((r) => r.type === 'fold' && r.foldId === foldId);
  if (rowIndex < 0) return view;
  const revealTop = fold.revealedTop + FOLD_REVEAL;
  const revealBottom = fold.revealedBottom + FOLD_REVEAL;
  const remaining = fold.lines.length - revealTop - revealBottom;

  const sliceLines = (from: number, count: number): DiffLine[] =>
    fold.lines.slice(from, from + count).map((text, index): DiffLine => ({
      kind: 'unchanged',
      oldLine: fold.oldStart + from + index,
      newLine: fold.newStart + from + index,
      text,
    }));

  if (remaining <= FOLD_THRESHOLD) {
    // Unfolds fully: only the still-hidden middle is spliced in — the
    // already-revealed edge lines are rows already, so splicing the whole
    // run would duplicate them.
    const hiddenStart = fold.revealedTop;
    const hiddenEnd = fold.lines.length - fold.revealedBottom;
    const rows = [...view.rows];
    rows.splice(
      rowIndex,
      1,
      ...fold.lines.slice(hiddenStart, hiddenEnd).map((text, index): ViewRow => ({
        type: 'line',
        line: {
          kind: 'unchanged',
          oldLine: fold.oldStart + hiddenStart + index,
          newLine: fold.newStart + hiddenStart + index,
          text,
        },
      })),
    );
    return { rows, folds: view.folds.filter((f) => f.id !== foldId) };
  }

  const updated: FoldState = { ...fold, revealedTop: revealTop, revealedBottom: revealBottom };
  const segment: ViewRow[] = [
    ...sliceLines(fold.revealedTop, FOLD_REVEAL).map((line): ViewRow => ({ type: 'line', line })),
    { type: 'fold', foldId, count: remaining },
    ...sliceLines(fold.lines.length - revealBottom, FOLD_REVEAL).map((line): ViewRow => ({
      type: 'line',
      line,
    })),
  ];
  const rows = [...view.rows];
  rows.splice(rowIndex, 1, ...segment);
  return {
    rows,
    folds: view.folds.map((f) => (f.id === foldId ? updated : f)),
  };
}
