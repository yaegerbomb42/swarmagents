/**
 * Token benchmark: raw file dumps vs the tree-sitter repository map (omnexx src/core corpus).
 *
 *   npm run bench:repomap
 *
 * Corpus: the non-test TypeScript files of `src/core` — ~14k lines across ~70 files, the
 * subsystem the repomap is designed for (context management & token estimation). All token
 * counts use omnexx's own conservative estimator (estimateTokens, ~3 chars/token), the same
 * accounting the context engine uses, so the numbers translate directly into budgets.
 *
 * Scenarios:
 *   1. Context cost — raw dump, current omnexx codemap @1000t, tree-sitter repomap @512/1024/2048.
 *   2. Failure-driven retrieval — a failing stack trace seeds the ranker; recall@k of the gold
 *      file in the PPR ranking, in the rendered map (pins off and pins on), and the tokens a
 *      direct call-graph slice costs.
 *   3. Prompt-identifier retrieval — 8 hand-picked (identifier → gold file) tasks; recall@k and
 *      MRR, unseeded and seeded, tree-sitter vs builtin engines.
 *   4. Extraction coverage — definitions found by each engine.
 *
 * Writes bench/repomap/RESULTS.md and bench/repomap/results.json.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { renderCodemap, type Codemap } from '../../src/agent/codemap.js';
import { extractSymbols } from '../../src/tools/outline.js';
import { extractRepository } from '../../src/core/repomap/extract.js';
import { buildRepoGraph } from '../../src/core/repomap/graph.js';
import { personalizedPageRank } from '../../src/core/repomap/rank.js';
import { renderRepoMap } from '../../src/core/repomap/render.js';
import { parseStackTrace, sliceContext } from '../../src/core/repomap/slice.js';
import { BuiltinExtractor } from '../../src/core/repomap/builtin.js';
import { estimateTokens } from '../../src/core/tokens.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBDIR = 'src/core';

const FAILING_TEST_OUTPUT = `FAIL test/unit/core/token-calibration.test.ts
  ● TokenCounter › observeUsage › caps the calibration ratio

    AssertionError: expected 1.35 to be less than or equal to 1.3

      at TokenCounter.observeUsage (src/core/token-count.ts:243:15)
      at ContextPlanner.plan (src/agent/context-planner.ts:296:27)
      at Context.<anonymous> (test/unit/core/token-calibration.test.ts:58:11)
`;

interface Task {
  readonly id: string;
  readonly identifier: string;
  readonly gold: string;
}

const TASKS: readonly Task[] = [
  { id: 't1', identifier: 'TokenCounter', gold: 'src/core/token-count.ts' },
  { id: 't2', identifier: 'estimateTokens', gold: 'src/core/tokens.ts' },
  { id: 't3', identifier: 'nextTokenRatio', gold: 'src/core/tokens.ts' },
  { id: 't4', identifier: 'AstCache', gold: 'src/core/ast-cache.ts' },
  { id: 't5', identifier: 'parseFile', gold: 'src/core/ast-cache.ts' },
  { id: 't6', identifier: 'compactPlanView', gold: 'src/core/plan.ts' },
  { id: 't7', identifier: 'writeFileAtomic', gold: 'src/core/atomicWrite.ts' },
  { id: 't8', identifier: 'EventLog', gold: 'src/core/events.ts' },
];

const fmt = (n: number): string => n.toLocaleString('en-US');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const ms = (n: number): string => (n < 100 ? `${n.toFixed(1)}ms` : `${(n / 1000).toFixed(2)}s`);

function grepDump(identifier: string, texts: ReadonlyMap<string, string>): string {
  const lines: string[] = [];
  for (const [path, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const src = text.split('\n');
    for (let i = 0; i < src.length; i += 1) {
      const line = src[i];
      if (line?.includes(identifier)) lines.push(`${path}:${i + 1}:${line}`);
    }
  }
  return lines.join('\n');
}

async function collect(): Promise<void> {
  const t0 = performance.now();
  console.log(`corpus: ${SUBDIR} (non-test .ts) under ${repoRoot}`);
  // ---- 1. extract ----
  const tExtract0 = performance.now();
  const corpus = await extractRepository(repoRoot, {
    subdir: SUBDIR,
    includeTests: false,
    includeTexts: true,
  });
  const extractMs = performance.now() - tExtract0;
  const loc = corpus.extractions.reduce(
    (sum, e) => sum + (corpus.texts.get(e.path)?.split('\n').length ?? 0),
    0,
  );
  const defCount = corpus.extractions.reduce(
    (sum, e) => sum + e.tags.filter((t) => t.kind === 'definition').length,
    0,
  );
  const refCount = corpus.extractions.reduce(
    (sum, e) => sum + e.tags.filter((t) => t.kind === 'reference').length,
    0,
  );
  console.log(
    `files=${corpus.files.length} loc=${fmt(loc)} defs=${fmt(defCount)} refs=${fmt(refCount)} engine=${corpus.engine} extract=${ms(extractMs)}`,
  );

  // builtin cross-check
  const tBuiltin0 = performance.now();
  const builtin = new BuiltinExtractor();
  let builtinDefs = 0;
  for (const [path, text] of corpus.texts) {
    builtinDefs += builtin.extract(path, text).tags.filter((t) => t.kind === 'definition').length;
  }
  const builtinMs = performance.now() - tBuiltin0;

  // regex (codemap) symbol count for comparison
  const tRegex0 = performance.now();
  let regexSymbols = 0;
  for (const [, text] of corpus.texts) regexSymbols += extractSymbols(text).length;
  const regexMs = performance.now() - tRegex0;

  // ---- 2. raw dump ----
  let rawDump = '';
  for (const [, text] of [...corpus.texts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    rawDump += text + '\n// ─────\n';
  }
  const rawDumpTokens = estimateTokens(rawDump);

  // ---- 3. current codemap (omnexx production renderer @1000t) ----
  let map1024Tokens = 0;
  let map2048Tokens = 0;
  const tCodemap0 = performance.now();
  const codemap: Codemap = {
    version: 1,
    entries: [...corpus.texts]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, text]) => ({
        path,
        kind: 'source' as const,
        lines: text.split('\n').length,
        symbols: extractSymbols(text)
          .slice(0, 8)
          .map((s) => `${s.kind} ${s.name}`),
      })),
  };
  const codemapText = renderCodemap(codemap, 1000);
  const codemapMs = performance.now() - tCodemap0;
  const codemapTokens = estimateTokens(codemapText);
  const codemapRegexMs = codemapMs + regexMs;

  // ---- 4. graph + rank (baseline for repeated renders) ----
  const tGraph0 = performance.now();
  const graph = buildRepoGraph(corpus.extractions);
  const graphMs = performance.now() - tGraph0;

  const rankOnce = (seedFiles?: readonly string[], seedIdentifiers?: readonly string[]) => {
    const t = performance.now();
    const ranked = personalizedPageRank(graph, {
      ...(seedFiles ? { seedFiles } : {}),
      ...(seedIdentifiers ? { seedIdentifiers } : {}),
    });
    return { ranked, ms: performance.now() - t };
  };

  // ---- context cost scenarios ----
  const scenarios: { label: string; tokens: number; note: string }[] = [
    {
      label: 'Raw dump (all files, whole-file ingestion)',
      tokens: rawDumpTokens,
      note: `${corpus.files.length} files`,
    },
    {
      label: 'omnexx codemap @1000t (current production path)',
      tokens: codemapTokens,
      note: 'regex outline, no ranking',
    },
  ];
  for (const budget of [512, 1024, 2048]) {
    const { ranked, ms: rankMs } = rankOnce();
    const t = performance.now();
    const out = renderRepoMap(graph, ranked, { tokenBudget: budget });
    const renderMs = performance.now() - t;
    if (budget === 1024) map1024Tokens = out.tokens;
    if (budget === 2048) map2048Tokens = out.tokens;
    scenarios.push({
      label: `Tree-sitter repomap @${budget}t (unseeded)`,
      tokens: out.tokens,
      note: `${out.filesIncluded} files, ${out.symbolsIncluded}/${out.symbolsTotal} symbols, rank+render ${ms(rankMs + renderMs)}`,
    });
  }
  const seededIdentifiers = ['observeUsage', 'TokenCounter'];
  const seededFiles = parseStackTrace(FAILING_TEST_OUTPUT, repoRoot)
    .filter((s) => s.kind === 'location')
    .map((s) => s.path);
  {
    const { ranked, ms: rankMs } = rankOnce(seededFiles, seededIdentifiers);
    const out = renderRepoMap(graph, ranked, {
      tokenBudget: 1024,
      pinFiles: seededFiles.slice(0, 5),
    });
    scenarios.push({
      label: 'Tree-sitter repomap @1024t (stack-trace seeded, frame pinned)',
      tokens: out.tokens,
      note: `${out.filesIncluded} files, ${out.symbolsIncluded}/${out.symbolsTotal} symbols, seeds=${seededFiles.join(',') || 'none'}, rank+render ${ms(rankMs)}`,
    });
  }

  // ---- failure-driven retrieval ----
  const goldFailure = 'src/core/token-count.ts';
  const failureRanked = rankOnce(seededFiles, seededIdentifiers).ranked;
  const failurePos = failureRanked.findIndex((r) => r.path === goldFailure);
  const failureMapUnseededPins = renderRepoMap(graph, failureRanked, {
    tokenBudget: 1024,
    pinFiles: [], // ranking-only: can the ranked fill surface the frame without a pin?
  });
  const failureMapPinned = renderRepoMap(graph, failureRanked, {
    tokenBudget: 1024,
    pinFiles: seededFiles.slice(0, 5),
  });
  const slice = sliceContext(corpus.extractions, corpus.texts, {
    seeds: parseStackTrace(FAILING_TEST_OUTPUT, repoRoot),
    maxHops: 2,
    direction: 'both',
    tokenBudget: 4096,
  });
  const sliceCallers = sliceContext(corpus.extractions, corpus.texts, {
    seeds: parseStackTrace(FAILING_TEST_OUTPUT, repoRoot),
    maxHops: 2,
    direction: 'callers',
    tokenBudget: 4096,
  });
  const sliceTokens = slice.tokens;
  const sliceHasGold = slice.spans.some((s) => s.path === goldFailure);

  // ---- retrieval tasks ----
  interface TaskResult extends Task {
    posUnseeded: number;
    posSeeded: number;
    inMapUnseeded: boolean;
    inMapSeededPinned: boolean;
    inMapSeededNoPin: boolean;
    grepTokens: number;
    goldFileTokens: number;
  }
  const taskResults: TaskResult[] = [];
  const { ranked: unseededRanked } = rankOnce();
  const unseededOrder = unseededRanked.map((r) => r.path);
  for (const task of TASKS) {
    const { ranked: seededRanked } = rankOnce([], [task.identifier]);
    const seededOrder = seededRanked.map((r) => r.path);
    const goldFile = task.gold;
    const mapUnseeded = renderRepoMap(graph, unseededRanked, { tokenBudget: 1024 });
    const mapSeededPinned = renderRepoMap(graph, seededRanked, {
      tokenBudget: 1024,
      pinFiles: seededRanked.filter((r) => r.path === goldFile).map((r) => r.path),
      pinBudgetFraction: 0.5,
    });
    const mapSeededNoPin = renderRepoMap(graph, seededRanked, { tokenBudget: 1024, pinFiles: [] });
    taskResults.push({
      ...task,
      posUnseeded: unseededOrder.indexOf(goldFile),
      posSeeded: seededOrder.indexOf(goldFile),
      inMapUnseeded: mapUnseeded.text.includes(`${goldFile}:`),
      inMapSeededPinned: mapSeededPinned.text.includes(`${goldFile}:`),
      inMapSeededNoPin: mapSeededNoPin.text.includes(`${goldFile}:`),
      grepTokens: estimateTokens(grepDump(task.identifier, corpus.texts)),
      goldFileTokens: estimateTokens(corpus.texts.get(goldFile) ?? ''),
    });
  }
  const recall = (rs: TaskResult[], key: 'posUnseeded' | 'posSeeded', k: number): number =>
    rs.filter((r) => r[key] >= 0 && r[key] < k).length / rs.length;
  const mrr = (rs: TaskResult[], key: 'posUnseeded' | 'posSeeded'): number =>
    rs.reduce((s, r) => s + (r[key] >= 0 ? 1 / (r[key] + 1) : 0), 0) / rs.length;
  const mapHitRate = (rs: TaskResult[], key: keyof TaskResult): number =>
    rs.filter((r) => r[key] === true).length / rs.length;

  // builtin engine retrieval quality (same seeded protocol)
  const builtinRankedPositions: number[] = [];
  {
    // Build a builtin-engine graph and reuse the same seeded ranking protocol.
    const builtinExtractions: typeof corpus.extractions = corpus.extractions.map((e) =>
      builtin.extract(e.path, corpus.texts.get(e.path) ?? ''),
    );
    const builtinGraph = buildRepoGraph(builtinExtractions);
    for (const task of TASKS) {
      const ranked = personalizedPageRank(builtinGraph, { seedIdentifiers: [task.identifier] });
      builtinRankedPositions.push(ranked.findIndex((r) => r.path === task.gold));
    }
  }

  // ---- 5. emit ----
  const date = new Date().toISOString().slice(0, 10);
  const md: string[] = [];
  md.push(`# Repomap token benchmark — ${date}`);
  md.push('');
  md.push(
    'Corpus: `' +
      SUBDIR +
      '` (non-test .ts) — ' +
      `${corpus.files.length} files, ${fmt(loc)} LOC, ${fmt(defCount)} definitions, ${fmt(refCount)} references. ` +
      `Engine: ${corpus.engine}. Token counts use omnexx's own \`estimateTokens\` (~3 chars/token, deliberately conservative).`,
  );
  md.push('');
  md.push('## 1. Context cost (whole corpus)');
  md.push('');
  md.push('| representation | tokens | note |');
  md.push('| --- | ---: | --- |');
  for (const s of scenarios) {
    md.push(`| ${s.label} | ${fmt(s.tokens)} | ${s.note} |`);
  }
  md.push(
    `| call-graph slice from stack trace (maxHops 2, both directions) | ${fmt(sliceTokens)} | gold frame included: ${sliceHasGold ? 'yes' : 'no'}, ${slice.spans.length} spans, truncated: ${slice.truncated} |`,
  );
  md.push(
    `| call-graph slice from stack trace (maxHops 2, callers only) | ${fmt(sliceCallers.tokens)} | gold frame included: ${sliceCallers.spans.some((sp) => sp.path === goldFailure) ? 'yes' : 'no'}, ${sliceCallers.spans.length} spans, truncated: ${sliceCallers.truncated} |`,
  );
  md.push('');
  const shrink = (rawDumpTokens / map1024Tokens).toFixed(1);
  md.push(
    `Raw dump → repomap @1024t compresses the corpus to ${pct(map1024Tokens / rawDumpTokens)} of its size (${shrink}×).`,
  );
  md.push(`Raw dump → repomap @2048t compresses to ${pct(map2048Tokens / rawDumpTokens)}.`);
  md.push(
    `Codemap @1000t baseline vs repomap @1024t: ${fmt(codemapTokens)} vs ${fmt(map1024Tokens)} tokens.`,
  );
  md.push('');
  md.push('## 2. Failure-driven retrieval (stack trace seeded)');
  md.push('');
  md.push(`Seed: \`TokenCounter.observeUsage\` → gold \`${goldFailure}\`.`);
  md.push('');
  md.push('| signal | result |');
  md.push('| --- | --- |');
  md.push(`| rank position of gold file (seeded PPR) | ${failurePos + 1} |`);
  md.push(
    `| gold file in rendered map @1024t, pins off | ${failureMapUnseededPins.text.includes(goldFailure) ? 'yes' : 'no'} |`,
  );
  md.push(
    `| gold file in rendered map @1024t, frame pinned | ${failureMapPinned.text.includes(goldFailure) ? 'yes' : 'no'} |`,
  );
  md.push(
    `| slice tokens @maxHops 2 (both directions) | ${fmt(sliceTokens)} tokens, truncated: ${slice.truncated} |`,
  );
  md.push(
    `| slice tokens @maxHops 2 (callers only) | ${fmt(sliceCallers.tokens)} tokens, truncated: ${sliceCallers.truncated} |`,
  );
  md.push(
    `| tokens if the agent read the whole gold file instead | ${fmt(estimateTokens(corpus.texts.get(goldFailure) ?? ''))} |`,
  );
  md.push('');
  md.push('## 3. Retrieval tasks (identifier seed, recall@k / MRR)');
  md.push('');
  md.push(
    '| task | gold | pos (unseed) | pos (seed) | in map (unseed) | in map (seed, no pin) | in map (seed, pinned)* | grep dump tokens | gold file tokens |',
  );
  md.push('| --- | --- | ---: | ---: | --- | --- | --- | ---: | ---: |');
  for (const r of taskResults) {
    md.push(
      `| ${r.id} \`${r.identifier}\` | \`${r.gold}\` | ${r.posUnseeded + 1} | ${r.posSeeded + 1} | ${r.inMapUnseeded ? 'yes' : 'no'} | ${r.inMapSeededNoPin ? 'yes' : 'no'} | ${r.inMapSeededPinned ? 'yes' : 'no'} | ${fmt(r.grepTokens)} | ${fmt(r.goldFileTokens)} |`,
    );
  }
  md.push('');
  md.push(`| metric | unseeded | seeded |`);
  md.push('| --- | ---: | ---: |');
  md.push(
    `| recall@1 | ${pct(recall(taskResults, 'posUnseeded', 1))} | ${pct(recall(taskResults, 'posSeeded', 1))} |`,
  );
  md.push(
    `| recall@3 | ${pct(recall(taskResults, 'posUnseeded', 3))} | ${pct(recall(taskResults, 'posSeeded', 3))} |`,
  );
  md.push(
    `| recall@5 | ${pct(recall(taskResults, 'posUnseeded', 5))} | ${pct(recall(taskResults, 'posSeeded', 5))} |`,
  );
  md.push(
    `| MRR | ${mrr(taskResults, 'posUnseeded').toFixed(3)} | ${mrr(taskResults, 'posSeeded').toFixed(3)} |`,
  );
  md.push(
    `| gold in map @1024t (no pin) | ${pct(mapHitRate(taskResults, 'inMapUnseeded'))} | ${pct(mapHitRate(taskResults, 'inMapSeededNoPin'))} |`,
  );
  const builtinSeededMrr =
    builtinRankedPositions.reduce((s, p) => s + (p >= 0 ? 1 / (p + 1) : 0), 0) /
    builtinRankedPositions.length;
  const builtinSeededRecall1 =
    builtinRankedPositions.filter((p) => p === 0).length / builtinRankedPositions.length;
  md.push('');
  md.push(
    `Builtin (regex) engine, same protocol — recall@1 seeded: ${pct(builtinSeededRecall1)}, MRR: ${builtinSeededMrr.toFixed(3)}.`,
  );
  md.push('');
  md.push('## 4. Extraction coverage');
  md.push('');
  md.push('| engine | definitions found | time |');
  md.push('| --- | ---: | ---: |');
  md.push(`| tree-sitter | ${fmt(defCount)} | ${ms(extractMs)} |`);
  md.push(`| builtin (regex) | ${fmt(builtinDefs)} | ${ms(builtinMs)} |`);
  md.push(`| outline.ts regex (codemap path) | ${fmt(regexSymbols)} symbols | ${ms(regexMs)} |`);
  md.push('');
  md.push(`Graph build: ${ms(graphMs)}. Codemap build+render: ${ms(codemapRegexMs)}.`);
  md.push('');
  md.push('## Method & caveats');
  md.push('');
  md.push(
    "- Token counts are omnexx's `estimateTokens` (chars/3, ceil per call). Real BPE tokenizers differ by ±15%;",
  );
  md.push('  all figures in this file move together, so ratios are stable.');
  md.push(
    '- Edges are sqrt-capped references between files; PageRank is personalized (seeded) with damping 0.85,',
  );
  md.push('  deterministic iteration order, 100 max iterations, L1 tolerance 1e-9.');
  md.push('- "In map" checks look for the `path:` header of the gold file in the rendered output.');
  md.push('- grep dump = every line containing the identifier, `path:line:text`, like `grep -rn`.');
  md.push(
    '- *Pinned column pins the files defining the seeded identifier (the product behavior of `buildRepoMap`); inclusion of those files is guaranteed by construction. The meaningful ranking signal is the no-pin column and the rank positions.',
  );
  md.push(
    '- The corpus is the repo that ships this code; absolute numbers drift as the repo evolves. The ratios',
  );
  md.push('  (raw vs map vs slice) are the deliverable, not the third significant digit.');

  const outDir = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(outDir, 'RESULTS.md'), md.join('\n') + '\n');
  writeFileSync(
    join(outDir, 'results.json'),
    JSON.stringify(
      {
        date,
        corpus: {
          subdir: SUBDIR,
          files: corpus.files.length,
          loc,
          defCount,
          refCount,
          engine: corpus.engine,
        },
        rawDumpTokens,
        codemapTokens,
        slice: {
          bothDirections: {
            tokens: sliceTokens,
            spans: slice.spans.length,
            truncated: slice.truncated,
            hasGold: sliceHasGold,
          },
          callersOnly: {
            tokens: sliceCallers.tokens,
            spans: sliceCallers.spans.length,
            truncated: sliceCallers.truncated,
            hasGold: sliceCallers.spans.some((sp) => sp.path === goldFailure),
          },
        },
        failure: {
          gold: goldFailure,
          rankPos: failurePos + 1,
          mapUnseededPinsHit: failureMapUnseededPins.text.includes(goldFailure),
          mapPinnedHit: failureMapPinned.text.includes(goldFailure),
        },
        tasks: taskResults,
        aggregates: {
          recallUnseeded: {
            r1: recall(taskResults, 'posUnseeded', 1),
            r3: recall(taskResults, 'posUnseeded', 3),
            r5: recall(taskResults, 'posUnseeded', 5),
            mrr: mrr(taskResults, 'posUnseeded'),
          },
          recallSeeded: {
            r1: recall(taskResults, 'posSeeded', 1),
            r3: recall(taskResults, 'posSeeded', 3),
            r5: recall(taskResults, 'posSeeded', 5),
            mrr: mrr(taskResults, 'posSeeded'),
          },
          inMapUnseeded1024: mapHitRate(taskResults, 'inMapUnseeded'),
          inMapSeeded1024: mapHitRate(taskResults, 'inMapSeededNoPin'),
          builtinSeeded: { recall1: builtinSeededRecall1, mrr: builtinSeededMrr },
        },
        timing: {
          extractMs,
          graphMs,
          codemapMs,
          regexMs,
          builtinMs,
          totalMs: performance.now() - t0,
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log('wrote bench/repomap/RESULTS.md and results.json');
}

void collect().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
