import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { OmnexxConfig } from '../config/schema.js';
import { workModeOf } from '../config/work-mode.js';
import type { Run } from '../core/run.js';
import { estimateTokens } from '../core/tokens.js';

/**
 * Spec-first acceptance tests. The worker writes code and its own tests, and the two can agree on
 * a wrong behaviour (bench task-10: `fulfil()` of a reservation re-checked available stock, which
 * its own reservation had lowered). An independent model that sees only the goal and the public
 * interface (signatures, never bodies) writes tests for the boundaries and interactions between
 * requirements; they run before the run may finish. The tests live outside the repo (in the run
 * store) and sit in the worktree only while they run, so they are never committed.
 */

/** Where the suite's files sit in the worktree while it runs. */
export const SPEC_DIR = 'omnexx-spec';
/** The worker disputes a spec test by writing this file (git-excluded) with its reason. */
export const DISPUTE_FILE = '.omnexx-spec-dispute.md';
/** `auto` writes spec tests for goals listing at least this many requirements. */
export const MIN_REQUIREMENTS = 5;
const MAX_FILES = 8;
const MAX_FILE_CHARS = 20_000;
const INTERFACE_MAX_CHARS = 12_000;
const WRITER_MAX_TOKENS = 16_000;
const JUDGE_MAX_TOKENS = 8_000;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const SPEC_PATH = new RegExp(String.raw`^${SPEC_DIR}/(?!\.\.?$)[A-Za-z0-9_.-]+$`);

/** Numbered or bulleted lines in the goal: a rough count of its separate requirements. */
export function countRequirements(goal: string): number {
  return goal.split('\n').filter((l) => LIST_ITEM.test(l)).length;
}

/** Whether this goal gets spec tests: `on`, or `auto` for a big goal or one listing many rules. */
export function specTestsWanted(config: OmnexxConfig, goal: string, writing: boolean): boolean {
  const mode = config.review.spec_tests;
  // Spec tests are written against a codebase's public interface; the general domain
  // verifies artifacts with task checks and gates instead, so it never wants a suite.
  if (mode === 'off' || writing || workModeOf(config) === 'general') return false;
  if (mode === 'on') return true;
  return (
    goal.trim().length > config.plan.fast_max_goal_chars ||
    countRequirements(goal) >= MIN_REQUIREMENTS
  );
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb)$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);
const TEST_NAME = /[._-](?:test|spec)\./;
const CONTROL = /^(?:if|for|while|switch|catch|return|else|do|try|await|throw|new|typeof)\b/;
const DECLARATION =
  /^(?:export\s|module\.exports|exports\.|function\s|async\s|class\s|interface\s|type\s|def\s|pub\s|func\s)/;
const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'async',
  'get',
  'set',
  'readonly',
]);
/** `name(` or `#name<T>(` at the start of a member header. */
const MEMBER_HEAD = /^#?[A-Za-z_$][\w$]*(?:<[^>]*>)?\(/;

function isTestFile(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return (
    parts.slice(0, -1).some((d) => TEST_DIRS.has(d)) ||
    TEST_NAME.test(name) ||
    (name.startsWith('test_') && name.endsWith('.py'))
  );
}

/** A method header inside a class or object body: `name(args) {`, `get name() {`. */
function isMember(line: string): boolean {
  if (!line.endsWith('{')) return false;
  const words = line.split(' ');
  let i = 0;
  while (i < words.length - 1 && MODIFIERS.has(words[i] ?? '')) i++;
  return MEMBER_HEAD.test(words.slice(i).join(' '));
}

/** Drop a trailing `{` (and `=> {`) from a header line. */
function header(line: string): string {
  const open = line.endsWith('{') ? line.slice(0, -1).trimEnd() : line;
  return open.endsWith('=>') ? `${open.slice(0, -2).trimEnd()} =>` : open;
}

/** One source line as a signature, or undefined when it is body. */
function signatureLine(raw: string): string | undefined {
  const line = raw.trim();
  if (!line || line.startsWith('//') || line.startsWith('#') || CONTROL.test(line))
    return undefined;
  if (!DECLARATION.test(line) && !isMember(line)) return undefined;
  const indent = raw.length - raw.trimStart().length;
  return `${' '.repeat(Math.min(indent, 4))}${header(line)}`;
}

/**
 * The public interface of the changed source files: declarations and method headers, no bodies.
 * The spec-test writer must not see the implementation, or it would test what the code does
 * instead of what the goal asks.
 */
export function publicInterface(
  files: readonly { path: string; text: string }[],
  maxChars = INTERFACE_MAX_CHARS,
): string {
  const parts = files
    .filter((f) => CODE_FILE.test(f.path) && !isTestFile(f.path))
    .map((f) => {
      const sigs = f.text
        .split('\n')
        .map(signatureLine)
        .filter((l): l is string => l !== undefined);
      return sigs.length ? `## ${f.path}\n${sigs.join('\n')}` : '';
    })
    .filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [interface cut]` : text;
}

export const suiteSchema = z.object({
  command: z.string().min(3).max(300),
  files: z
    .array(
      z.object({
        path: z.string().regex(SPEC_PATH, `paths look like "${SPEC_DIR}/<name>"`),
        content: z.string().min(10).max(MAX_FILE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_FILES),
});
export type SpecSuite = z.infer<typeof suiteSchema>;

/** Validate the writer's answer: files only under SPEC_DIR, a one-line command that runs them. */
export function parseSuite(input: unknown): SpecSuite | string {
  if (typeof input !== 'object' || input === null) return 'no answer object';
  const o = input as { files?: unknown };
  // A writer that went over the file cap still wrote usable tests: keep the first ones.
  const files = Array.isArray(o.files) ? o.files.slice(0, MAX_FILES) : o.files;
  const r = suiteSchema.safeParse({ ...input, files });
  if (!r.success) return z.prettifyError(r.error).slice(0, 500);
  const command = r.data.command.trim();
  if (command.includes('\n')) return 'the command must be one line';
  if (!command.includes(SPEC_DIR)) return `the command must run the files under ${SPEC_DIR}/`;
  return { command, files: r.data.files };
}

const WRITER_SYSTEM = `You write independent acceptance tests for a coding task, from its specification alone. Another agent wrote the code; you never see its implementation, only the goal and the public interface (signatures).

Write tests that would catch a wrong reading of the spec:
- the boundaries of each rule (zero, exactly the limit, one past it, empty input) where the spec states the outcome;
- above all the interactions between requirements: one operation built on another (an operation that completes something an earlier call set up, an undo, a transfer, a save and restore), walked through a concrete call sequence. An internal step often wrongly re-runs a public check that its own earlier bookkeeping now fails.
Assert only what the spec states. Where it leaves a behaviour open, don't test it. Don't test internals, timing, messages or formatting the spec doesn't fix. Build every fixture only with calls the spec says succeed (a setup helper that passes a quantity of 0 where the spec requires a positive one breaks the test, not the code).

Use the project's own test runner and module style (see the project facts). Put every file under ${SPEC_DIR}/ at the repository root (one small file per requirement or interaction, import the code by a relative path from there), and give one shell command that runs only those files, naming each file (not a directory or glob), and exits non-zero when one fails. Reply only by calling the answer tool.`;

const WRITER_SHAPE = ` Call the answer tool with {"command": "<one line running each file>", "files": [{"path": "${SPEC_DIR}/<name>", "content": "<the test file>"}]}.`;

const JUDGE_SYSTEM = `You settle a dispute about acceptance tests. An independent model wrote tests from a specification; the agent that wrote the code says some of them contradict the specification. Decide for each disputed test file by the specification alone: drop it only when the test asserts something the spec contradicts or leaves open. A test that is right and code that is wrong means the test stays. Reply only by calling the answer tool.`;

const judgeSchema = z.object({
  drop: z.array(z.string().max(300)).max(MAX_FILES).default([]),
  reason: z.string().max(1_000).default(''),
});
export type DisputeVerdict = z.infer<typeof judgeSchema>;

async function askTool(
  run: Run,
  system: string,
  prompt: string,
  schema: z.ZodType,
  role: string,
  maxTokens: number,
): Promise<unknown> {
  const done = await run.cheapComplete(
    {
      system: [{ text: system }],
      tools: [
        { name: 'answer', description: 'Submit the answer', inputSchema: z.toJSONSchema(schema) },
      ],
      toolChoice: { type: 'tool', name: 'answer' },
      messages: [{ role: 'user', content: [{ type: 'text', text: run.redactor.text(prompt) }] }],
      maxTokens,
      messageBreakpoints: [],
    },
    {
      estimatedInputTokens: estimateTokens(prompt) + 800,
      maxOutputTokens: maxTokens,
      role,
      purpose: role === 'spec_judge' ? 'reviewer' : 'verification',
      chain: run.config.review.spec_tests_models,
    },
  );
  const call = done?.res.content.find((b) => b.type === 'tool_use');
  return call?.type === 'tool_use' ? call.input : undefined;
}

export interface SpecContext {
  goal: string;
  intent: string;
  iface: string;
  /** Test commands, package.json scripts and module type: enough to pick the runner. */
  project: string;
}

/** One call: the suite, or undefined when the writer couldn't produce a usable one (fail open). */
export async function writeSpecSuite(run: Run, ctx: SpecContext): Promise<SpecSuite | undefined> {
  const prompt = [
    `# The specification (what the user asked for)\n${ctx.goal.slice(0, 8_000)}`,
    ...(ctx.intent ? [ctx.intent.slice(0, 3_000)] : []),
    `# Public interface (signatures only)\n${ctx.iface || '(none found: infer it from the spec)'}`,
    `# Project facts\n${ctx.project}`,
  ].join('\n\n');
  try {
    const ask = (text: string) =>
      askTool(run, WRITER_SYSTEM, text, suiteSchema, 'spec_tests', WRITER_MAX_TOKENS);
    const first = parseSuite(await ask(prompt));
    if (typeof first !== 'string') return first;
    // One retry with what was wrong: a model once answered with 22 tokens and no files.
    const second = parseSuite(
      await ask(`${prompt}\n\nYour last answer was unusable (${first}).${WRITER_SHAPE}`),
    );
    if (typeof second !== 'string') return second;
    run.events.emit('spec_tests.unavailable', { error: second });
    return undefined;
  } catch (err) {
    run.events.emit('spec_tests.unavailable', { error: (err as Error).message });
    return undefined;
  }
}

/** The judge's ruling on a dispute: which test files to drop. Undefined when it couldn't rule. */
export async function judgeDispute(
  run: Run,
  goal: string,
  suite: SpecSuite,
  failure: string,
  dispute: string,
): Promise<DisputeVerdict | undefined> {
  const tests = suite.files.map((f) => `## ${f.path}\n${f.content}`).join('\n\n');
  const prompt = [
    `# The specification\n${goal.slice(0, 8_000)}`,
    `# The acceptance tests\n${tests.slice(0, 24_000)}`,
    `# How they fail now\n${failure.slice(-4_000)}`,
    `# The coding agent's dispute\n${dispute.slice(0, 3_000)}`,
    'List in "drop" the paths of the test files to drop (none when every disputed test is right).',
  ].join('\n\n');
  try {
    const r = judgeSchema.safeParse(
      await askTool(run, JUDGE_SYSTEM, prompt, judgeSchema, 'spec_judge', JUDGE_MAX_TOKENS),
    );
    if (!r.success) return undefined;
    const known = new Set(suite.files.map((f) => f.path));
    const reason = r.data.reason.trim().length ? r.data.reason : 'no reason given';
    return { drop: r.data.drop.filter((p) => known.has(p)), reason };
  } catch (err) {
    run.events.emit('spec_tests.unavailable', { error: (err as Error).message });
    return undefined;
  }
}

/** Output that says the suite itself never ran: a runner that found no files, a bad command. */
const BROKEN =
  /no test files found|no tests? found|could not find|command not found|unknown (?:option|command)|ENOENT[^\n]*omnexx-spec|SyntaxError[^\n]*omnexx-spec/i;

export function suiteBroken(output: string): boolean {
  return BROKEN.test(output);
}

const COUNT_PATTERNS: readonly [RegExp, RegExp][] = [
  // node --test (spec and tap reporters)
  [/^[#ℹ] fail (\d+)$/m, /^[#ℹ] pass (\d+)$/m],
  // vitest, jest, pytest, mocha
  [/(\d+) fail(?:ed|ing)\b/, /(\d+) pass(?:ed|ing)\b/],
];

/** Passing and failing test counts from a runner's summary, when it prints one. */
export function testCounts(output: string): { pass: number; fail: number } | undefined {
  for (const [failRe, passRe] of COUNT_PATTERNS) {
    const fail = failRe.exec(output)?.[1];
    const pass = passRe.exec(output)?.[1];
    if (fail !== undefined || pass !== undefined)
      return { pass: Number(pass ?? 0), fail: Number(fail ?? 0) };
  }
  return undefined;
}

/**
 * More than this share of spec tests failing on code that already passed the project's own
 * gates says the suite is wrong, not the code (bench: a suite read `.code` off `assert.throws`,
 * which returns nothing, and 12 tests failed on correct code).
 */
export const MAX_FAIL_SHARE = 0.5;

export function suiteImplausible(counts: { pass: number; fail: number } | undefined): boolean {
  if (!counts) return false;
  const total = counts.pass + counts.fail;
  return total > 0 && counts.fail / total > MAX_FAIL_SHARE;
}

/**
 * ============================================================================
 * Step 5.1 — Symptom-focused reproduction test synthesizer.
 *
 * When a bug report reaches the pipeline, a model writes a standalone test that
 * reproduces the *observed* symptom. The prompt is built from the issue body,
 * the stack trace, the suspect function's interface excerpt, and the nearest
 * existing test patterns — and it is explicitly scrubbed of causal/fix clues so
 * the writer cannot lean on the intended fix (synthesizer bias). The writer
 * returns a structured answer: either a valid test body or a typed
 * "insufficient_evidence" refusal.
 * ============================================================================
 */

/** Directory (repo root) that generated reproduction tests are written to. */
export const REPRO_DIR = '.omnexx-repro';
/** Prefix for generated reproduction test files in that directory. */
export const REPRO_FILE_PREFIX = '__repro_';
/** Hard cap on a generated reproduction test body. */
export const REPRO_MAX_FILE_CHARS = 24_000;
/** A stack trace or a non-trivial issue body is enough to ask the writer. */
const MIN_SYMPTOM_LEN = 40;

/** What the synthesizer has to work with. The issue is the only required field. */
export interface ReproEvidence {
  /** The issue/report text (what the user observed), before causal scrubbing. */
  issue: string;
  /** Stack trace attached to the report, when the harness captured one. */
  stackTrace?: string;
  /** Suspect function source excerpt (signature + nearby lines) for the writer. */
  suspectExcerpt?: string;
  /** Nearest existing test files the writer may mirror (bodies are allowed here). */
  nearestTests?: string;
}

/** Section headers after which the whole block is a cause/fix note; dropped until a blank line. */
const CAUSE_SECTION =
  /^(?:root cause|cause|why|why it happens|fix|solution|resolution|patch|what i changed|how i fixed)[:\-….]?\s*$/i;
/** Inline phrases that betray the cause or the intended fix. */
const CAUSE_PHRASE =
  /\b(?:this is because|that is because|because of|caused by|due to|root cause|reason is|the bug is caused|the fix (?:is|was)|fixed by|was fixed|(?:the |a )?patch(?:ed)? (?:is|was|fixes)|fix is|the solution is|the real issue is|underlying issue is)\b/i;

export interface StrippedReport {
  /** The report with causal/fix clues removed. */
  text: string;
  /** The lines that were removed. */
  removed: readonly string[];
}

/**
 * Remove statements that reveal the root cause or the intended fix, keeping only
 * the observable symptom. This is the anti-bias gate for the synthesizer: the
 * writer must never see how the bug is caused or how it will be fixed.
 */
export function stripCausalClues(report: string): StrippedReport {
  const kept: string[] = [];
  const removed: string[] = [];
  let inCauseSection = false;
  for (const raw of report.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      inCauseSection = false;
      kept.push(raw);
      continue;
    }
    if (CAUSE_SECTION.test(line)) {
      inCauseSection = true;
      removed.push(raw);
      continue;
    }
    if (inCauseSection || CAUSE_PHRASE.test(line)) {
      removed.push(raw);
      continue;
    }
    kept.push(raw);
  }
  const text = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, removed };
}

/**
 * Build the symptom-focused writer prompt. Fix clues are stripped from the issue
 * before anything is sent; the stack trace and interface excerpt are passed
 * through untouched.
 */
export function buildReproPrompt(evidence: ReproEvidence): StrippedReport & { prompt: string } {
  const stripped = stripCausalClues(evidence.issue);
  const parts: string[] = [
    `# Symptom (observed behaviour)\n${stripped.text || '(no usable symptom text)'}`,
  ];
  const trace = evidence.stackTrace?.trim();
  if (trace !== undefined && trace !== '') parts.push(`# Stack trace\n${trace}`);
  const excerpt = evidence.suspectExcerpt?.trim();
  if (excerpt !== undefined && excerpt !== '')
    parts.push(`# Suspect function (interface excerpt)\n${excerpt}`);
  const tests = evidence.nearestTests?.trim();
  if (tests !== undefined && tests !== '')
    parts.push(`# Nearest test patterns (mirror these)\n${tests.slice(0, 12_000)}`);
  return { ...stripped, prompt: parts.join('\n\n') };
}

/** Structured output for the synthesizer: a test body, or a typed refusal. */
export const reproResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    testContent: z.string().min(10).max(REPRO_MAX_FILE_CHARS),
  }),
  z.object({
    status: z.literal('insufficient_evidence'),
    reason: z.string().min(1).max(1_000),
  }),
]);
export type ReproResult = z.infer<typeof reproResultSchema>;

/** Validate the writer's structured answer; a string means it was unusable. */
export function parseReproResult(input: unknown): ReproResult | string {
  const r = reproResultSchema.safeParse(input);
  if (!r.success) return z.prettifyError(r.error).slice(0, 400);
  return r.data;
}

/** Whether there is enough evidence to ask the writer at all. */
export function reproEvidenceSufficient(evidence: ReproEvidence): boolean {
  const trace = evidence.stackTrace ?? '';
  return evidence.issue.trim().length >= MIN_SYMPTOM_LEN || trace.trim().length > 0;
}

const REPRO_WRITER_SYSTEM = `You write a standalone reproduction test for a software bug, from its symptom only.
You never see the cause or the intended fix: the report is already stripped of fix clues. If the remaining
symptom is not something a test could reliably assert (it depends on timing you cannot control, external
services, or has no concrete observable failure), answer {"status":"insufficient_evidence","reason":"..."}
instead of guessing.

Write one Vitest test file ("*.test.ts") under ${REPRO_DIR}/ that fails today on the buggy code and would pass
once the bug is fixed:
- assert the *observable* broken behaviour described in the symptom, not a mechanism;
- use only the public API and fixtures the symptom implies exist;
- do NOT import vi, beforeEach or afterEach — determinism controls are already injected by the harness;
- keep the file self-contained and runnable by \`vitest run\`.

Reply only by calling the answer tool.`;

/** Single synthesizer call: the writer's structured answer, or undefined on failure (fail open). */
export async function synthesizeRepro(
  run: Run,
  evidence: ReproEvidence,
): Promise<ReproResult | undefined> {
  if (!reproEvidenceSufficient(evidence)) {
    return {
      status: 'insufficient_evidence',
      reason: 'no reproducible symptom (issue body or stack trace) given',
    };
  }
  const { prompt } = buildReproPrompt(evidence);
  try {
    const ask = (text: string) =>
      askTool(
        run,
        REPRO_WRITER_SYSTEM,
        text,
        reproResultSchema,
        'repro_synth',
        REPRO_WRITER_MAX_TOKENS,
      );
    const first = parseReproResult(await ask(prompt));
    if (typeof first !== 'string') return first;
    const second = parseReproResult(
      await ask(
        `${prompt}\n\nYour last answer was unusable (${first}). Reply only via the answer tool with exactly {"status":...}.`,
      ),
    );
    if (typeof second !== 'string') return second;
    run.events.emit('repro_synth.unavailable', { error: second });
    return undefined;
  } catch (err) {
    run.events.emit('repro_synth.unavailable', { error: (err as Error).message });
    return undefined;
  }
}

/**
 * ============================================================================
 * Step 5.2 — Determinism controls & test file isolation.
 *
 * Generated reproduction tests are written to a dedicated, git-excluded
 * directory with a content-hashed name, and are wrapped in determinism mocks
 * (fake timers, a seeded PRNG, NODE_ENV=test) so they behave identically on
 * every run.
 * ============================================================================
 */

const REPRO_WRITER_MAX_TOKENS = 14_000;
/** How many hex characters of the content hash seed the injected PRNG. */
const REPRO_SEED_HEX = 16;
/** The exact line added to .git/info/exclude (trailing slash = whole directory). */
export const REPRO_GIT_EXCLUDE_LINE = `${REPRO_DIR}/`;

/** sha256 hex digest of a string (used for filenames and PRNG seeds). */
export function reproSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The deterministic file name for a generated test: __repro_<sha256>.test.ts. */
export function reproFileName(content: string): string {
  return `${REPRO_FILE_PREFIX}${reproSha256(content)}.test.ts`;
}

/** Full path of a generated test inside a repo root. */
export function reproTestPath(repoRoot: string, content: string): string {
  return join(repoRoot, REPRO_DIR, reproFileName(content));
}

/** The determinism preamble injected at the top of every generated reproduction test. */
export function determinismPreamble(content: string): string {
  const seed = reproSha256(content).slice(0, REPRO_SEED_HEX);
  return [
    '// Determinism controls injected by omnexx (repro synthesizer). Do not edit.',
    "process.env.NODE_ENV = 'test';",
    '',
    "import { afterEach, beforeEach, vi } from 'vitest';",
    '',
    `const SEED = 0x${seed};`,
    '',
    '/** Deterministic PRNG (mulberry32): the test never depends on ambient randomness. */',
    'function seededRandom(seed = SEED): () => number {',
    '  let a = seed >>> 0;',
    '  return () => {',
    '    a |= 0; a = (a + 0x6D2B79F5) | 0;',
    '    let t = Math.imul(a ^ (a >>> 15), 1 | a);',
    '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;',
    '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;',
    '  };',
    '}',
    '',
    'beforeEach(() => {',
    '  vi.useFakeTimers();',
    "  vi.spyOn(Math, 'random').mockImplementation(seededRandom(SEED));",
    '});',
    '',
    'afterEach(() => {',
    '  vi.restoreAllMocks();',
    '  vi.useRealTimers();',
    '});',
    '',
  ].join('\n');
}

/** Prepend the determinism controls to a generated test body. */
export function injectDeterminism(testContent: string): string {
  const trimmed = testContent.trimStart();
  return determinismPreamble(testContent) + trimmed + (trimmed.endsWith('\n') ? '' : '\n');
}

/**
 * Write a generated test (with determinism inject) to `.omnexx-repro/` and
 * return its path. The file name is derived from the raw content hash, so the
 * same test is idempotent and never clobbers a different one.
 */
export async function writeReproTest(repoRoot: string, content: string): Promise<string> {
  const injected = injectDeterminism(content);
  const dir = join(repoRoot, REPRO_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, reproFileName(content));
  await writeFile(path, injected, 'utf8');
  return path;
}

/**
 * Ensure `.omnexx-repro/` is ignored by git by adding it to `.git/info/exclude`
 * (a local, per-repo ignore that stays out of tracked files). Returns whether the
 * exclude file changed. Idempotent.
 */
export async function ensureGitExclude(repoRoot: string): Promise<boolean> {
  const infoDir = join(repoRoot, '.git', 'info');
  await mkdir(infoDir, { recursive: true });
  const excludePath = join(infoDir, 'exclude');
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf8');
  } catch {
    /* ignore a missing exclude file: it will be created */
  }
  if (existing.split('\n').some((line) => line.trim() === REPRO_GIT_EXCLUDE_LINE)) return false;
  const body = existing.trimEnd();
  const next = `${body}${body ? '\n' : ''}${REPRO_GIT_EXCLUDE_LINE}\n`;
  await writeFile(excludePath, next, 'utf8');
  return true;
}
