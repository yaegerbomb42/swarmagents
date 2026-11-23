/**
 * Disposable read-only explorer subagent (Wave 2).
 *
 * `dispatchExplorer` spawns a fast, disposable subagent per investigation
 * query, routed to a cheap/fast model tier, and returns a schema-validated
 * Ground-Truth Brief to the main builder agent.
 *
 * The design follows the Decision Brain's model-call pattern
 * (lib/harness/decision-brain/router.ts): an OpenAI-compatible
 * `/chat/completions` endpoint with an injectable `fetchImpl`, a JSON-schema
 * response format, and an AbortController timeout — so the loop is testable
 * without a provider key.
 *
 * The read-only sandbox is structural, not a prompt suggestion:
 *
 *   - The tool registry contains ONLY the five read tools below. There is
 *     no bash, write, or edit tool in the registry type, and the executor
 *     rejects any other tool name — a mutating tool cannot be called even
 *     if the model asks for one.
 *   - Every tool resolves its path inside `repoRoot` and refuses absolute
 *     paths, `..` escapes, and symlinks (a symlink inside the repo that
 *     points outside it is never followed).
 *   - Each explorer is hard-capped at `EXPLORER_MAX_STEPS` steps and
 *     `EXPLORER_MAX_WALL_CLOCK_MS` wall-clock milliseconds.
 *
 * Before a brief is returned, `verifyBriefLocations` checks every cited
 * path and line range against disk: hallucinated paths are stripped,
 * wrong snippets are replaced with the verbatim file lines, and the
 * confidence is downgraded when anything was stripped.
 *
 * The VM-side MCP server that exposes `dispatch_explorer` to the Claude
 * agent in the VM is a follow-up; this module is the server-side runtime
 * and is registered in the role tool catalog (lib/roles.ts) so roles can
 * offer it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { ModelEndpointConfig } from "./decision-brain/types";
export type { ModelEndpointConfig } from "./decision-brain/types";
import { countWords } from "./decision-brain/schema";

// Absolute git path from fixed, trusted dirs so we never rely on PATH
// resolution (Sonar S4036).
const GIT_BIN =
  ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"].find((p) => fs.existsSync(p)) ?? "/usr/bin/git";

/** Hard cap on tool steps per explorer. */
export const EXPLORER_MAX_STEPS = 8;
/** Hard cap on wall-clock milliseconds per explorer. */
export const EXPLORER_MAX_WALL_CLOCK_MS = 20_000;
/** Max investigation queries in one `dispatch_explorer` call. */
export const EXPLORER_MAX_QUERIES = 4;
/** Budget for the merged briefs returned by one `dispatch_explorer` call. */
export const EXPLORER_MAX_BRIEF_TOKENS = 1500;
/** Max lines a brief snippet may carry (verbatim from disk). */
export const EXPLORER_MAX_SNIPPET_LINES = 12;
/** Max words in a brief's direct answer. */
export const EXPLORER_MAX_ANSWER_WORDS = 120;

// ---------------------------------------------------------------------------
// Read-only tool registry
// ---------------------------------------------------------------------------

/**
 * The ONLY tools an explorer may call. Mutating tools and bash execution
 * are physically excluded: they are not in this list, not in the executor,
 * and not in the model prompt.
 */
export const EXPLORER_TOOL_NAMES = ["ripgrep", "glob", "ast_outline", "read_file_range", "git_log_grep"] as const;
export type ExplorerToolName = (typeof EXPLORER_TOOL_NAMES)[number];

const EXPLORER_TOOL_SET: ReadonlySet<string> = new Set(EXPLORER_TOOL_NAMES);

export interface ExplorerToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

function toolError(summary: string): ExplorerToolResult {
  return { ok: false, summary };
}

/** Resolve `p` inside `repoRoot`; null for absolute paths and `..` escapes. */
function resolveInRepo(repoRoot: string, p: string): string | null {
  if (!p || path.isAbsolute(p)) return null;
  const resolved = path.resolve(repoRoot, p);
  const rel = path.relative(repoRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** A real file inside the repo (lstat: symlinks are not files and are refused). */
function realFile(repoRoot: string, p: string): string | null {
  const resolved = resolveInRepo(repoRoot, p);
  if (!resolved) return null;
  try {
    if (!fs.lstatSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);
const MAX_WALK_FILES = 5000;

/** Repo files, newest-agnostic sorted order; never follows symlinks. */
function isKeptEntry(entry: fs.Dirent): boolean {
  return !SKIP_DIRS.has(entry.name) && !entry.isSymbolicLink();
}

function collectRepoFiles(dir: string, stack: string[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!isKeptEntry(entry)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) stack.push(full);
    else if (entry.isFile()) {
      out.push(full);
      if (out.length >= MAX_WALK_FILES) return;
    }
  }
}

function walkRepoFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const stack = [repoRoot];
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    collectRepoFiles(stack.pop() as string, stack, out);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function toPosix(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function isTextFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      if (read === 0) return true;
      if (buf.subarray(0, read).includes(0)) return false;
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function argString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" ? v : null;
}

function argInt(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return fallback;
}

function resolveRipgrepRoots(
  repoRoot: string,
  scope: string | null,
): { roots: string[]; error?: string } {
  if (!scope) return { roots: [repoRoot] };
  const resolved = resolveInRepo(repoRoot, scope);
  if (!resolved) return { roots: [], error: `ripgrep: path escapes the repo: ${scope}` };
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) return { roots: [], error: `ripgrep: symlinks are not followed: ${scope}` };
    return { roots: [resolved] };
  } catch {
    return { roots: [], error: `ripgrep: no such path: ${scope}` };
  }
}

function collectFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    try {
      const st = fs.lstatSync(root);
      if (st.isFile()) files.push(root);
      else if (st.isDirectory()) files.push(...walkRepoFiles(root));
    } catch {
      // Unreadable root: skip it.
    }
  }
  return files;
}

function ripgrepFile(
  file: string,
  regex: RegExp,
  repoRoot: string,
  maxMatches: number,
  matches: Array<{ path: string; line: number; text: string }>,
): void {
  if (matches.length >= maxMatches) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.size > 1024 * 1024 || !isTextFile(file)) return;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
    if (regex.test(lines[i])) {
      matches.push({ path: toPosix(repoRoot, file), line: i + 1, text: lines[i].trim().slice(0, 300) });
    }
  }
}

function ripgrep(repoRoot: string, args: Record<string, unknown>): ExplorerToolResult {
  const pattern = argString(args, "pattern");
  if (!pattern) return toolError("ripgrep: pattern is required.");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return toolError(`ripgrep: invalid regex: ${pattern}`);
  }
  const scope = argString(args, "path");
  const maxMatches = Math.min(Math.max(argInt(args, "maxMatches", 50), 1), 200);
  const { roots, error } = resolveRipgrepRoots(repoRoot, scope);
  if (error) return toolError(error);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of collectFiles(roots)) {
    ripgrepFile(file, regex, repoRoot, maxMatches, matches);
  }
  return {
    ok: true,
    summary: `${matches.length} match${matches.length === 1 ? "" : "es"} for /${pattern}/`,
    data: { matches },
  };
}

/** Convert a glob (`**`, `*`, `?`) to a regex over `/`-separated paths. */
function globToRegExp(glob: string): RegExp | null {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
    }
  }
  out += "$";
  try {
    return new RegExp(out);
  } catch {
    return null;
  }
}

function glob(repoRoot: string, args: Record<string, unknown>): ExplorerToolResult {
  const pattern = argString(args, "pattern");
  if (!pattern) return toolError("glob: pattern is required.");
  const regex = globToRegExp(pattern);
  if (!regex) return toolError(`glob: invalid pattern: ${pattern}`);
  const maxResults = Math.min(Math.max(argInt(args, "maxResults", 100), 1), 500);
  const files = walkRepoFiles(repoRoot)
    .map((f) => toPosix(repoRoot, f))
    .filter((p) => regex.test(p))
    .slice(0, maxResults);
  return { ok: true, summary: `${files.length} file${files.length === 1 ? "" : "s"} matching ${pattern}`, data: { files } };
}

const TS_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
// Column-0 declarations only, so nested functions do not pollute the outline.
const DECLARATION_RE =
  /^(?:export\s+(?:default\s+)?)?(function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function astOutline(repoRoot: string, args: Record<string, unknown>): ExplorerToolResult {
  const p = argString(args, "path");
  if (!p) return toolError("ast_outline: path is required.");
  const file = realFile(repoRoot, p);
  if (!file) return toolError(`ast_outline: no such file in the repo: ${p}`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return toolError(`ast_outline: cannot read ${p}`);
  }
  const declarations: Array<{ name: string; kind: string; line: number }> = [];
  if (TS_EXTENSIONS.has(path.extname(file))) {
    for (const match of text.matchAll(DECLARATION_RE)) {
      const line = text.slice(0, match.index ?? 0).split("\n").length;
      declarations.push({ name: match[2], kind: match[1], line });
    }
  }
  return {
    ok: true,
    summary: `${declarations.length} top-level declaration${declarations.length === 1 ? "" : "s"} in ${p}`,
    data: { path: toPosix(repoRoot, file), declarations, totalLines: lineCount(text) },
  };
}

function lineCount(text: string): number {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function readFileRange(repoRoot: string, args: Record<string, unknown>): ExplorerToolResult {
  const p = argString(args, "path");
  if (!p) return toolError("read_file_range: path is required.");
  const file = realFile(repoRoot, p);
  if (!file) return toolError(`read_file_range: no such file in the repo: ${p}`);
  const startLine = argInt(args, "startLine", 1);
  const requestedEnd = "endLine" in args ? argInt(args, "endLine", startLine) : startLine + 29;
  if (startLine < 1 || requestedEnd < startLine) {
    return toolError(`read_file_range: invalid range ${startLine}-${requestedEnd}`);
  }
  const endLine = Math.min(requestedEnd, startLine + 99);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return toolError(`read_file_range: cannot read ${p}`);
  }
  const lines = text.split("\n");
  // A trailing newline produces a final empty segment that is not a line.
  if (lines.at(-1) === "") lines.pop();
  if (startLine > lines.length) {
    return toolError(`read_file_range: ${p} has ${lines.length} lines; startLine ${startLine} is out of range`);
  }
  const slice = lines.slice(startLine - 1, Math.min(endLine, lines.length));
  return {
    ok: true,
    summary: `${p}:${startLine}-${startLine + slice.length - 1} of ${lines.length} lines`,
    data: { path: toPosix(repoRoot, file), startLine, endLine: startLine + slice.length - 1, totalLines: lines.length, lines: slice },
  };
}

function gitLogGrep(repoRoot: string, args: Record<string, unknown>): ExplorerToolResult {
  const pattern = argString(args, "pattern");
  if (!pattern) return toolError("git_log_grep: pattern is required.");
  const maxResults = Math.min(Math.max(argInt(args, "maxResults", 20), 1), 100);
  try {
    const out = execFileSync(
      GIT_BIN,
      ["-C", repoRoot, "log", "--oneline", "-i", `--grep=${pattern}`, `--max-count=${maxResults}`],
      { encoding: "utf8", timeout: 5000 },
    );
    const commits = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(" ");
        return space === -1 ? { hash: line, subject: "" } : { hash: line.slice(0, space), subject: line.slice(space + 1) };
      });
    return { ok: true, summary: `${commits.length} commit${commits.length === 1 ? "" : "s"} matching /${pattern}/`, data: { commits } };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    return toolError(`git_log_grep: ${stderr.slice(0, 200)}`);
  }
}

/** Execute one read-only tool call. Unknown names are rejected, never run. */
export function executeExplorerTool(
  repoRoot: string,
  tool: string,
  args: Record<string, unknown>,
): ExplorerToolResult {
  if (!EXPLORER_TOOL_SET.has(tool)) {
    return toolError(`unknown or forbidden tool: ${tool} (explorers may only call ${EXPLORER_TOOL_NAMES.join(", ")})`);
  }
  switch (tool as ExplorerToolName) {
    case "ripgrep":
      return ripgrep(repoRoot, args);
    case "glob":
      return glob(repoRoot, args);
    case "ast_outline":
      return astOutline(repoRoot, args);
    case "read_file_range":
      return readFileRange(repoRoot, args);
    case "git_log_grep":
      return gitLogGrep(repoRoot, args);
  }
}

// ---------------------------------------------------------------------------
// Ground-Truth Brief
// ---------------------------------------------------------------------------

export const BriefLocationRole = z.enum(["definition", "caller", "config", "test"]);
export type BriefLocationRole = z.infer<typeof BriefLocationRole>;

export const GroundTruthBriefSchema = z.object({
  query: z.string().min(1),
  directAnswer: z
    .string()
    .min(1)
    .refine((val) => countWords(val) <= EXPLORER_MAX_ANSWER_WORDS, {
      message: `directAnswer must be at most ${EXPLORER_MAX_ANSWER_WORDS} words`,
    }),
  relevantLocations: z
    .array(
      z.object({
        path: z.string().min(1),
        symbol: z.string().optional(),
        lineStart: z.number().int().min(1),
        lineEnd: z.number().int().min(1),
        role: BriefLocationRole,
        snippet: z.string().min(1),
      }),
    )
    .max(20),
  invariantsAndGotchas: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  missingInfo: z.string().optional(),
});

export type GroundTruthBrief = z.infer<typeof GroundTruthBriefSchema>;

/** Rough token estimate (chars/4) for the 1,500-token brief budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Total estimated tokens of serialized briefs. */
export function estimateBriefTokens(briefs: GroundTruthBrief[]): number {
  return estimateTokens(JSON.stringify(briefs));
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n");
}

/**
 * Repair a model-produced brief before validation: cap the answer at 120
 * words and every snippet at 12 lines. The schema then enforces the shape.
 */
export function normalizeBrief(raw: unknown): GroundTruthBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const locations = Array.isArray(input.relevantLocations) ? input.relevantLocations : [];
  const repaired = {
    ...input,
    directAnswer: typeof input.directAnswer === "string" ? truncateWords(input.directAnswer, EXPLORER_MAX_ANSWER_WORDS) : input.directAnswer,
    relevantLocations: locations.map((loc) => {
      if (!loc || typeof loc !== "object") return loc;
      const l = loc as Record<string, unknown>;
      return {
        ...l,
        snippet: typeof l.snippet === "string" ? truncateLines(l.snippet, EXPLORER_MAX_SNIPPET_LINES) : l.snippet,
      };
    }),
  };
  const parsed = GroundTruthBriefSchema.safeParse(repaired);
  return parsed.success ? parsed.data : null;
}

function downgrade(confidence: GroundTruthBrief["confidence"]): GroundTruthBrief["confidence"] {
  return confidence === "high" ? "medium" : "low";
}

/**
 * Deterministic verification pass: every cited path and line range must
 * exist on disk. Hallucinated paths and out-of-range lines are stripped;
 * a snippet that does not match the file is replaced with the verbatim
 * lines; any strip downgrades the confidence one notch and is recorded in
 * `missingInfo`.
 */
type BriefLocation = GroundTruthBrief["relevantLocations"][number];

type LocationOutcome =
  | { kind: "stripped"; reason: string }
  | { kind: "kept"; location: BriefLocation; corrected: boolean };

/** Re-check one cited location against disk; strip or correct it as needed. */
function verifyLocation(repoRoot: string, loc: BriefLocation): LocationOutcome {
  const file = realFile(repoRoot, loc.path);
  if (!file) return { kind: "stripped", reason: loc.path };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { kind: "stripped", reason: loc.path };
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (loc.lineStart > lines.length || loc.lineStart < 1) {
    return { kind: "stripped", reason: `${loc.path}:${loc.lineStart}-${loc.lineEnd}` };
  }
  const endLine = Math.min(loc.lineEnd, lines.length);
  const actual = lines.slice(loc.lineStart - 1, endLine).join("\n");
  // The snippet must be verbatim, not just trim-equal: a trimmed or
  // reworded snippet is replaced with the exact file lines.
  if (loc.snippet !== actual) {
    return { kind: "kept", location: { ...loc, lineEnd: endLine, snippet: actual }, corrected: true };
  }
  return { kind: "kept", location: { ...loc, lineEnd: endLine }, corrected: false };
}

export function verifyBriefLocations(
  repoRoot: string,
  brief: GroundTruthBrief,
): { brief: GroundTruthBrief; stripped: number; corrected: number } {
  const kept: BriefLocation[] = [];
  const strippedPaths: string[] = [];
  let corrected = 0;
  for (const loc of brief.relevantLocations) {
    const outcome = verifyLocation(repoRoot, loc);
    if (outcome.kind === "stripped") {
      strippedPaths.push(outcome.reason);
      continue;
    }
    kept.push(outcome.location);
    if (outcome.corrected) corrected++;
  }
  let { confidence, missingInfo } = brief;
  if (strippedPaths.length > 0) {
    confidence = downgrade(confidence);
    const note = `Verification stripped ${strippedPaths.length} hallucinated location${strippedPaths.length === 1 ? "" : "s"}: ${strippedPaths.join(", ")}`;
    missingInfo = missingInfo ? `${missingInfo} ${note}` : note;
  }
  return { brief: { ...brief, relevantLocations: kept, confidence, missingInfo }, stripped: strippedPaths.length, corrected };
}

// ---------------------------------------------------------------------------
// Explorer agent loop
// ---------------------------------------------------------------------------

const EXPLORER_STEP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["tool", "final"] },
    tool: { type: "string", enum: [...EXPLORER_TOOL_NAMES] },
    args: { type: "object", description: "Arguments for the named tool." },
    brief: {
      type: "object",
      additionalProperties: false,
      required: ["query", "directAnswer", "relevantLocations", "invariantsAndGotchas", "confidence"],
      properties: {
        query: { type: "string" },
        directAnswer: { type: "string", description: "At most 120 words." },
        relevantLocations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "lineStart", "lineEnd", "role", "snippet"],
            properties: {
              path: { type: "string" },
              symbol: { type: "string" },
              lineStart: { type: "integer", minimum: 1 },
              lineEnd: { type: "integer", minimum: 1 },
              role: { type: "string", enum: ["definition", "caller", "config", "test"] },
              snippet: { type: "string", description: "At most 12 lines, verbatim from the file." },
            },
          },
        },
        invariantsAndGotchas: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        missingInfo: { type: "string" },
      },
    },
  },
} as const;

const ExplorerStepSchema = z.union([
  z.object({
    action: z.literal("tool"),
    tool: z.enum(EXPLORER_TOOL_NAMES),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({ action: z.literal("final"), brief: z.unknown() }),
]);

const EXPLORER_SYSTEM_PROMPT = [
  "You are a read-only codebase explorer. Answer the user's question with evidence from the repository.",
  "You have exactly five tools: ripgrep (search file contents by regex), glob (find files by pattern), ast_outline (top-level declarations of a file), read_file_range (read exact lines of a file), git_log_grep (search commit messages).",
  "You cannot write, edit, or run commands. Cite every claim with a file path and line numbers from a tool result; never invent a path or a line.",
  "Each turn, respond with exactly one JSON object: either {\"action\":\"tool\",\"tool\":\"<name>\",\"args\":{...}} to call a tool, or {\"action\":\"final\",\"brief\":{...}} with the finished Ground-Truth Brief.",
  "The brief's directAnswer is at most 120 words; each snippet is at most 12 lines, verbatim from the file. Set confidence high only when every location was read from a tool result.",
].join("\n");

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

function cleanModelJson(rawText: string): string {
  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.slice(3);
    // Strip the optional "json" language tag, then leading whitespace.
    if (text.toLowerCase().startsWith("json")) text = text.slice(4);
    text = text.replace(/^\s*/, "");
  }
  if (text.endsWith("```")) {
    text = text.slice(0, text.length - 3);
  }
  return text.trim();
}

export interface ExplorerOptions {
  repoRoot: string;
  endpoint: ModelEndpointConfig;
  maxSteps?: number;
  maxWallClockMs?: number;
  fetchImpl?: typeof fetch;
}

function fallbackBrief(query: string, reason: string): GroundTruthBrief {
  return {
    query,
    directAnswer: "The explorer could not produce a validated brief.",
    relevantLocations: [],
    invariantsAndGotchas: [],
    confidence: "low",
    missingInfo: reason,
  };
}

/**
 * Run one explorer against `repoRoot` until it returns a final brief or
 * its step / wall-clock budget is exhausted (then a low-confidence brief
 * explains why). The model is called through the cheap/fast endpoint in
 * `options.endpoint`; `fetchImpl` is injectable for tests.
 */
export async function runExplorer(query: string, options: ExplorerOptions): Promise<GroundTruthBrief> {
  const repoRoot = path.resolve(options.repoRoot);
  const maxSteps = options.maxSteps ?? EXPLORER_MAX_STEPS;
  const maxWallClockMs = options.maxWallClockMs ?? EXPLORER_MAX_WALL_CLOCK_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = performance.now();
  const deadline = started + maxWallClockMs;

  const messages: ChatMessage[] = [
    { role: "system", content: EXPLORER_SYSTEM_PROMPT },
    { role: "user", content: query },
  ];

  let steps = 0;
  while (steps < maxSteps) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    steps++;
    let step: z.infer<typeof ExplorerStepSchema>;
    try {
      step = await callExplorerModel(options.endpoint, messages, remainingMs, fetchImpl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return verifyBriefLocations(repoRoot, fallbackBrief(query, `Model call failed: ${reason.slice(0, 200)}`)).brief;
    }
    if (step.action === "final") {
      const brief = normalizeBrief(step.brief);
      if (brief) return verifyBriefLocations(repoRoot, { ...brief, query }).brief;
      messages.push(
        { role: "assistant", content: JSON.stringify(step) },
        { role: "user", content: "That brief failed validation (check the query, 120-word answer, 12-line snippets, and location roles). Fix it or use the tools to gather more evidence." },
      );
      continue;
    }
    const result = executeExplorerTool(repoRoot, step.tool, step.args);
    messages.push(
      { role: "assistant", content: JSON.stringify(step) },
      { role: "user", content: `Tool ${step.tool} result: ${JSON.stringify(result).slice(0, 8000)}` },
    );
  }
  return verifyBriefLocations(
    repoRoot,
    fallbackBrief(query, `Explorer budget exhausted after ${steps} step${steps === 1 ? "" : "s"} (max ${maxSteps}, ${maxWallClockMs}ms).`),
  ).brief;
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

async function callExplorerModel(
  endpoint: ModelEndpointConfig,
  messages: ChatMessage[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<z.infer<typeof ExplorerStepSchema>> {
  const url = `${stripTrailingSlashes(endpoint.baseUrl)}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(endpoint.timeoutMs ?? 20_000, Math.max(timeoutMs, 1)));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        max_tokens: 2000,
        response_format: {
          type: "json_schema",
          json_schema: { name: "explorer_step", strict: true, schema: EXPLORER_STEP_JSON_SCHEMA },
        },
        messages,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") throw new Error("Model returned empty content");
    const parsed: unknown = JSON.parse(cleanModelJson(content));
    const step = ExplorerStepSchema.safeParse(parsed);
    if (!step.success) throw new Error(`Model step failed validation: ${step.error.issues.map((i) => i.message).join("; ").slice(0, 200)}`);
    return step.data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fan-out: dispatch_explorer
// ---------------------------------------------------------------------------

export interface DispatchExplorerInput {
  /** 1-4 independent investigation queries, run concurrently. */
  queries: string[];
  repoRoot: string;
  endpoint: ModelEndpointConfig;
  maxSteps?: number;
  maxWallClockMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Dispatch up to four read-only explorers in parallel and return their
 * Ground-Truth Briefs in query order. Wall-clock time is bounded by the
 * slowest single explorer, not the sum. Throws on invalid input (no
 * queries, more than four, an empty query, or a missing repo root).
 */
export async function dispatchExplorer(input: DispatchExplorerInput): Promise<GroundTruthBrief[]> {
  if (!Array.isArray(input.queries) || input.queries.length === 0) {
    throw new RangeError("dispatch_explorer: queries must be a non-empty array.");
  }
  if (input.queries.length > EXPLORER_MAX_QUERIES) {
    throw new RangeError(`dispatch_explorer: at most ${EXPLORER_MAX_QUERIES} queries per call (got ${input.queries.length}).`);
  }
  for (const q of input.queries) {
    if (typeof q !== "string" || !q.trim()) {
      throw new RangeError("dispatch_explorer: every query must be a non-empty string.");
    }
  }
  const repoRoot = path.resolve(input.repoRoot);
  try {
    if (!fs.statSync(repoRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RangeError(`dispatch_explorer: repoRoot is not a directory: ${input.repoRoot}`);
  }
  return Promise.all(
    input.queries.map((query) =>
      runExplorer(query, {
        repoRoot,
        endpoint: input.endpoint,
        maxSteps: input.maxSteps,
        maxWallClockMs: input.maxWallClockMs,
        fetchImpl: input.fetchImpl,
      }),
    ),
  );
}
