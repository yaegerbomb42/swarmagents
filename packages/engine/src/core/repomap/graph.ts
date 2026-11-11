/**
 * Build the repository graph from per-file extractions.
 *
 * Nodes are files; a directed edge A → B (weight `sqrt(min(count, REFERENCE_CAP))`) exists
 * when file A references a name defined in file B. Square-rooting keeps one hot symbol from
 * dominating the ranking (Aider does the same). Edges are capped per definition-name so a
 * name defined all over the repo (`Result`, `Config`, …) fans out to at most `MAX_DEF_TARGETS`
 * files instead of producing a solid block in the adjacency.
 *
 * Everything is sorted and iterated in sorted order — the graph is byte-deterministic for the
 * same input bytes.
 */
import type { FileExtraction, RepoGraph, RepoTag } from './types.js';

/** Edge weight cap before sqrt: sqrt(16) = 4. Matches the reference-cap philosophy of the map. */
export const REFERENCE_CAP = 16;
/** A name defined in more than this many files is too generic to rank on; skip its edges. */
export const MAX_DEF_TARGETS = 20;

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildRepoGraph(extractions: readonly FileExtraction[]): RepoGraph {
  const files = [...new Set(extractions.map((e) => e.path))].sort(byCodeUnits);

  const definitions: RepoTag[] = [];
  const defsByName = new Map<string, RepoTag[]>();
  for (const extraction of extractions) {
    for (const tag of extraction.tags) {
      if (tag.kind !== 'definition') continue;
      definitions.push(tag);
      const bucket = defsByName.get(tag.name);
      if (bucket) bucket.push(tag);
      else defsByName.set(tag.name, [tag]);
    }
  }
  definitions.sort(
    (a, b) => byCodeUnits(a.path, b.path) || a.line - b.line || byCodeUnits(a.name, b.name),
  );

  const rawEdgeCounts = new Map<string, Map<string, number>>();
  for (const extraction of extractions) {
    for (const tag of extraction.tags) {
      if (tag.kind !== 'reference') continue;
      const targets = defsByName.get(tag.name);
      if (!targets || targets.length > MAX_DEF_TARGETS) continue;
      for (const target of targets) {
        if (target.path === extraction.path) continue; // self edges carry no ranking signal
        let out = rawEdgeCounts.get(extraction.path);
        if (!out) {
          out = new Map();
          rawEdgeCounts.set(extraction.path, out);
        }
        out.set(target.path, (out.get(target.path) ?? 0) + 1);
      }
    }
  }

  const outbound = new Map<string, Map<string, number>>();
  for (const [from, tos] of [...rawEdgeCounts].sort(([a], [b]) => byCodeUnits(a, b))) {
    const weights = new Map<string, number>();
    for (const [to, count] of [...tos].sort(([a], [b]) => byCodeUnits(a, b))) {
      weights.set(to, Math.sqrt(Math.min(count, REFERENCE_CAP)));
    }
    outbound.set(from, weights);
  }

  const engines = [...new Set(extractions.map((e) => e.engine))];
  return {
    files,
    outbound,
    definitions,
    rawEdgeCounts,
    engine: engines.sort(byCodeUnits).join('+'),
  };
}
