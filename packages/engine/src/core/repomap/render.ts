/**
 * Render the ranked symbolic map to a token budget.
 *
 * Output shape (Aider-style, byte-deterministic):
 *
 *   src/core/tokens.ts:
 *   ⋮...
 *   │export function estimateTokens(text: string): number {
 *   ⋮...
 *   │export class TokenCounter {
 *
 * Files are shown in ranked order; within a file, symbols are shown in source order. The fill
 * is greedy by file: once the budget cannot fit another file's header plus its first symbol,
 * the map stops, so the omitted tail is always the least-relevant part of the ranking.
 *
 * When `pinFiles` is set, the pinned files are rendered first (in the given order, as whole
 * files or as many symbols as fit) and are capped at `pinBudgetFraction` × the budget, so the
 * file the failure stack trace points at is guaranteed visible whatever the global rank says.
 * The remaining budget is filled by the ranking as usual.
 *
 * Per-block token estimates are conservative (they round up per block), so the final `tokens`
 * reported via `estimateTokens` never exceeds the budget.
 */
import { estimateTokens } from '../tokens.js';
import type { RepoTag } from './types.js';
import type { RenderedRepoMap, RenderRepoMapOptions, RepoGraph, RankedFile } from './types.js';

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const posixize = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

interface FileBlock {
  readonly header: string;
  readonly blocks: readonly string[];
  readonly blockTokens: readonly number[];
  readonly headerTokens: number;
  readonly defs: readonly RepoTag[];
}

export function renderRepoMap(
  graph: RepoGraph,
  ranked: readonly RankedFile[],
  options: RenderRepoMapOptions = {},
): RenderedRepoMap {
  const budget = options.tokenBudget ?? 1024;
  const maxChars = options.maxSignatureChars ?? 160;
  const includeNote = options.includeOmittedNote ?? true;
  const pinBudgetFraction = Math.min(1, Math.max(0, options.pinBudgetFraction ?? 0.5));
  const maxPerFile: number | undefined =
    options.maxSymbolsPerFile === null ? undefined : (options.maxSymbolsPerFile ?? 12);

  const byFile = new Map<string, RepoTag[]>();
  for (const def of graph.definitions) {
    const bucket = byFile.get(def.path);
    if (bucket) bucket.push(def);
    else byFile.set(def.path, [def]);
  }
  const rankOf = new Map<string, number>(ranked.map((r) => [r.path, r.rank]));
  const filesInOrder = [...byFile.keys()].sort(
    (a, b) => (rankOf.get(b) ?? 0) - (rankOf.get(a) ?? 0) || byCodeUnits(a, b),
  );

  const truncate = (sig: string): string =>
    sig.length > maxChars ? `${sig.slice(0, maxChars - 1)}…` : sig;

  const blockFor = (file: string): FileBlock => {
    const all = byFile.get(file) ?? [];
    const defs =
      maxPerFile === undefined || all.length <= maxPerFile ? all : all.slice(0, maxPerFile);
    const header = `${file}:\n`;
    const blocks = defs.map((def) => `⋮...\n│${truncate(def.text)}\n`);
    return {
      header,
      blocks,
      blockTokens: blocks.map((b) => estimateTokens(b)),
      headerTokens: estimateTokens(header),
      defs,
    };
  };

  const parts: string[] = [];
  const renderedFiles = new Set<string>();
  let symbolsIncluded = 0;
  let used = 0;

  type RenderOutcome = 'full' | 'partial' | 'none';
  /** Render one file under an absolute cap on the `used` counter. */
  const renderFile = (file: string, absoluteCap: number): RenderOutcome => {
    const fb = blockFor(file);
    if (used + fb.headerTokens > absoluteCap) return 'none';
    let fileCost = fb.headerTokens;
    const selected: number[] = [];
    for (let i = 0; i < fb.defs.length; i += 1) {
      const blockToken = fb.blockTokens[i];
      if (blockToken === undefined) break;
      const next = fileCost + blockToken;
      if (used + next > absoluteCap) break;
      fileCost = next;
      selected.push(i);
    }
    if (selected.length === 0) return 'none';
    used += fileCost;
    renderedFiles.add(file);
    symbolsIncluded += selected.length;
    parts.push(fb.header);
    for (const i of selected) {
      const block = fb.blocks[i];
      if (block !== undefined) parts.push(block);
    }
    return selected.length === fb.defs.length ? 'full' : 'partial';
  };

  // Phase 1 — pinned files (seed order), capped by pinBudgetFraction × budget.
  const pinCap = Math.min(budget, Math.floor(budget * pinBudgetFraction));
  for (const raw of options.pinFiles ?? []) {
    const file = posixize(raw);
    if (!byFile.has(file) || renderedFiles.has(file)) continue;
    renderFile(file, pinCap);
  }

  // Phase 2 — ranked remainder.
  let budgetExhausted = false;
  for (const file of filesInOrder) {
    if (renderedFiles.has(file)) continue;
    if (budgetExhausted) continue;
    const outcome = renderFile(file, budget);
    if (outcome === 'none' || outcome === 'partial') budgetExhausted = true;
  }

  const symbolsTotal = graph.definitions.length;
  const omitted = symbolsTotal - symbolsIncluded;
  if (includeNote && omitted > 0) {
    const note = `⋮ (${omitted} more ${omitted === 1 ? 'symbol' : 'symbols'} not shown)\n`;
    const noteTokens = estimateTokens(note);
    if (used + noteTokens <= budget) {
      parts.push(note);
      used += noteTokens;
    } else {
      const short = `⋮ +${omitted}\n`;
      const shortTokens = estimateTokens(short);
      if (used + shortTokens <= budget) {
        parts.push(short);
        used += shortTokens;
      }
    }
  }

  const text = parts.join('');
  return {
    text,
    tokens: estimateTokens(text),
    symbolsIncluded,
    symbolsTotal,
    filesIncluded: renderedFiles.size,
    filesTotal: byFile.size,
  };
}
