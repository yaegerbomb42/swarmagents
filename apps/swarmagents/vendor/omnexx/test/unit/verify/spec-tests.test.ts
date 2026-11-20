import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema } from '../../../src/config/schema.js';
import type { Run } from '../../../src/core/run.js';
import {
  buildReproPrompt,
  countRequirements,
  determinismPreamble,
  ensureGitExclude,
  injectDeterminism,
  parseReproResult,
  parseSuite,
  publicInterface,
  reproEvidenceSufficient,
  reproFileName,
  reproSha256,
  reproTestPath,
  specTestsWanted,
  stripCausalClues,
  suiteBroken,
  suiteImplausible,
  synthesizeRepro,
  testCounts,
  writeReproTest,
} from '../../../src/verify/spec-tests.js';
import type { ReproEvidence } from '../../../src/verify/spec-tests.js';

const config = (review: object = {}, plan: object = {}) =>
  configSchema.parse({ review: { spec_tests: 'auto', ...review }, plan });
const LIST = ['1. add', '2. remove', '- list', '* count', '3) reserve'].join('\n');

describe('specTestsWanted', () => {
  it('auto: wants spec tests for a goal listing several requirements', () => {
    expect(countRequirements(LIST)).toBe(5);
    expect(specTestsWanted(config(), `Build it:\n${LIST}`, false)).toBe(true);
  });

  it('auto: skips a short goal with few requirements', () => {
    expect(specTestsWanted(config(), 'Fix the typo in README.', false)).toBe(false);
  });

  it('auto: wants them for a goal above the fast-path size', () => {
    const cfg = config({}, { fast_max_goal_chars: 10 });
    expect(specTestsWanted(cfg, 'a long goal here', false)).toBe(true);
  });

  it('on and off override the size check; writing runs never get them', () => {
    expect(specTestsWanted(config({ spec_tests: 'on' }), 'tiny', false)).toBe(true);
    expect(specTestsWanted(config({ spec_tests: 'off' }), LIST, false)).toBe(false);
    expect(specTestsWanted(config({ spec_tests: 'on' }), LIST, true)).toBe(false);
  });
});

describe('publicInterface', () => {
  it('keeps exported signatures and method headers but never bodies', () => {
    const text = [
      'export class InventoryError extends Error {',
      '  constructor(code, message) {',
      '    super(message);',
      '  }',
      '}',
      'export function createInventory() {',
      '  const stock = new Map();',
      '  return {',
      '    fulfil(id) {',
      '      if (available(sku) < qty) throw new Error("x");',
      '    },',
      '  };',
      '}',
    ].join('\n');
    const out = publicInterface([
      { path: 'src/index.js', text },
      { path: 'test/index.test.js', text: 'export function secret() {}' },
    ]);
    expect(out).toContain('## src/index.js');
    expect(out).toContain('export class InventoryError extends Error');
    expect(out).toContain('export function createInventory()');
    expect(out).toContain('fulfil(id)');
    expect(out).not.toContain('available(sku)');
    expect(out).not.toContain('new Map');
    expect(out).not.toContain('secret');
  });

  it('cuts an oversized interface', () => {
    const text = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    expect(publicInterface([{ path: 'a.ts', text }], 100)).toMatch(/interface cut/);
  });
});

describe('parseSuite', () => {
  const file = { path: 'omnexx-spec/a.test.mjs', content: 'import test from "node:test";' };
  const command = 'node --test omnexx-spec/';

  it('accepts files under the spec dir and a command that runs them', () => {
    expect(parseSuite({ command, files: [file] })).toEqual({ command, files: [file] });
  });

  it('refuses paths outside the spec dir, traversal, and commands that ignore it', () => {
    expect(parseSuite({ command, files: [{ ...file, path: 'src/a.js' }] })).toMatch(/paths/);
    expect(parseSuite({ command, files: [{ ...file, path: 'omnexx-spec/../x' }] })).toMatch(
      /paths/,
    );
    expect(parseSuite({ command: 'npm test', files: [file] })).toMatch(/must run the files/);
    expect(parseSuite({ command: `${command}\nrm -rf x`, files: [file] })).toMatch(/one line/);
    expect(parseSuite({})).toBeTypeOf('string');
    expect(parseSuite(undefined)).toBe('no answer object');
  });

  it('keeps the first files of a suite over the cap', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      ...file,
      path: `omnexx-spec/t${i}.mjs`,
    }));
    const suite = parseSuite({ command, files });
    expect(typeof suite === 'string' ? suite : suite.files).toHaveLength(8);
  });
});

describe('defaults', () => {
  it('defaults to auto, with one fix round of at most 3 cycles', () => {
    const review = configSchema.parse({}).review;
    expect(review).toMatchObject({
      spec_tests: 'auto',
      spec_tests_max_rounds: 1,
      spec_tests_max_cycles: 3,
    });
  });
});

describe('testCounts and suiteImplausible', () => {
  it('reads node --test, tap, vitest and pytest summaries', () => {
    expect(testCounts('ℹ tests 14\nℹ pass 2\nℹ fail 12')).toEqual({ pass: 2, fail: 12 });
    expect(testCounts('# pass 3\n# fail 0')).toEqual({ pass: 3, fail: 0 });
    expect(testCounts('Tests  2 failed | 5 passed (7)')).toEqual({ pass: 5, fail: 2 });
    expect(testCounts('==== 1 failed, 9 passed in 0.2s')).toEqual({ pass: 9, fail: 1 });
    expect(testCounts('Segmentation fault')).toBeUndefined();
  });

  it('calls a suite wrong when most of it fails on green code', () => {
    expect(suiteImplausible({ pass: 2, fail: 12 })).toBe(true);
    expect(suiteImplausible({ pass: 38, fail: 2 })).toBe(false);
    expect(suiteImplausible({ pass: 1, fail: 1 })).toBe(false);
    expect(suiteImplausible(undefined)).toBe(false);
  });
});

describe('suiteBroken', () => {
  it('tells a suite that never ran from one that failed', () => {
    expect(suiteBroken('No test files found, exiting with code 1')).toBe(true);
    expect(suiteBroken('not ok 1 - fulfil ships reserved stock')).toBe(false);
  });
});

describe('stripCausalClues & buildReproPrompt', () => {
  it('removes fix/cause statements but keeps the observable symptom', () => {
    const report = [
      'The list shows duplicate entries after refresh.',
      'Root cause: the reducer mutates state in place.',
      'Fixed by adding an immutable copy.',
      'Steps: open page, click refresh, see duplicates.',
    ].join('\n');
    const { text, removed } = stripCausalClues(report);
    expect(text).toContain('The list shows duplicate entries');
    expect(text).toContain('open page, click refresh');
    expect(text).not.toContain('Root cause');
    expect(text).not.toContain('Fixed by');
    expect(removed).toHaveLength(2);
  });

  it('builds a symptom-focused prompt with trace and interface but no fix clues', () => {
    const evidence: ReproEvidence = {
      issue:
        'Credit transaction lands twice when retried after a timeout.\nRoot cause: the idempotency key is regenerated per attempt.',
      stackTrace: 'at submitTx (src/pay.ts:41)',
      suspectExcerpt: 'submitTx(input: TxInput): Promise<Tx>',
    };
    const { prompt } = buildReproPrompt(evidence);
    expect(prompt).toContain('lands twice');
    expect(prompt).toContain('at submitTx');
    expect(prompt).toContain('submitTx(input: TxInput)');
    expect(prompt).not.toContain('Root cause');
  });
});

describe('parseReproResult', () => {
  it('accepts ok and insufficient_evidence shapes; rejects anything else', () => {
    const ok = { status: 'ok' as const, testContent: 'x'.repeat(20) };
    expect(parseReproResult(ok)).toEqual(ok);
    const insufficient = { status: 'insufficient_evidence' as const, reason: 'flaky timing' };
    expect(parseReproResult(insufficient)).toEqual(insufficient);
    expect(typeof parseReproResult({ status: 'ok' })).toBe('string');
    expect(typeof parseReproResult({ status: 'maybe' })).toBe('string');
    expect(typeof parseReproResult(null)).toBe('string');
  });
});

describe('reproEvidenceSufficient', () => {
  it('requires a long enough symptom or a stack trace', () => {
    const long =
      'A very long reproducible symptom: the queue overflows after 1000 enqueues and throws RangeError here.';
    expect(reproEvidenceSufficient({ issue: long })).toBe(true);
    expect(reproEvidenceSufficient({ issue: 'short' })).toBe(false);
    expect(
      reproEvidenceSufficient({ issue: 'short', stackTrace: 'at overflow (queue.ts:10)' }),
    ).toBe(true);
  });
});

function scriptedReproRun(answers: unknown[]) {
  const prompts: string[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const run = {
    config: { review: { spec_tests_models: 'planner' }, context: {} },
    redactor: { text: (text: string) => text },
    events: {
      emit: (type: string, data: Record<string, unknown> = {}) => {
        events.push({ type, data });
      },
    },
    cheapComplete: (req: { messages: { content: { text: string }[] }[] }) => {
      prompts.push(req.messages[0]?.content[0]?.text ?? '');
      return Promise.resolve({
        res: {
          content: [{ type: 'tool_use', id: 'a', name: 'answer', input: answers.shift() }],
          stopReason: 'tool_use',
        },
        model: { provider: 'p', id: 'm' },
      });
    },
  } as unknown as Run;
  return { run, prompts, events };
}

describe('synthesizeRepro', () => {
  const symptom =
    'When I reserve stock twice in one session it ships double quantity on the second call.';

  it('returns the structured test from a symptom-focused prompt with fix clues stripped', async () => {
    const testContent =
      'import { expect, it } from "vitest";\nit("fails today", () => { expect(1).toBe(2); });';
    const { run, prompts } = scriptedReproRun([{ status: 'ok', testContent }]);
    const evidence: ReproEvidence = {
      issue: `${symptom}\nRoot cause: the reservation re-checks available stock after lowering it.`,
      stackTrace: 'at fulfil (src/index.js:42:11)',
      suspectExcerpt: 'fulfil(id) {',
      nearestTests: 'describe("reservation")',
    };
    const result = await synthesizeRepro(run, evidence);
    expect(result).toEqual({ status: 'ok', testContent });
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0] ?? '').not.toContain('Root cause');
    expect(prompts[0] ?? '').toContain('ships double quantity');
  });

  it('short-circuits to insufficient_evidence without calling the model', async () => {
    const { run, prompts } = scriptedReproRun([]);
    const result = await synthesizeRepro(run, { issue: 'tiny' });
    expect(result).toMatchObject({ status: 'insufficient_evidence' });
    expect(prompts).toHaveLength(0);
  });

  it('retries once when the first answer is unusable', async () => {
    const ok = { status: 'ok' as const, testContent: 'it("t", () => { expect(1).toBe(1); });' };
    const { run, prompts } = scriptedReproRun([{}, ok]);
    const result = await synthesizeRepro(run, { issue: symptom });
    expect(result).toEqual(ok);
    expect(prompts).toHaveLength(2);
  });

  it('fails open and emits an event when the call rejects', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const run = {
      config: { review: { spec_tests_models: 'planner' }, context: {} },
      redactor: { text: (text: string) => text },
      events: {
        emit: (type: string, data: Record<string, unknown> = {}) => {
          events.push({ type, data });
        },
      },
      cheapComplete: () => Promise.reject(new Error('boom')),
    } as unknown as Run;
    const result = await synthesizeRepro(run, { issue: symptom });
    expect(result).toBeUndefined();
    expect(events).toEqual([{ type: 'repro_synth.unavailable', data: { error: 'boom' } }]);
  });
});

describe('repro hashing & naming', () => {
  it('sha256 is stable hex; filename matches the required shape', () => {
    expect(reproSha256('abc')).toBe(reproSha256('abc'));
    expect(reproSha256('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(reproFileName('abc')).toMatch(/^__repro_[0-9a-f]{64}\.test\.ts$/);
  });
});

describe('determinismPreamble & injectDeterminism', () => {
  it('injects fixed timers, a PRNG seed and NODE_ENV=test', () => {
    const body = 'it("works", () => { expect(1).toBe(1); });';
    const out = injectDeterminism(body);
    expect(out).toContain("process.env.NODE_ENV = 'test'");
    expect(out).toContain('vi.useFakeTimers()');
    expect(out).toContain('seededRandom');
    expect(out).toContain('const SEED = 0x');
    expect(out).toContain('vi.restoreAllMocks()');
    expect(out).toContain('vi.useRealTimers()');
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain(body.trim());
    expect(determinismPreamble('a')).not.toBe(determinismPreamble('b'));
  });
});

describe('git exclusion + reproduction file isolation', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omnexx-repro-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds .omnexx-repro/ to .git/info/exclude exactly once', async () => {
    await mkdir(join(dir, '.git', 'info'), { recursive: true });
    await writeFile(join(dir, '.git', 'info', 'exclude'), '# git exclude\n', 'utf8');
    expect(await ensureGitExclude(dir)).toBe(true);
    expect(await ensureGitExclude(dir)).toBe(false);
    const exclude = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8');
    const matches = exclude.split('\n').filter((line) => line.trim() === '.omnexx-repro/');
    expect(matches).toHaveLength(1);
  });

  it('writes an injected reproduction test under .omnexx-repro/ with a hashed name', async () => {
    const body = 'it("r", () => { expect(1).toBe(1); });';
    const written = await writeReproTest(dir, body);
    expect(written).toBe(reproTestPath(dir, body));
    expect(written).toMatch(/__repro_[0-9a-f]{64}\.test\.ts$/);
    const content = await readFile(written, 'utf8');
    expect(content).toContain("process.env.NODE_ENV = 'test'");
    expect(content).toContain('vi.useFakeTimers()');
  });
});
