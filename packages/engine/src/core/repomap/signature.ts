/**
 * Collapse a possibly multi-line construct head into a single-line signature.
 *
 * Tree-sitter gives us the full node span; for the map we only want the head: parameters,
 * heritage clauses and return type, without the body. The algorithm accumulates lines from
 * the definition start until braces/parens balance at a logical boundary (or the text opens
 * a body), then collapses whitespace and caps the length. It is a rendering heuristic, not a
 * parser: best effort, deterministic, and always bounded.
 */

/** Characters that mean "more input is coming" — never stop after one of these. */
const CONTINUATION_TAIL = /[,=(<[{|&]$/;

const MAX_LINES = 12;

function balance(text: string, open: string, close: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === open) n += 1;
    else if (ch === close) n -= 1;
  }
  return n;
}

/** Collapse lines[startLine-1…] into one logical line, cutting at a body-opening brace. */
export function collapseSignature(
  lines: readonly string[],
  startLine: number,
  maxChars = 200,
): string {
  const start = Math.max(0, startLine - 1);
  let acc = '';
  const stopAt = Math.min(lines.length, start + MAX_LINES);
  for (let i = start; i < stopAt; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    acc = acc ? `${acc} ${line}` : line;
    const braceBalance = balance(acc, '{', '}');
    // Cut at the LAST '{': an object-typed parameter or generic (`Promise<{ … }>`) contains
    // braces of its own, and the body brace is always the final one on this line.
    const openBrace = acc.lastIndexOf('{');
    if (openBrace !== -1 && braceBalance > 0) {
      acc = acc.slice(0, openBrace);
      break;
    }
    const parensBalanced = balance(acc, '(', ')') <= 0 && balance(acc, '[', ']') <= 0;
    const bracesBalanced = braceBalance === 0;
    if (bracesBalanced && parensBalanced && !CONTINUATION_TAIL.test(acc)) break;
  }
  let out = acc.replace(/\s+/g, ' ').trim();
  // Drop dangling connectors left by a brace cut (`const f = {` → `const f =` → `const f`).
  // A trailing `=>` is kept: it marks the arrow, which is the useful part of the signature.
  out = out.replace(/[;,={]+\s*$/u, '').trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

/** Trim a reference line (single line of source) for display. */
export function collapseReference(line: string, maxChars = 160): string {
  const out = line.replace(/\s+/g, ' ').trim();
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}
