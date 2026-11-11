/**
 * Flag-gated repository-map slot for the cached prefix (`REPOMAP_ENABLE=1`).
 *
 * When enabled, the `codemap` string fed into `CycleInputs` comes from a ranked
 * tree-sitter repository map (`src/core/repomap/`) instead of the unranked regex
 * outline. The map is built at run start and at milestone boundaries and persisted
 * as `repomap.txt` in the run dir, so the cached prefix stays byte-identical between
 * refreshes — exactly the codemap's cache contract. Any build failure falls back to
 * the codemap silently (an event is emitted). When the flag is unset, nothing here
 * runs and the codemap path is byte-for-byte what it always was.
 *
 * Failure-path zoom (`failureZoomEvidence`) is separate: it renders the dependent
 * call-path spans around a stack trace onto the volatile per-cycle message, never
 * into the cached prefix, and is never persisted to the plan.
 */
import { readTextOr, writeFileAtomic } from './atomic.js';
import type { Run } from './run.js';
import { buildRepoMap } from './repomap/index.js';
import { extractRepository } from './repomap/extract.js';
import { parseStackTrace, sliceContext } from './repomap/slice.js';

export const REPOMAP_ENABLE_ENV = 'REPOMAP_ENABLE';

/** Parse the flag; default off. Accepts 1/true/on (case-insensitive). */
export function repoMapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[REPOMAP_ENABLE_ENV];
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'on';
}

/** The persisted rendered map, if it exists and the flag is on. */
export async function readRunRepoMap(run: Run): Promise<string | undefined> {
  if (!repoMapEnabled()) return undefined;
  const text = await readTextOr(run.store.file('repomap.txt'), '');
  const trimmed = text.trimEnd();
  return trimmed ? trimmed : undefined;
}

/**
 * (Re)build and persist `repomap.txt`. Best-effort: emits `repomap.built` /
 * `repomap.error` and never throws.
 */
export async function refreshRunRepoMap(
  run: Run,
  seed?: { readonly stackTrace?: string },
): Promise<void> {
  if (!repoMapEnabled()) return;
  const budget = Math.max(256, run.config.context.repo_map_max_tokens);
  try {
    const built = await buildRepoMap(run.worktree, {
      tokenBudget: budget,
      ...(seed?.stackTrace ? { stackTrace: seed.stackTrace } : {}),
    });
    await writeFileAtomic(run.store.file('repomap.txt'), `${built.text}\n`);
    run.events.emit('repomap.built', {
      tokens: built.tokens,
      filesIncluded: built.filesIncluded,
      filesTotal: built.filesTotal,
      symbolsIncluded: built.symbolsIncluded,
      symbolsTotal: built.symbolsTotal,
      engine: built.index.engine,
      degraded: built.index.degraded,
      seeded: seed !== undefined,
    });
  } catch (err) {
    run.events.emit('repomap.error', { message: (err as Error).message });
  }
}

/** True when a string looks like it carries a parseable stack trace. */
function looksLikeStackTrace(text: string): boolean {
  return text.includes('\n    at ') || /File "[^"]+", line \d+/.test(text);
}

/**
 * Failure-path zoom: find the most recent evidence item that carries a stack trace,
 * resolve its frames/symbols, and render the dependent call-path spans (callers,
 * maxHops 2, ≤1200 tokens) as one extra evidence string for THIS cycle only.
 * Returns undefined when there is nothing to zoom or the flag is off.
 */
export async function failureZoomEvidence(
  run: Run,
  evidence: readonly string[],
): Promise<string | undefined> {
  if (!repoMapEnabled()) return undefined;
  const last = [...evidence].reverse().find(looksLikeStackTrace);
  if (!last) return undefined;
  const seeds = parseStackTrace(last, run.worktree);
  if (seeds.length === 0) return undefined;
  try {
    const corpus = await extractRepository(run.worktree, {
      includeTests: true,
      includeTexts: true,
    });
    const slice = sliceContext(corpus.extractions, corpus.texts, {
      seeds,
      maxHops: 2,
      direction: 'callers',
      tokenBudget: 1200,
    });
    if (slice.spans.length === 0) return undefined;
    run.events.emit('repomap.failure_zoom', {
      seeds: slice.seedCount,
      spans: slice.spans.length,
      tokens: slice.tokens,
      truncated: slice.truncated,
    });
    const body = run.redactor.text(slice.text);
    return `Dependent call-path around the failure (auto-extracted, ${slice.tokens} tokens):\n${body}`;
  } catch (err) {
    run.events.emit('repomap.error', { message: `failure zoom: ${(err as Error).message}` });
    return undefined;
  }
}
