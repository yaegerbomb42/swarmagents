/**
 * What a rejected candidate leaves behind for the retry: only the
 * diagnostic and the definition of the symbol it names. The failed patch
 * itself is evicted — feeding a broken attempt back in just anchors the
 * next try on it.
 */

import { makeRedactor } from "../redact";

const redactPatterns = makeRedactor({});

/** CSI (colour/cursor, e.g. SGR "\x1b[31m") and OSC (title/hyperlink) sequences. */
// Built from char codes so the source contains no literal control characters
// (Sonar S6324).
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ANSI_ESCAPE = new RegExp(
  String.raw`${ESC}(?:\[[0-?]*[ -/]*[@-~]|\][^${BEL}]*(?:${BEL}|${ESC}\\))`,
  "g",
);

/** Lines that carry the actual failure in tsc / eslint / node:test / generic output. */
const ERROR_LINE_RES: readonly RegExp[] = [
  /error TS\d+:/,
  /^\s*\d+:\d+\s+error\s/,
  /^not ok \d+/,
  /AssertionError|Error:|ERR_[A-Z_]+/,
  /^\s*(expected|actual):/,
  /^\s+at .+:\d+:\d+\)?$/,
  /^error:|^fatal:/i,
];

/**
 * Keep the lines that matter (error lines plus one line of context after
 * each), redact secrets, and bound the size. Falls back to the output tail
 * when nothing looks like an error line.
 */
export function extractDiagnostic(output: string, maxChars = 2000): string {
  const clean = redactPatterns(output.replace(ANSI_ESCAPE, ""));
  const lines = clean.split("\n");
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (ERROR_LINE_RES.some((re) => re.test(line))) {
      keep.add(i);
      if (i + 1 < lines.length && lines[i + 1].trim()) keep.add(i + 1);
    }
  });
  let text =
    keep.size > 0
      ? [...keep]
          .sort((a, b) => a - b)
          .map((i) => lines[i])
          .join("\n")
      : clean.trim().split("\n").slice(-30).join("\n");
  text = text.trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…[diagnostic truncated]`;
  return text;
}

/** First file location a diagnostic points at (tsc `a.ts(3,5)` or `a.ts:3:5`). */
export function diagnosticLocation(diagnostic: string): { file: string; line: number; column: number } | null {
  const tsc = /([\w./@-]+\.[cm]?[jt]sx?)\((\d+),(\d+)\)/.exec(diagnostic);
  if (tsc) return { file: tsc[1], line: Number(tsc[2]), column: Number(tsc[3]) };
  const colon = /([\w./@-]+\.[cm]?[jt]sx?):(\d+):(\d+)/.exec(diagnostic);
  if (colon) return { file: colon[1], line: Number(colon[2]), column: Number(colon[3]) };
  return null;
}

/**
 * The identifier a diagnostic's location points at in `source` (e.g. the
 * callee `add` of `add(1)` for TS2554). Used when the message itself
 * quotes no name.
 */
export function identifierAt(source: string, line: number, column: number): string | null {
  const text = source.split("\n")[line - 1];
  if (text === undefined) return null;
  const from = Math.max(0, column - 1);
  const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(from)) ?? /[A-Za-z_$][\w$]*/.exec(text.slice(from));
  return m ? m[0] : null;
}

const NOT_SYMBOLS = new Set([
  "string", "number", "boolean", "undefined", "null", "void", "never", "unknown", "any", "object",
  "true", "false", "this", "Promise", "Array", "Record",
]);

/**
 * Identifiers a diagnostic names, most useful first. For "Property 'x'
 * does not exist on type 'Y'" the type Y comes first (its definition shows
 * what does exist).
 */
export function diagnosticSymbols(diagnostic: string): string[] {
  const out: string[] = [];
  const push = (name: string | undefined) => {
    if (!name) return;
    const base = name.replace(/<.*$/, "").replace(/\[\]$/, "");
    if (/^[A-Za-z_$][\w$]*$/.test(base) && !NOT_SYMBOLS.has(base) && !out.includes(base)) out.push(base);
  };
  const missingProp = /Property '([^']+)' does not exist on type '([^']+)'/.exec(diagnostic);
  if (missingProp) {
    push(missingProp[2]);
    push(missingProp[1]);
  }
  for (const m of diagnostic.matchAll(/'([^'\n]{1,80})'/g)) push(m[1]);
  return out;
}

/** Escape every regex metacharacter so a symbol name can never alter the pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const DEF_RE = (name: string) =>
  new RegExp(
    String.raw`^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+${escapeRegExp(name)}\b`,
  );

/**
 * Blank out string literals and comments, preserving every character position
 * (including newlines) so masked lines stay aligned with the original lines.
 * Braces inside them must not end a definition early.
 */
type MaskState = "code" | "line" | "block" | "single" | "double" | "template";

interface MaskStep {
  text: string;
  advance: number;
  state: MaskState;
}

/** Code state: swallow comment/string openings, pass everything else through. */
function maskInCode(ch: string, next: string): MaskStep {
  if (ch === "/" && next === "/") return { text: "  ", advance: 2, state: "line" };
  if (ch === "/" && next === "*") return { text: "  ", advance: 2, state: "block" };
  if (ch === "'") return { text: " ", advance: 1, state: "single" };
  if (ch === '"') return { text: " ", advance: 1, state: "double" };
  if (ch === "`") return { text: " ", advance: 1, state: "template" };
  return { text: ch, advance: 1, state: "code" };
}

/** Line-comment state: blank everything except the newline that ends it. */
function maskInLine(ch: string): MaskStep {
  return ch === "\n"
    ? { text: "\n", advance: 1, state: "code" }
    : { text: " ", advance: 1, state: "line" };
}

/** Block-comment state: blank everything except the closing bracket pair. */
function maskInBlock(ch: string, next: string): MaskStep {
  if (ch === "*" && next === "/") return { text: "  ", advance: 2, state: "code" };
  return { text: ch === "\n" ? "\n" : " ", advance: 1, state: "block" };
}

/** Single/double-quote string state. */
function maskInString(state: MaskState, ch: string, next: string): MaskStep {
  const quote = state === "single" ? "'" : '"';
  if (ch === "\\") return { text: next === "\n" ? " \n" : "  ", advance: 2, state };
  if (ch === quote) return { text: ch, advance: 1, state: "code" };
  return { text: ch === "\n" ? "\n" : " ", advance: 1, state };
}

/** Template-literal state. */
function maskInTemplate(ch: string, next: string): MaskStep {
  if (ch === "\\") return { text: next === "\n" ? " \n" : "  ", advance: 2, state: "template" };
  if (ch === "`") return { text: ch, advance: 1, state: "code" };
  return { text: ch === "\n" ? "\n" : " ", advance: 1, state: "template" };
}

function maskStringsAndComments(source: string): string {
  let out = "";
  let state: MaskState = "code";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    let step: MaskStep;
    switch (state) {
      case "code":
        step = maskInCode(ch, next);
        break;
      case "line":
        step = maskInLine(ch);
        break;
      case "block":
        step = maskInBlock(ch, next);
        break;
      case "single":
      case "double":
        step = maskInString(state, ch, next);
        break;
      default:
        step = maskInTemplate(ch, next);
        break;
    }
    out += step.text;
    state = step.state;
    i += step.advance;
  }
  return out;
}

/**
 * Find `name`'s definition in `files` and return it as numbered lines: from
 * the declaration to the end of its brace block (or `maxLines`).
 */
export function findDefinition(
  name: string,
  files: { path: string; content: string }[],
  maxLines = 40,
): { path: string; startLine: number; endLine: number; text: string } | null {
  const re = DEF_RE(name);
  for (const file of files) {
    const lines = file.content.split("\n");
    const masked = maskStringsAndComments(file.content).split("\n");
    const at = lines.findIndex((_, i) => re.test(masked[i] ?? ""));
    if (at === -1) continue;
    let depth = 0;
    let opened = false;
    let end = at;
    for (let i = at; i < lines.length && i < at + maxLines; i++) {
      for (const ch of masked[i] ?? "") {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      end = i;
      if ((opened && depth <= 0) || (!opened && /;\s*$/.test(masked[i] ?? ""))) break;
    }
    const text = lines
      .slice(at, end + 1)
      .map((line, i) => `${at + 1 + i} | ${line}`)
      .join("\n");
    return { path: file.path, startLine: at + 1, endLine: end + 1, text };
  }
  return null;
}

export interface RetryContextInput {
  stage: string;
  diagnostic: string;
  /** Identifier at the diagnostic's location in the patched file, if known. */
  locationSymbol?: string | null;
  /** Files (from the real tree) to search for the named symbol's definition. */
  files: { path: string; content: string }[];
}

/** The compact prompt fragment the retry gets: diagnostic + one definition. */
export function buildRetryContext(input: RetryContextInput): string {
  const parts = [
    `The previous attempt was rejected by the oracle at "${input.stage}" and its patch was discarded.`,
    "Diagnostic:",
    input.diagnostic || "(no output)",
  ];
  const names = diagnosticSymbols(input.diagnostic);
  if (input.locationSymbol && !names.includes(input.locationSymbol)) names.push(input.locationSymbol);
  for (const name of names) {
    const def = findDefinition(name, input.files);
    if (def) {
      parts.push(`Definition of \`${name}\` (${def.path}:L${def.startLine}-${def.endLine}):`, def.text);
      break;
    }
  }
  return parts.join("\n");
}
