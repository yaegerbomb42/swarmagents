/**
 * Repository map: AST-driven symbolic indexing, personalized PageRank and call-path slicing.
 *
 * Public entry points:
 *
 * - {@link extractRepository} — walk the repo and produce per-file tag extractions;
 * - {@link buildRepoGraph} — file-level reference graph with sqrt-capped edge weights;
 * - {@link personalizedPageRank} — ranked files, seeded from prompt identifiers / stack traces;
 * - {@link renderRepoMap} — the Aider-style compact map under a token budget (default 1024);
 * - {@link sliceContext} / {@link parseStackTrace} — call-graph slicing for failure-localized
 *   context, used for dynamic pruning instead of whole-file ingestion;
 * - {@link buildRepoMap} — the one-call convenience wrapper used by benchmarks and, later, by
 *   `src/agent/codemap.ts`'s slot.
 */
import { resolve } from 'node:path';
import { extractRepository, type RepositoryIndex } from './extract.js';
import { buildRepoGraph } from './graph.js';
import { personalizedPageRank } from './rank.js';
import { renderRepoMap } from './render.js';
import { parseStackTrace } from './slice.js';
import type { RepoGraph } from './types.js';
import type { RankedFile, RankOptions, RenderRepoMapOptions, RenderedRepoMap } from './types.js';

export {
  extractRepository,
  createExtractor,
  type ExtractRepositoryOptions,
  type RepositoryIndex,
} from './extract.js';
export { BuiltinExtractor } from './builtin.js';
export { TreeSitterExtractor } from './tree-sitter.js';
export { buildRepoGraph, REFERENCE_CAP, MAX_DEF_TARGETS } from './graph.js';
export {
  personalizedPageRank,
  DEFAULT_DAMPING,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOLERANCE,
  DEFAULT_SEED_FILE_BOOST,
  DEFAULT_SEED_SYMBOL_BOOST,
} from './rank.js';
export { renderRepoMap } from './render.js';
export {
  sliceContext,
  parseStackTrace,
  type SliceSeed,
  type SliceOptions,
  type SliceResult,
  type SliceSpan,
} from './slice.js';
export { collapseSignature } from './signature.js';
export type {
  DefKind,
  FileExtraction,
  RankedFile,
  RankOptions,
  RenderRepoMapOptions,
  RenderedRepoMap,
  RepoGraph,
  RepoTag,
  TagKind,
} from './types.js';

export interface BuildRepoMapOptions extends RankOptions, RenderRepoMapOptions {
  /** Engine preference. Default 'auto' (tree-sitter, builtin fallback). */
  readonly engine?: 'auto' | 'tree-sitter' | 'builtin';
  /** Include test files. Default true. */
  readonly includeTests?: boolean;
  /** Restrict the map to a repo-relative subdirectory (POSIX). */
  readonly subdir?: string;
  /** Raw stack trace text; parsed into file/symbol seeds and merged with the explicit seeds. */
  readonly stackTrace?: string;
}

export interface BuiltRepoMap extends RenderedRepoMap {
  readonly graph: RepoGraph;
  readonly ranked: readonly RankedFile[];
  readonly index: RepositoryIndex;
  /** Number of distinct seeds applied (explicit + parsed from the stack trace). */
  readonly seedCount: number;
}

export async function buildRepoMap(
  root: string,
  options: BuildRepoMapOptions = {},
): Promise<BuiltRepoMap> {
  const { stackTrace, engine, includeTests, subdir, ...rankAndRender } = options;
  const index = await extractRepository(resolve(root), {
    ...(engine !== undefined ? { engine } : {}),
    ...(includeTests !== undefined ? { includeTests } : {}),
    ...(subdir !== undefined ? { subdir } : {}),
  });
  const graph = buildRepoGraph(index.extractions);

  const seedFiles = [...(options.seedFiles ?? [])];
  const seedIdentifiers = [...(options.seedIdentifiers ?? [])];
  if (stackTrace?.trim()) {
    for (const seed of parseStackTrace(stackTrace, resolve(root))) {
      if (seed.kind === 'location') seedFiles.push(seed.path);
      else seedIdentifiers.push(seed.name);
    }
  }
  const seedCount = seedFiles.length + seedIdentifiers.length;

  const ranked = personalizedPageRank(graph, {
    ...rankAndRender,
    seedFiles,
    seedIdentifiers,
  });
  // Pins guarantee the task's files are visible whatever the global rank says: explicit seed
  // files first (stack-trace frames), then the files defining the seeded identifiers. Cap the
  // list — a broad seed set should not crowd out the ranking.
  const pinFiles = [...new Set(seedFiles.map((f) => f.replace(/\\/g, '/')))];
  if (seedIdentifiers.length > 0 && pinFiles.length < 5) {
    const seedSet = new Set(seedIdentifiers.map((s) => s.toLowerCase()));
    const matchCount = new Map<string, number>();
    for (const def of graph.definitions) {
      if (seedSet.has(def.name.toLowerCase())) {
        matchCount.set(def.path, (matchCount.get(def.path) ?? 0) + 1);
      }
    }
    const rankPos = new Map<string, number>(ranked.map((r, i) => [r.path, i]));
    const extra = [...matchCount.entries()]
      .filter(([path]) => !pinFiles.includes(path))
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          (rankPos.get(a[0]) ?? Number.MAX_SAFE_INTEGER) -
            (rankPos.get(b[0]) ?? Number.MAX_SAFE_INTEGER) ||
          (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )
      .slice(0, 5 - pinFiles.length)
      .map(([path]) => path);
    pinFiles.push(...extra);
  }
  const rendered = renderRepoMap(graph, ranked, {
    ...rankAndRender,
    ...(pinFiles.length > 0 ? { pinFiles } : {}),
  });
  return { ...rendered, graph, ranked, index, seedCount };
}
