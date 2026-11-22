/**
 * AstSlicer for the L1 context packer: symbol outlines, line-window reads
 * and surgical text patches, all over in-memory source text.
 *
 * Ported from the Claude Code mini (vendor/claude-code-mini/src/astSlicer.ts,
 * npm claude-code-mini@0.3.0) with three deliberate changes:
 *   - Pure functions over `{ path, content }` instead of `fs` reads, because
 *     the harness's files live inside the user's VM. The caller reads them
 *     (vm exec, codebase store, tests) and hands the text in.
 *   - Every builder takes a token cap and is guaranteed to fit it, so the
 *     governor can hand each section a fixed slice of the 8,192-token turn.
 *   - applySlicePatch refuses ambiguous targets and never interprets `$`
 *     sequences in the replacement (String.prototype.replace would).
 *
 * Nothing here reads keys, env or the filesystem.
 */

import { estimateTokens } from "../../codebase/tokens";

/** One source file handed to the slicer. `path` is repo-relative. */
export interface SourceFile {
  path: string;
  content: string;
}

/** An inclusive 1-based line range. */
export interface LineRange {
  start: number;
  end: number;
}

export interface FileSlice {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** The slice rendered as `N | line` rows. */
  content: string;
}

/** One symbol found by the outline scan. */
export interface OutlineSymbol {
  line: number;
  exported: boolean;
  signature: string;
}

/** A file the working set should show, most important first. */
export interface WorkingSetItem extends SourceFile {
  /** Lines the agent is working on; windows are centred on these. */
  focus?: LineRange[];
  /** Higher first. Ties keep the caller's order. Default 0. */
  priority?: number;
}

/** What actually made it into a packed section. */
export interface SectionResult {
  text: string;
  tokens: number;
  /** Files (and the ranges shown) that are in `text`. */
  included: { path: string; ranges: LineRange[]; totalLines: number }[];
  /** Files that did not fit at all. */
  omitted: string[];
}

const SIGNATURE_RE =
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let|var|def|fn|pub\s+fn)\s+([A-Za-z0-9_$]+)/;

/**
 * TS/JS class/object method declarations. Deliberately excludes control-flow
 * keywords so `if (...) {` inside a body is not mistaken for a symbol.
 */
const METHOD_RE =
  /^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|abstract\s+|async\s+|get\s+|set\s+)*\*?\s*([A-Za-z_$#][A-Za-z0-9_$#]*)\s*(?:<[^>]*>)?\s*\(/;
const METHOD_CONTROL_FLOW = new Set(["if", "for", "while", "switch", "catch"]);

/** Max characters kept from a signature line (the mini used 80). */
const MAX_SIGNATURE_CHARS = 100;

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

/** Scan a file for top-level-ish declarations (functions, classes, types...). */
export function outlineSymbols(content: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  splitLines(content).forEach((line, idx) => {
    const match = line.match(SIGNATURE_RE);
    if (match) {
      // Indented const/let/var are locals inside a body, not symbols worth an
      // outline row (the mini listed them, which flooded outlines with noise).
      if (/^(const|let|var)$/.test(match[6]) && /^\s/.test(line)) return;
      out.push({
        line: idx + 1,
        exported: Boolean(match[1]),
        signature: line.trim().slice(0, MAX_SIGNATURE_CHARS),
      });
      return;
    }
    const method = line.match(METHOD_RE);
    if (!method) return;
    const name = method[1];
    if (METHOD_CONTROL_FLOW.has(name)) return;
    // Method declarations have a body/block; plain calls like `foo(x);` do not.
    if (!/[{:]/.test(line.slice(line.indexOf("(", line.indexOf(name)) + 1))) return;
    out.push({
      line: idx + 1,
      exported: false,
      signature: line.trim().slice(0, MAX_SIGNATURE_CHARS),
    });
  });
  return out;
}

/**
 * Compact outline of one file: a header plus `L<n>: <signature>` rows.
 * `maxSymbols` mirrors the mini's 35-symbol cap.
 */
export function getFileOutline(file: SourceFile, maxSymbols = 35): string {
  const total = splitLines(file.content).length;
  const symbols = outlineSymbols(file.content);
  if (symbols.length === 0) return `File: ${file.path} (${total} lines, no major symbols)`;
  const rows = symbols.slice(0, maxSymbols).map((s) => `L${s.line}: ${s.signature}`);
  const more = symbols.length > maxSymbols ? [`… ${symbols.length - maxSymbols} more symbols`] : [];
  return [`File: ${file.path} (${total} lines)`, ...rows, ...more].join("\n");
}

/** Read lines [startLine, endLine] (1-based, clamped) as numbered rows. */
export function readSlice(file: SourceFile, startLine: number, endLine: number): FileSlice {
  const lines = splitLines(file.content);
  const start = Math.max(1, Math.min(Math.floor(startLine), lines.length));
  const end = Math.max(start, Math.min(Math.floor(endLine), lines.length));
  const rows = lines.slice(start - 1, end).map((line, idx) => `${start + idx} | ${line}`);
  return { path: file.path, startLine: start, endLine: end, totalLines: lines.length, content: rows.join("\n") };
}

/** Thrown when a surgical patch cannot be applied unambiguously. */
export class SlicePatchError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "ambiguous" | "empty_target",
  ) {
    super(message);
    this.name = "SlicePatchError";
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Replace exactly one occurrence of `target` with `replacement` and return
 * the new content. Tries an exact match first, then a whitespace-tolerant
 * line match (protects against indentation drift in model output). Throws
 * SlicePatchError when the target is missing or matches more than once —
 * a patch that could land in two places must never be guessed.
 */
export function applySlicePatch(content: string, target: string, replacement: string): string {
  if (!target.trim()) throw new SlicePatchError("Patch target is empty.", "empty_target");

  const exact = countOccurrences(content, target);
  if (exact === 1) {
    const at = content.indexOf(target);
    return content.slice(0, at) + replacement + content.slice(at + target.length);
  }
  if (exact > 1) {
    throw new SlicePatchError(`Patch target matches ${exact} places; add surrounding lines.`, "ambiguous");
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const targetLines = target.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  const replacementLines = replacement.replace(/\r\n/g, "\n").split("\n");
  const hits: number[] = [];
  for (let i = 0; i + targetLines.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (lines[i + j].trim() !== targetLines[j]) {
        match = false;
        break;
      }
    }
    if (match) hits.push(i);
  }
  if (hits.length === 0) throw new SlicePatchError("Patch target not found.", "not_found");
  if (hits.length > 1) {
    throw new SlicePatchError(`Patch target matches ${hits.length} places; add surrounding lines.`, "ambiguous");
  }
  const i = hits[0];
  return [...lines.slice(0, i), ...replacementLines, ...lines.slice(i + targetLines.length)].join(eol);
}

/**
 * Build the AST skeleton section: outlines of every file, cut to `cap`
 * tokens. Degrades in steps so the most useful signal survives longest:
 * full outlines → exported symbols only, as many per file as fit → one
 * header line per file → files dropped (listed as omitted).
 */
export function buildSkeleton(files: SourceFile[], cap: number): SectionResult {
  if (files.length === 0) return { text: "", tokens: 0, included: [], omitted: [] };
  if (cap <= 0) return { text: "", tokens: 0, included: [], omitted: files.map((f) => f.path) };

  const meta = files.map((file) => {
    const symbols = outlineSymbols(file.content);
    return {
      file,
      totalLines: splitLines(file.content).length,
      all: symbols,
      exported: symbols.filter((s) => s.exported),
    };
  });

  /** Render every file with at most `k` symbols each from `pick`. */
  const render = (pick: "all" | "exported", k: number): string =>
    meta
      .map((m) => {
        const list = m[pick];
        const rows = list.slice(0, k).map((s) => `L${s.line}: ${s.signature}`);
        const more = list.length > k && k > 0 ? [`… ${list.length - k} more`] : [];
        return [`File: ${m.file.path} (${m.totalLines} lines)`, ...rows, ...more].join("\n");
      })
      .join("\n\n");

  const included = (kept: typeof meta) => kept.map((m) => ({ path: m.file.path, ranges: [], totalLines: m.totalLines }));
  const done = (text: string, kept = meta): SectionResult => ({
    text,
    tokens: estimateTokens(text),
    included: included(kept),
    omitted: meta.slice(kept.length).map((m) => m.file.path),
  });

  const MAX_K = 35;
  const full = render("all", MAX_K);
  if (estimateTokens(full) <= cap) return done(full);

  // Exported symbols only, with the largest per-file count that fits.
  let lo = 0;
  let hi = MAX_K;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(render("exported", mid)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  const exported = render("exported", lo);
  if (estimateTokens(exported) <= cap) return done(exported);

  // Even one header per file is too much: keep as many headers as fit.
  const headers = meta.map((m) => `File: ${m.file.path} (${m.totalLines} lines)`);
  let n = 0;
  while (n < headers.length && estimateTokens(headers.slice(0, n + 1).join("\n")) <= cap) n++;
  return done(headers.slice(0, n).join("\n"), meta.slice(0, n));
}

/** Merge overlapping/adjacent ranges and clamp them to [1, total]. */
export function mergeRanges(ranges: LineRange[], total: number): LineRange[] {
  const clamped = ranges
    .map((r) => ({ start: Math.max(1, Math.min(r.start, r.end)), end: Math.min(total, Math.max(r.start, r.end)) }))
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start - b.start);
  const out: LineRange[] = [];
  for (const r of clamped) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function renderWindows(file: SourceFile, ranges: LineRange[], totalLines: number): string {
  const parts = ranges.map((r) => readSlice(file, r.start, r.end).content);
  const shown = ranges.map((r) => `L${r.start}-${r.end}`).join(", ");
  const whole = ranges.length === 1 && ranges[0].start === 1 && ranges[0].end === totalLines;
  const header = whole ? `### ${file.path} (${totalLines} lines)` : `### ${file.path} (${shown} of ${totalLines})`;
  return [header, parts.join("\n…\n")].join("\n");
}

/** Context padding tried around focus lines, widest first. */
const FOCUS_PADDING = [60, 30, 15, 6, 2, 0];

/**
 * Largest window [from, k] of `file` whose rendering fits `cap`, or null
 * when not even the first line does.
 */
function fitWindowFrom(
  file: SourceFile,
  from: number,
  totalLines: number,
  cap: number,
): { text: string; range: LineRange } | null {
  const start = Math.max(1, Math.min(from, totalLines));
  let lo = start - 1;
  let hi = totalLines;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(renderWindows(file, [{ start, end: mid }], totalLines)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  if (lo < start) return null;
  const range = { start, end: lo };
  return { text: renderWindows(file, [range], totalLines), range };
}

/**
 * Build the working-set section: the files the agent is editing, numbered,
 * cut to `cap` tokens. Items go in priority order; each gets the whole file
 * when it fits, else windows around its focus lines (padding shrinks until
 * they fit), else the largest head window that fits. Anything left over is
 * listed in `omitted` so the ledger can tell the agent to request it.
 */
export function buildWorkingSet(items: WorkingSetItem[], cap: number): SectionResult {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0) || a.index - b.index)
    .map((x) => x.item);

  const blocks: string[] = [];
  const included: SectionResult["included"] = [];
  const omitted: string[] = [];
  const SEP = "\n\n";

  const used = () => (blocks.length ? estimateTokens(blocks.join(SEP)) : 0);

  for (const item of ordered) {
    const totalLines = splitLines(item.content).length;
    // Charge the separator honestly by measuring the joined text.
    const fits = (text: string) => estimateTokens([...blocks, text].join(SEP)) <= cap;
    const remaining = cap - used();

    const whole = renderWindows(item, [{ start: 1, end: totalLines }], totalLines);
    if (fits(whole)) {
      blocks.push(whole);
      included.push({ path: item.path, ranges: [{ start: 1, end: totalLines }], totalLines });
      continue;
    }

    let placed = false;
    const focus = item.focus ?? [];
    if (focus.length > 0) {
      for (const pad of FOCUS_PADDING) {
        const ranges = mergeRanges(
          focus.map((f) => ({ start: f.start - pad, end: f.end + pad })),
          totalLines,
        );
        const text = renderWindows(item, ranges, totalLines);
        if (fits(text)) {
          blocks.push(text);
          included.push({ path: item.path, ranges, totalLines });
          placed = true;
          break;
        }
      }
    }
    if (!placed && remaining > 0) {
      // Not even the tightest focus windows fit (or there is no focus): show
      // the largest window from the first focus line (or line 1) that does.
      const from = focus.length > 0 ? Math.min(...focus.map((f) => Math.min(f.start, f.end))) : 1;
      const window = fitWindowFrom(item, from, totalLines, remaining - (blocks.length ? estimateTokens(SEP) + 1 : 0));
      if (window && fits(window.text)) {
        blocks.push(window.text);
        included.push({ path: item.path, ranges: [window.range], totalLines });
        placed = true;
      }
    }
    if (!placed) omitted.push(item.path);
  }

  const text = blocks.join(SEP);
  return { text, tokens: estimateTokens(text), included, omitted };
}
