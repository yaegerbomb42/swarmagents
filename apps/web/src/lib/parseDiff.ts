export type DiffLineType = 'add' | 'del' | 'context' | 'hunk';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  lineNo?: number;
}

export interface FileDiff {
  filename: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Parses a unified diff string into structured additions, deletions, and context lines. */
export function parseDiff(filename: string, diffText: string): FileDiff {
  const lines = diffText.split('\n');
  const parsedLines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let lineNo = 1;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      parsedLines.push({ type: 'hunk', content: line });
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
      parsedLines.push({ type: 'add', lineNo: lineNo++, content: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
      parsedLines.push({ type: 'del', content: line.slice(1) });
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      parsedLines.push({ type: 'context', content: line });
    } else {
      parsedLines.push({
        type: 'context',
        lineNo: lineNo++,
        content: line.startsWith(' ') ? line.slice(1) : line,
      });
    }
  }

  return { filename, additions, deletions, lines: parsedLines };
}

type LineDiffOp = { type: 'equal' | 'add' | 'del'; line: string };

/** Line-level diff between two file bodies (LCS backtrack). */
export function diffLineOps(before: string, after: string): LineDiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const stack: LineDiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      stack.push({ type: 'equal', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'add', line: b[j - 1] });
      j--;
    } else {
      stack.push({ type: 'del', line: a[i - 1] });
      i--;
    }
  }
  return stack.reverse();
}

/** Builds a unified diff string from saved vs edited workspace file content. */
export function buildUnifiedDiff(filename: string, before: string, after: string): string {
  if (before === after) return '';
  const ops = diffLineOps(before, after);
  const body = ops
    .map((op) => {
      if (op.type === 'equal') return ` ${op.line}`;
      if (op.type === 'add') return `+${op.line}`;
      return `-${op.line}`;
    })
    .join('\n');
  return `--- a/${filename}\n+++ b/${filename}\n@@ workspace edit @@\n${body}`;
}

/** Reconstructs a unified diff patch from parsed lines (for copy-to-clipboard). */
export function toUnifiedPatch(diff: FileDiff, raw?: string): string {
  if (raw?.trim()) return raw;
  const body = diff.lines
    .map((l) => {
      if (l.type === 'add') return `+${l.content}`;
      if (l.type === 'del') return `-${l.content}`;
      if (l.type === 'hunk') return l.content;
      return l.content ? ` ${l.content}` : '';
    })
    .join('\n');
  return `--- a/${diff.filename}\n+++ b/${diff.filename}\n${body}`;
}
