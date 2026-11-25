/**
 * Deterministic, zero-LLM-cost observation filter pipeline.
 *
 * Tool stdout/stderr is noisy: ANSI colours, spinner frames, hundreds of
 * passing-test lines, cascading duplicate build errors, thousand-line
 * search dumps. This module compresses that noise before it enters LLM
 * context while preserving 100% of actionable failure diagnostics
 * (failing test names, error codes, file:line references).
 *
 * Pipeline: universal pre-filters (ANSI, carriage-return frames, duplicate
 * consecutive lines) → format-aware extractor, auto-detected by command
 * or output signature (test runners, build/typecheck, directory/search)
 * → generic fallback that delegates to the existing
 * {@link condenseLog} (extended, not duplicated) → spill-to-disk when the
 * filtered output still exceeds the inline char budget.
 *
 * Pure except for the spill write. Never throws: a spill failure degrades
 * to returning the filtered text.
 *
 * Repo mapping: there is no HorizonTier in the tree yet (Wave 1 Task 1),
 * so `maxInlineChars` is a plain option (default 4,000); a tier will map
 * onto it when it lands. Like `condenseLog`, this module is not wired
 * into the runner — the interception point (the runner's tool-result
 * path) is a separate decision.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { condenseLog } from "./log-condenser";

export type ObservationKind = "test" | "build" | "search" | "generic";

/** Default inline budget: filtered output longer than this spills to disk. */
export const DEFAULT_MAX_INLINE_CHARS = 4000;
/** Base name for per-process spill directories created under os.tmpdir(). */
export const DEFAULT_SPILL_DIR = "swarm_obs";
/** Lines kept at the head/tail of a spilled output. */
export const SPILL_HEAD_LINES = 35;
export const SPILL_TAIL_LINES = 45;
/** Max search matches kept inline. */
export const SEARCH_MAX_INLINE_MATCHES = 60;
/** Max identical build errors kept per file. */
export const BUILD_MAX_IDENTICAL_PER_FILE = 5;
/** Max user-code stack frames kept per failure. */
export const TEST_MAX_STACK_FRAMES = 8;

export interface ObservationFilterInput {
  /** Command that produced the output (e.g. "npm test", "tsc --noEmit"). */
  command?: string;
  /** Raw stdout+stderr. */
  output: string;
  /** Turn id, for the spill filename (<turn_id>_<tool_id>.log). */
  turnId?: string;
  /** Tool id, for the spill filename. */
  toolId?: string;
  /** Inline char budget; default {@link DEFAULT_MAX_INLINE_CHARS}. */
  maxInlineChars?: number;
  /** Spill directory; default {@link DEFAULT_SPILL_DIR}. */
  spillDir?: string;
  /** When false, omit disk spill (e.g. VM outputs filtered on host) and truncate inline. */
  allowSpill?: boolean;
}

export interface ObservationFilterResult {
  kind: ObservationKind;
  /** Inline text for the LLM (possibly head/tail-cut with a spill pointer). */
  text: string;
  /** Path the raw output was spilled to, when it was. */
  spilledTo?: string;
  originalChars: number;
  filteredChars: number;
  /** Lines omitted by the spill head/tail cut (0 when nothing was cut). */
  linesOmitted: number;
}

/**
 * Outcome summary lines worth keeping even when the generic condenser
 * drops everything else (npm audit totals, build success): one line that
 * says what happened, not how.
 */
const OUTCOME_SUMMARY =
  /added \d+ packages?|audited \d+ packages?|found \d+ vulnerabilities?|Done in [\d.]+s|compiled successfully|Build succeeded/i;

// ---------------------------------------------------------------------------
// Universal pre-filters
// ---------------------------------------------------------------------------

// Built from char codes so the source contains no literal control characters
// (Sonar S6324).
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ANSI_RE = new RegExp(
  String.raw`${ESC}\[[0-9;]*[A-Za-z]|${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)`,
  "g",
);

/** Strip ANSI colour/cursor escapes and OSC sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Collapse carriage-return progress bars: a line's \r-separated frames keep
 * only the last non-blank frame (the spinner's final state).
 */
export function collapseCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const frames = line.split("\r").map((f) => f.trim()).filter(Boolean);
      return frames.at(-1) ?? "";
    })
    .join("\n");
}

const REPEAT_MARKER = (n: number): string => `[... repeated ${n} more time${n === 1 ? "" : "s"}]`;

/** Collapse runs of identical consecutive lines to one copy + a marker. */
export function dedupeConsecutiveLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]);
    if (j - i > 1) out.push(REPEAT_MARKER(j - i - 1));
    i = j;
  }
  return out.join("\n");
}

/** All three pre-filters, in order. */
export function preFilter(text: string): string {
  return dedupeConsecutiveLines(collapseCarriageReturns(stripAnsi(text)));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const TEST_COMMAND = /\b(jest|vitest|pytest|go test|cargo test|npm test|yarn test|pnpm test|bun test)\b/;
const BUILD_COMMAND = /\b(tsc|eslint|webpack|next build|vite build|rollup)\b/;
const SEARCH_COMMAND = /^\s*(ls|find|rg|ripgrep|grep|fd)\b/;

// Each signature splits into small patterns to avoid regex backtracking and to
// keep each one under the complexity budget (Sonar S2311 / S5327).
const TEST_SIGNATURE = [
  /(^|\n)\s*(PASS|FAIL)\s+\S/,
  /✓|✕|×/,
  /●[^\r\n\u2028\u2029]*›/,
  /--- (PASS|FAIL):/,
  /test [^\r\n\u2028\u2029]* \.\.\. (ok|FAILED)/,
  /test result: (ok|FAILED)/,
  /===[^\r\n\u2028\u2029]*\b(passed|failed)\b/,
];
const BUILD_SIGNATURE = [
  /error TS\d+/,
  /ERROR in /,
  /Failed to compile/,
  /:\d+:\d+[ \t]+error\b/,
  /✖[^\r\n\u2028\u2029]*\d+ problems?/,
];

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}
const RG_LINE = /^[^:\s][^:]*:\d+:/;

export function detectKind(command: string | undefined, lines: string[]): ObservationKind {
  if (command) {
    if (TEST_COMMAND.test(command)) return "test";
    if (BUILD_COMMAND.test(command)) return "build";
    if (SEARCH_COMMAND.test(command)) return "search";
  }
  const sample = lines.slice(0, 200).join("\n");
  if (matchesAny(TEST_SIGNATURE, sample)) return "test";
  if (matchesAny(BUILD_SIGNATURE, sample)) return "build";
  const rgHits = lines.filter((l) => RG_LINE.test(l)).length;
  if (lines.length >= 20 && rgHits / lines.length > 0.5) return "search";
  return "generic";
}

// ---------------------------------------------------------------------------
// Test-runner extractor
// ---------------------------------------------------------------------------

const PASS_LINE = /^\s*✓|^\s*PASS\b|PASSED\b|--- PASS:|test .* \.\.\. ok\b|^ok\s+\S/;
const FAIL_LINE = /^\s*[✕×]|^\s*FAIL\b|FAILED\b|--- FAIL:|test .* \.\.\. FAILED\b|^FAIL\s+\S/;
const FAIL_HEADER = [
  /^\s*●[^\r\n\u2028\u2029]*›/,
  /^\s*FAIL\s+\S/,
  /^_+ \S+ _+$/,
  /^\s*FAILURES?:?$/,
  /^\s*_{3,}/,
];
const SUMMARY_LINE = [
  /Tests:\s+\d+ (passed|failed)/,
  /Test Suites:/,
  /test result: (ok|FAILED)/,
  /===[^\r\n\u2028\u2029]*\b(passed|failed|error)\b[^\r\n\u2028\u2029]*===/,
  /Time:\s*[\d.]+ ?s/,
  /^\s*(ok|FAIL)\s+\S+\s+\d/,
];

function isSummaryLine(line: string): boolean {
  return matchesAny(SUMMARY_LINE, line);
}
const ASSERTION_LINE = /AssertionError|Expected|Received|Error:|assert\b|FAILED\s+\S+::|^\s*[>E]\s+\S/;
const STACK_FRAME = /^\s+at\s+/;
const INTERNAL_FRAME = /node_modules|site-packages|node:internal|internal\/|dist\/node_modules/;
const DURATION = /(?:Time|in)\s*(?::\s*)?(\d+(?:\.\d+)?)\s*s/;

interface TestTally {
  passed: number;
  failed: number;
  duration?: string;
}

interface TestExtractState {
  tally: TestTally;
  kept: string[];
  inFailure: boolean;
  userFrames: number;
  internalFrames: number;
}

function flushInternal(state: TestExtractState): void {
  if (state.internalFrames > 0) {
    state.kept.push(`[... ${state.internalFrames} internal frame${state.internalFrames === 1 ? "" : "s"} omitted]`);
    state.internalFrames = 0;
  }
}

/** Counts from a jest-style summary line; returns null when the line has none. */
function countSummaryCounts(line: string): { passed: number; failed: number } | null {
  const passedMatch = /(\d+)\s+passed/.exec(line);
  const failedMatch = /(\d+)\s+failed/.exec(line);
  if (!passedMatch && !failedMatch) return null;
  return {
    passed: passedMatch ? Number(passedMatch[1]) : 0,
    failed: failedMatch ? Number(failedMatch[1]) : 0,
  };
}

function buildTallyLine(tally: TestTally, total: number): string {
  if (total === 0) return "";
  const durationSuffix = tally.duration ? ` (${tally.duration})` : "";
  return `PASS: ${tally.passed}/${total} tests${durationSuffix}`;
}

function handleSummaryLine(state: TestExtractState, line: string): void {
  const duration = DURATION.exec(line)?.[1];
  if (duration && !state.tally.duration) state.tally.duration = `${duration}s`;
  // Counts from the summary win over line counting when both exist.
  const counts = countSummaryCounts(line);
  if (counts && (counts.passed > 0 || counts.failed > 0)) {
    state.tally.passed = Math.max(state.tally.passed, counts.passed);
    state.tally.failed = Math.max(state.tally.failed, counts.failed);
  }
}

function handleLine(state: TestExtractState, line: string): void {
  if (isSummaryLine(line)) {
    handleSummaryLine(state, line);
    state.kept.push(line);
    state.inFailure = false;
    return;
  }
  if (PASS_LINE.test(line) && !FAIL_LINE.test(line)) {
    state.tally.passed++;
    state.inFailure = false;
    return;
  }
  if (FAIL_LINE.test(line)) {
    state.tally.failed++;
    flushInternal(state);
    state.kept.push(line);
    state.inFailure = true;
    state.userFrames = 0;
    return;
  }
  if (matchesAny(FAIL_HEADER, line)) {
    flushInternal(state);
    state.kept.push(line);
    state.inFailure = true;
    state.userFrames = 0;
    return;
  }
  if (STACK_FRAME.test(line)) {
    if (INTERNAL_FRAME.test(line)) {
      state.internalFrames++;
    } else if (state.userFrames < TEST_MAX_STACK_FRAMES) {
      flushInternal(state);
      state.kept.push(line);
      state.userFrames++;
    }
    return;
  }
  if (state.inFailure || ASSERTION_LINE.test(line)) {
    flushInternal(state);
    state.kept.push(line);
  }
}

/** Collapse passing test lists to a tally; keep failure headers, assertion diffs and capped user-code frames. */
export function extractTest(lines: string[]): { text: string; tally: TestTally } | null {
  const state: TestExtractState = {
    tally: { passed: 0, failed: 0 },
    kept: [],
    inFailure: false,
    userFrames: 0,
    internalFrames: 0,
  };
  for (const line of lines) handleLine(state, line);
  flushInternal(state);

  if (state.tally.passed === 0 && state.tally.failed === 0 && state.kept.length === 0) return null;
  const total = state.tally.passed + state.tally.failed;
  const tallyLine = buildTallyLine(state.tally, total);
  const body = state.kept.filter((l) => !isSummaryLine(l));
  const summary = state.kept.filter((l) => isSummaryLine(l));
  const text = [tallyLine, ...body, ...summary].filter(Boolean).join("\n");
  return { text, tally: state.tally };
}

// ---------------------------------------------------------------------------
// Build / typecheck extractor
// ---------------------------------------------------------------------------

const TSC_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const ESLINT_ERROR = /^(.+?):(\d+):(\d+)\s+(error|warning)\s+(.+)$/;
const WEBPACK_ERROR = /^ERROR in (.+)$/;

const BUILD_LINE_RES = [
  /Failed to compile/,
  /error TS\d+/,
  /✖[^\r\n\u2028\u2029]*problems?/,
  /compiled with \d+ errors?/,
  /compiled successfully/,
];

/** Split an eslint message into the rule token (last whitespace-separated token) and the remainder. */
function ruleFromMessage(message: string): { rule: string; message: string } {
  const ruleMatch = /\s([a-z0-9@/-]+)$/.exec(message);
  if (ruleMatch) {
    return { rule: ruleMatch[1], message: message.slice(0, message.length - ruleMatch[0].length) };
  }
  return { rule: message, message };
}

/** Keep the header line plus its detail lines until a blank line. */
function collectWebpackBlock(lines: string[], startIndex: number, kept: string[]): number {
  let j = startIndex + 1;
  while (j < lines.length && lines[j].trim() !== "" && !WEBPACK_ERROR.test(lines[j])) {
    kept.push(lines[j]);
    j++;
  }
  return j;
}

/** Group errors by file+code, capping cascading identical errors per file. */
export function extractBuild(lines: string[]): { text: string } | null {
  const kept: string[] = [];
  const seen = new Map<string, number>();
  const omitted = new Map<string, number>();
  let found = false;

  const pushError = (key: string, line: string): void => {
    const count = seen.get(key) ?? 0;
    if (count < BUILD_MAX_IDENTICAL_PER_FILE) {
      kept.push(line);
      seen.set(key, count + 1);
    } else {
      omitted.set(key, (omitted.get(key) ?? 0) + 1);
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const tsc = TSC_ERROR.exec(line);
    if (tsc) {
      found = true;
      pushError(`${tsc[1]}|${tsc[4]}|${tsc[5]}`, line);
      i++;
      continue;
    }
    const eslint = ESLINT_ERROR.exec(line);
    if (eslint?.[4] === "error") {
      found = true;
      const { rule, message } = ruleFromMessage(eslint[5]);
      pushError(`${eslint[1]}|${rule}|${message}`, line);
      i++;
      continue;
    }
    const webpack = WEBPACK_ERROR.exec(line);
    if (webpack) {
      found = true;
      kept.push(line);
      // Keep the header plus its detail lines until a blank line.
      i = collectWebpackBlock(lines, i, kept);
      continue;
    }
    if (matchesAny(BUILD_LINE_RES, line)) {
      found = true;
      kept.push(line);
    }
    i++;
  }
  if (!found) return null;

  const omittedLines: string[] = [];
  for (const [key, count] of omitted) {
    const [file, code] = key.split("|");
    omittedLines.push(`[... ${count} more identical ${code} errors in ${file} omitted]`);
  }
  return { text: [...kept, ...omittedLines].join("\n") };
}

// ---------------------------------------------------------------------------
// Directory / search extractor
// ---------------------------------------------------------------------------

/** Cap inline matches at 60; append the exact total and a directory breakdown. */
export function extractSearch(lines: string[]): { text: string } {
  const matches = lines.filter((l) => l.trim() !== "");
  const total = matches.length;
  const shown = matches.slice(0, SEARCH_MAX_INLINE_MATCHES);
  const byDir = new Map<string, number>();
  for (const line of matches) {
    const file = line.split(":")[0];
    // Top-level directory: the breakdown is per area of the repo, not per leaf folder.
    const dir = file.includes("/") ? `${file.split("/")[0]}/` : "./";
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const breakdown = [...byDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir, count]) => `${dir} (${count})`)
    .join(", ");
  const footer =
    total > SEARCH_MAX_INLINE_MATCHES
      ? `[${total} total matches; showing first ${SEARCH_MAX_INLINE_MATCHES}. By directory: ${breakdown}]`
      : `[${total} total matches. By directory: ${breakdown}]`;
  return { text: [...shown, footer].join("\n") };
}

// ---------------------------------------------------------------------------
// Spill to disk
// ---------------------------------------------------------------------------

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
}

function spillPath(spillDir: string, turnId: string, toolId: string): string {
  return path.join(spillDir, `${sanitizeId(turnId)}_${sanitizeId(toolId)}.log`);
}

/** Write the raw output to disk; returns the path, or undefined on failure. */
function trySpill(
  spillDir: string | undefined,
  turnId: string,
  toolId: string,
  raw: string,
): string | undefined {
  try {
    // With no override, create a fresh private directory (mkdtemp) instead of
    // a predictable shared path under /tmp (Sonar S5443).
    const dir = spillDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `${DEFAULT_SPILL_DIR}-`));
    if (spillDir) fs.mkdirSync(spillDir, { recursive: true });
    const file = spillPath(dir, turnId, toolId);
    fs.writeFileSync(file, raw, "utf-8");
    return file;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function filterObservation(input: ObservationFilterInput): ObservationFilterResult {
  const originalChars = input.output.length;
  const maxInlineChars = input.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
  const spillDir = input.spillDir;
  const turnId = input.turnId ?? "turn-0";
  const toolId = input.toolId ?? "tool";

  const cleaned = preFilter(input.output);
  const lines = cleaned.split("\n");
  const kind = detectKind(input.command, lines);

  let filtered: string;
  if (kind === "test") {
    filtered = extractTest(lines)?.text ?? condenseLog(cleaned);
  } else if (kind === "build") {
    filtered = extractBuild(lines)?.text ?? condenseLog(cleaned);
  } else if (kind === "search") {
    filtered = extractSearch(lines).text;
  } else {
    filtered = condenseLog(cleaned);
    // The condenser keeps failure lines only; re-attach the one-line
    // outcome summary (install/build totals) when it dropped it.
    const summaries = lines.filter((l) => OUTCOME_SUMMARY.test(l) && !filtered.includes(l));
    if (summaries.length) filtered = `${filtered}\n${summaries.join("\n")}`;
  }

  // Spill: the raw output goes to disk (when allowed), the inline text is
  // head + tail of the filtered output plus a pointer/truncation marker.
  if (filtered.length > maxInlineChars) {
    const spilledTo = input.allowSpill === false ? undefined : trySpill(spillDir, turnId, toolId, input.output);
    const filteredLines = filtered.split("\n");
    const head = filteredLines.slice(0, SPILL_HEAD_LINES);
    const tail = filteredLines.slice(-SPILL_TAIL_LINES);
    // When head and tail overlap the output already fits in lines; the
    // pointer still names the spilled raw log.
    const shownLines =
      filteredLines.length <= SPILL_HEAD_LINES + SPILL_TAIL_LINES ? filteredLines : [...head, ...tail];
    const linesOmitted = Math.max(0, filteredLines.length - shownLines.length);
    const pointer = spilledTo
      ? `[TRUNCATED: ${linesOmitted} lines omitted. Full raw output saved at ${spilledTo} - use read_file_range or grep to inspect.]`
      : input.allowSpill === false
        ? `[TRUNCATED: ${linesOmitted} lines omitted (inline cap ${maxInlineChars} chars).]`
        : `[TRUNCATED: ${linesOmitted} lines omitted. Spill to ${spillDir ?? "the spill directory"} failed; full output unavailable.]`;
    let text = [...shownLines, pointer].join("\n");
    if (input.allowSpill === false && text.length > maxInlineChars) {
      const budget = Math.max(1, maxInlineChars - pointer.length - 1);
      text = `${shownLines.join("\n").slice(0, budget)}\n${pointer}`;
    }
    return {
      kind,
      text,
      spilledTo,
      originalChars,
      filteredChars: filtered.length,
      linesOmitted,
    };
  }

  return { kind, text: filtered, originalChars, filteredChars: filtered.length, linesOmitted: 0 };
}
