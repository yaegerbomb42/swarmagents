import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, beforeAll } from 'vitest';
import { BuiltinExtractor } from '../../../src/core/repomap/builtin.js';
import { buildRepoGraph } from '../../../src/core/repomap/graph.js';
import { buildRepoMap } from '../../../src/core/repomap/index.js';
import { personalizedPageRank } from '../../../src/core/repomap/rank.js';
import { renderRepoMap } from '../../../src/core/repomap/render.js';
import { collapseSignature } from '../../../src/core/repomap/signature.js';
import { parseStackTrace, sliceContext } from '../../../src/core/repomap/slice.js';
import { TreeSitterExtractor } from '../../../src/core/repomap/tree-sitter.js';
import type { FileExtraction, RepoTag } from '../../../src/core/repomap/types.js';
import type { Run } from '../../../src/core/run.js';
import { estimateTokens } from '../../../src/core/tokens.js';

const TS_FIXTURE = `export function chargeCard(amount: number, currency: string): Promise<Receipt> {
  const tax = computeTax(amount);
  return formatReceipt(tax, currency);
}

class PaymentService {
  private readonly gateway: Gateway;
  async charge(order: Order): Promise<Receipt> {
    return chargeCard(order.total, order.currency);
  }
}

interface Gateway {
  charge(amount: number): Promise<string>;
}

export type Currency = 'USD' | 'EUR';

enum ReceiptStatus {
  Paid,
  Failed,
}

export const DEFAULT_CURRENCY = 'USD';

const helper = async (n: number): Promise<number> => n * 2;

function outer() {
  const inner = 1;
  return inner + chargeCard(inner, DEFAULT_CURRENCY);
}
`;

const PY_FIXTURE = `class PaymentService:
    def charge(self, order):
        return charge_card(order.total)

UPPER_LIMIT = 100

def main():
    service = PaymentService()
    service.charge(order)
`;

const GO_FIXTURE = `package payments

type Config struct {
\tCurrency string
}

type Runner interface {
\tRun() error
}

func NewConfig() *Config {
\treturn &Config{}
}

func charge(cfg *Config) error {
\treturn cfg.String()
}
`;

describe('collapseSignature', () => {
  const lines = TS_FIXTURE.split('\n');
  it('collapses a multi-line generic return type without the body', () => {
    const sig = collapseSignature(lines, 1);
    expect(sig).toBe(
      'export function chargeCard(amount: number, currency: string): Promise<Receipt>',
    );
  });
  it('shows a class head without members', () => {
    const sig = collapseSignature(lines, 6);
    expect(sig).toBe('class PaymentService');
  });
  it('shows an interface head', () => {
    const sig = collapseSignature(lines, 13);
    expect(sig).toBe('interface Gateway');
  });
  it('keeps a single-line object type intact', () => {
    const sig = collapseSignature(['type X = { ok: boolean };'], 1);
    expect(sig).toBe('type X = { ok: boolean }');
  });
  it('collapses a python def to one line', () => {
    const src = [
      'def charge(self, order: Order,',
      '             dry_run: bool = False) -> Receipt:',
      '    return run()',
    ];
    expect(collapseSignature(src, 1)).toBe(
      'def charge(self, order: Order, dry_run: bool = False) -> Receipt:',
    );
  });
  it('cuts at the body brace after an object-typed generic', () => {
    const src = [
      'export async function astForFile(',
      '  cache: AstCache,',
      '): Promise<{ hit: boolean } | undefined> {',
      '  const x = 1;',
    ];
    expect(collapseSignature(src, 1)).toBe(
      'export async function astForFile( cache: AstCache, ): Promise<{ hit: boolean } | undefined>',
    );
  });
});

describe('tree-sitter extraction', () => {
  let extractor: TreeSitterExtractor | null = null;
  beforeAll(async () => {
    extractor = await TreeSitterExtractor.create();
  });

  const defNames = (tags: readonly RepoTag[]): string[] =>
    tags.filter((t) => t.kind === 'definition').map((t) => t.name);

  it('extracts TS definitions and filters function-local consts', () => {
    if (!extractor) return; // optional backend missing: covered by builtin test
    const out = extractor.extract('payments/charge.ts', TS_FIXTURE);
    expect(out.error).toBeUndefined();
    const names = defNames(out.tags);
    expect(names).toContain('chargeCard');
    expect(names).toContain('PaymentService');
    expect(names).toContain('charge');
    expect(names).toContain('Gateway');
    expect(names).toContain('Currency');
    expect(names).toContain('ReceiptStatus');
    expect(names).toContain('DEFAULT_CURRENCY');
    expect(names).toContain('helper');
    expect(names).toContain('outer');
    expect(names).not.toContain('inner');
  });

  it('extracts references with lines', () => {
    if (!extractor) return;
    const out = extractor.extract('payments/charge.ts', TS_FIXTURE);
    const refs = out.tags.filter((t) => t.kind === 'reference').map((t) => t.name);
    expect(refs).toContain('chargeCard');
    expect(refs).toContain('computeTax');
    expect(refs).toContain('formatReceipt');
    expect(refs).toContain('Gateway');
  });

  it('extracts python definitions', () => {
    if (!extractor) return;
    const out = extractor.extract('payments/service.py', PY_FIXTURE);
    const names = defNames(out.tags);
    expect(names).toContain('PaymentService');
    expect(names).toContain('charge');
    expect(names).toContain('UPPER_LIMIT');
    expect(names).toContain('main');
  });

  it('extracts go definitions incl. interface methods', () => {
    if (!extractor) return;
    const out = extractor.extract('payments/config.go', GO_FIXTURE);
    const names = defNames(out.tags);
    expect(names).toContain('Config');
    expect(names).toContain('Runner');
    expect(names).toContain('NewConfig');
    expect(names).toContain('charge');
    expect(names).toContain('Run');
  });

  it('captures endLine for slicing', () => {
    if (!extractor) return;
    const out = extractor.extract('payments/charge.ts', TS_FIXTURE);
    const fn = out.tags.find((t) => t.kind === 'definition' && t.name === 'chargeCard');
    if (!fn) throw new Error('chargeCard definition not extracted');
    expect(fn.endLine).toBeGreaterThan(fn.line);
  });
});

describe('builtin extraction', () => {
  const builtin = new BuiltinExtractor();
  it('finds TS definitions without dependencies', () => {
    const out = builtin.extract('payments/charge.ts', TS_FIXTURE);
    const names = out.tags.filter((t) => t.kind === 'definition').map((t) => t.name);
    for (const expected of [
      'chargeCard',
      'PaymentService',
      'Gateway',
      'DEFAULT_CURRENCY',
      'helper',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('inner');
  });
  it('finds python defs and constants', () => {
    const out = builtin.extract('payments/service.py', PY_FIXTURE);
    const names = out.tags.filter((t) => t.kind === 'definition').map((t) => t.name);
    expect(names).toContain('PaymentService');
    expect(names).toContain('charge');
    expect(names).toContain('UPPER_LIMIT');
    expect(names).toContain('main');
  });
  it('finds go funcs and types', () => {
    const out = builtin.extract('payments/config.go', GO_FIXTURE);
    const names = out.tags.filter((t) => t.kind === 'definition').map((t) => t.name);
    expect(names).toContain('Config');
    expect(names).toContain('Runner');
    expect(names).toContain('NewConfig');
    expect(names).toContain('charge');
  });
});

function extraction(path: string, tags: Partial<RepoTag>[]): FileExtraction {
  return {
    path,
    language: 'typescript',
    engine: 'builtin',
    imports: [],
    tags: tags.map((t) => {
      const name = t.name ?? 'anonymous';
      return {
        path,
        name,
        kind: t.kind ?? 'definition',
        ...(t.defKind ? { defKind: t.defKind } : {}),
        line: t.line ?? 1,
        endLine: t.endLine ?? t.line ?? 1,
        text: t.text ?? name,
      };
    }),
  };
}

describe('graph building and ranking', () => {
  const extractions: FileExtraction[] = [
    extraction('src/a.ts', [
      { name: 'aMain', kind: 'definition', defKind: 'function', line: 1, endLine: 4 },
      { name: 'helper', kind: 'reference', line: 2 },
    ]),
    extraction('src/b.ts', [
      { name: 'helper', kind: 'definition', defKind: 'function', line: 1, endLine: 4 },
    ]),
    extraction('src/c.ts', [{ name: 'aMain', kind: 'reference', line: 1 }]),
  ];

  it('connects files that reference definitions elsewhere', () => {
    const graph = buildRepoGraph(extractions);
    expect(graph.outbound.get('src/a.ts')?.get('src/b.ts')).toBeCloseTo(1);
    expect(graph.outbound.get('src/c.ts')?.get('src/a.ts')).toBeCloseTo(1);
  });

  it('ranks referenced files higher', () => {
    const graph = buildRepoGraph(extractions);
    const ranked = personalizedPageRank(graph, {});
    const order = ranked.map((r) => r.path);
    expect(order.indexOf('src/b.ts')).toBeLessThan(order.indexOf('src/c.ts'));
  });

  it('is deterministic', () => {
    const graph = buildRepoGraph(extractions);
    const a = personalizedPageRank(graph, { seedIdentifiers: ['helper'] });
    const b = personalizedPageRank(graph, { seedIdentifiers: ['helper'] });
    expect(a).toEqual(b);
  });

  it('lifts the file defining a seeded identifier', () => {
    const graph = buildRepoGraph(extractions);
    const neutral = personalizedPageRank(graph, {});
    const seeded = personalizedPageRank(graph, {
      seedIdentifiers: ['helper'],
      seedSymbolBoost: 25,
    });
    const rankOf = (rs: typeof neutral, p: string): number =>
      rs.find((r) => r.path === p)?.rank ?? -1;
    expect(rankOf(seeded, 'src/b.ts')).toBeGreaterThan(rankOf(neutral, 'src/b.ts'));
  });

  it('ranks sum to ~1', () => {
    const graph = buildRepoGraph(extractions);
    const ranked = personalizedPageRank(graph, {});
    const total = ranked.reduce((s, r) => s + r.rank, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('renderRepoMap', () => {
  const graph = buildRepoGraph([
    extraction('src/hot.ts', [
      {
        name: 'hotOne',
        kind: 'definition',
        defKind: 'function',
        line: 1,
        text: 'export function hotOne(): void',
      },
      {
        name: 'hotTwo',
        kind: 'definition',
        defKind: 'function',
        line: 5,
        text: 'export function hotTwo(): void',
      },
    ]),
    extraction('src/cold.ts', [
      {
        name: 'coldOne',
        kind: 'definition',
        defKind: 'function',
        line: 1,
        text: 'export function coldOne(): void',
      },
    ]),
  ]);
  const ranked = personalizedPageRank(graph, {});

  it('stays inside the token budget', () => {
    for (const budget of [64, 128, 256, 1024]) {
      const out = renderRepoMap(graph, ranked, { tokenBudget: budget });
      expect(out.tokens).toBeLessThanOrEqual(budget);
    }
  });

  it('pins requested files even when they would rank last', () => {
    const out = renderRepoMap(graph, ranked, {
      tokenBudget: 128,
      pinFiles: ['src/cold.ts'],
      pinBudgetFraction: 0.9,
    });
    expect(out.text).toContain('src/cold.ts');
    expect(out.text).toContain('coldOne');
  });

  it('spreads coverage with maxSymbolsPerFile', () => {
    const out = renderRepoMap(graph, ranked, {
      tokenBudget: 200,
      maxSymbolsPerFile: 1,
      maxSignatureChars: 80,
    });
    expect(out.filesIncluded).toBeGreaterThanOrEqual(2);
  });

  it('renders nothing-relevant gracefully for an empty graph', () => {
    const empty = buildRepoGraph([extraction('src/x.ts', [])]);
    const out = renderRepoMap(empty, personalizedPageRank(empty, {}), {});
    expect(out.symbolsTotal).toBe(0);
    expect(out.tokens).toBe(0);
  });
});

const SLICE_TS_A = `import { computeTax } from './b.js';
export function checkout(total: number): number {
  return computeTax(total);
}
`;
const SLICE_TS_B = `import { fetchRate } from './c.js';
export function computeTax(total: number): number {
  const rate = fetchRate();
  return total * rate;
}
`;
const SLICE_TS_C = `export function fetchRate(): number {
  return 0.2;
}
`;

describe('sliceContext', () => {
  const builtin = new BuiltinExtractor();
  const extractions = [
    builtin.extract('src/a.ts', SLICE_TS_A),
    builtin.extract('src/b.ts', SLICE_TS_B),
    builtin.extract('src/c.ts', SLICE_TS_C),
  ];
  const sources = new Map([
    ['src/a.ts', SLICE_TS_A],
    ['src/b.ts', SLICE_TS_B],
    ['src/c.ts', SLICE_TS_C],
  ]);

  it('walks the call graph outward from the seed symbol', () => {
    const out = sliceContext(extractions, sources, {
      seeds: [{ kind: 'symbol', name: 'fetchRate' }],
      maxHops: 2,
      direction: 'callers',
    });
    expect(out.text).toContain('src/c.ts');
    expect(out.text).toContain('src/b.ts');
    expect(out.text).toContain('src/a.ts');
    expect(out.seedCount).toBe(1);
  });

  it('respects maxHops', () => {
    const out = sliceContext(extractions, sources, {
      seeds: [{ kind: 'symbol', name: 'fetchRate' }],
      maxHops: 1,
      direction: 'callers',
    });
    expect(out.text).toContain('src/b.ts');
    expect(out.text).not.toContain('src/a.ts');
  });

  it('resolves a location seed to its enclosing function', () => {
    const out = sliceContext(extractions, sources, {
      seeds: [{ kind: 'location', path: 'src/b.ts', line: 3 }],
      maxHops: 0,
    });
    expect(out.text).toContain('computeTax');
    expect(out.text).not.toContain('checkout');
  });

  it('truncates under a tiny token budget', () => {
    const out = sliceContext(extractions, sources, {
      seeds: [{ kind: 'symbol', name: 'fetchRate' }],
      maxHops: 2,
      tokenBudget: 10,
    });
    expect(out.truncated).toBe(true);
  });
});

describe('parseStackTrace', () => {
  it('parses V8 frames with file:line:col', () => {
    const seeds = parseStackTrace(
      'Error: boom\n    at PaymentService.charge (/repo/src/service.ts:42:15)\n    at Object.<anonymous> (/repo/src/main.ts:10:1)',
      '/repo',
    );
    const locs = seeds.filter((s) => s.kind === 'location');
    expect(locs).toContainEqual({ kind: 'location', path: 'src/service.ts', line: 42 });
    expect(locs).toContainEqual({ kind: 'location', path: 'src/main.ts', line: 10 });
    const syms = seeds.filter((s) => s.kind === 'symbol').map((s) => (s as { name: string }).name);
    expect(syms).toContain('charge');
  });

  it('parses python tracebacks', () => {
    const seeds = parseStackTrace(
      'Traceback (most recent call last):\n  File "/repo/src/service.py", line 42, in charge\n    return run()',
      '/repo',
    );
    expect(seeds).toContainEqual({ kind: 'location', path: 'src/service.py', line: 42 });
    expect(seeds).toContainEqual({ kind: 'symbol', name: 'charge' });
  });
});

describe('buildRepoMap (temp dir, no git)', () => {
  it('builds a ranked, seeded map end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnexx-repomap-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'util.ts'),
      'export function estimateTokens(text: string): number {\n  return text.length;\n}\n',
    );
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      "import { estimateTokens } from './util.js';\nexport const n = estimateTokens('x');\n",
    );
    writeFileSync(join(dir, 'src', 'b.ts'), 'export function unrelatedThing(): void {}\n');
    const map = await buildRepoMap(dir, { seedIdentifiers: ['estimateTokens'], tokenBudget: 512 });
    expect(map.text).toContain('src/util.ts');
    expect(map.index.files).toContain('src/a.ts');
    expect(map.seedCount).toBe(1);
    expect(map.tokens).toBeLessThanOrEqual(512);
  });
});

describe('repomap-slot wiring (REPOMAP_ENABLE)', () => {
  const prevFlag = process.env.REPOMAP_ENABLE;
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.REPOMAP_ENABLE;
    else process.env.REPOMAP_ENABLE = prevFlag;
  });

  it('parses the flag conservatively', async () => {
    const { repoMapEnabled } = await import('../../../src/core/repomap-slot.js');
    expect(repoMapEnabled({})).toBe(false);
    expect(repoMapEnabled({ REPOMAP_ENABLE: '0' })).toBe(false);
    expect(repoMapEnabled({ REPOMAP_ENABLE: 'yes' })).toBe(false);
    expect(repoMapEnabled({ REPOMAP_ENABLE: '1' })).toBe(true);
    expect(repoMapEnabled({ REPOMAP_ENABLE: 'TRUE' })).toBe(true);
    expect(repoMapEnabled({ REPOMAP_ENABLE: 'on' })).toBe(true);
  });

  it('failureZoomEvidence is inert when the flag is off, even with a stack trace', async () => {
    delete process.env.REPOMAP_ENABLE;
    const { failureZoomEvidence } = await import('../../../src/core/repomap-slot.js');
    const emitted: string[] = [];
    const stub = {
      worktree: '/nonexistent',
      events: { emit: (t: string) => emitted.push(t) },
      redactor: { text: (s: string) => s },
    } as unknown as Run;
    const out = await failureZoomEvidence(stub, [
      'Error: boom\n    at <anonymous> (src/core/x.ts:1:1)',
    ]);
    expect(out).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it('failureZoomEvidence renders the caller path around a failing frame', async () => {
    process.env.REPOMAP_ENABLE = '1';
    const dir = mkdtempSync(join(tmpdir(), 'omnexx-zoom-'));
    writeFileSync(
      join(dir, 'a.ts'),
      "import { targetFn } from './b.js';\nexport function caller(): number {\n  return targetFn(41) + 1;\n}\n",
    );
    writeFileSync(
      join(dir, 'b.ts'),
      "export function targetFn(x: number): number {\n  if (x < 0) throw new Error('negative');\n  return x;\n}\n",
    );
    const { failureZoomEvidence } = await import('../../../src/core/repomap-slot.js');
    const events: string[] = [];
    const stub = {
      worktree: dir,
      events: { emit: (t: string) => events.push(t) },
      redactor: { text: (s: string) => s },
    } as unknown as Run;
    const stack = `Error: negative\n    at targetFn (${dir}/b.ts:2:21)\n    at caller (${dir}/a.ts:3:10)`;
    const zoom = await failureZoomEvidence(stub, [
      'some earlier evidence',
      `Check failed\n${stack}`,
    ]);
    expect(zoom).toBeDefined();
    expect(zoom).toContain('call-path');
    expect(zoom).toContain('b.ts');
    expect(zoom).toContain('a.ts'); // caller pulled in, not whole files
    expect(estimateTokens(zoom ?? '')).toBeLessThanOrEqual(1300);
    expect(events).toContain('repomap.failure_zoom');
  });
});
