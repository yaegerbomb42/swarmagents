/**
 * Personalized PageRank over the file graph.
 *
 * Unlike global PageRank, the personalization vector is seeded from the task at hand:
 *
 * - `seedFiles` (files in the prompt, files changed in the diff, files on the top frames of a
 *   failing stack trace) each get `seedFileBoost` extra mass;
 * - files defining a symbol whose name appears in the prompt (`seedIdentifiers`) each get
 *   `seedSymbolBoost` extra mass.
 *
 * Dangling nodes (no outbound edges) distribute their mass proportionally to the
 * personalization vector rather than uniformly, so even the zero-degree tail of the graph
 * stays biased toward the task. Iteration order is the sorted file list at every step, and no
 * randomness or wall-clock is involved, so the ranking is bit-for-bit reproducible for the
 * same repository bytes and seed.
 */
import type { RankedFile, RankOptions, RepoGraph } from './types.js';

export const DEFAULT_DAMPING = 0.85;
export const DEFAULT_MAX_ITERATIONS = 100;
export const DEFAULT_TOLERANCE = 1e-9;
/** Files the user is working in (diff/stack trace/open) — boosted hard, like Aider's added files. */
export const DEFAULT_SEED_FILE_BOOST = 50;
/** Files defining an identifier mentioned in the prompt. */
export const DEFAULT_SEED_SYMBOL_BOOST = 25;

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const posixize = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function personalizedPageRank(graph: RepoGraph, options: RankOptions = {}): RankedFile[] {
  const files = graph.files;
  const n = files.length;
  if (n === 0) return [];
  const damping = options.damping ?? DEFAULT_DAMPING;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const seedFileBoost = options.seedFileBoost ?? DEFAULT_SEED_FILE_BOOST;
  const seedSymbolBoost = options.seedSymbolBoost ?? DEFAULT_SEED_SYMBOL_BOOST;

  const index = new Map<string, number>();
  files.forEach((f, i) => index.set(f, i));

  const emptyEdges: { to: number; weight: number }[] = [];
  const outboundList: { to: number; weight: number }[][] = files.map((f) => {
    const out = graph.outbound.get(f);
    if (!out) return emptyEdges;
    return [...out]
      .map(([to, weight]) => ({ to: index.get(to) ?? -1, weight }))
      .filter((e) => e.to >= 0);
  });
  const inbound: { from: number; weight: number }[][] = files.map(() => []);
  const outSum = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const edges = outboundList[i] ?? emptyEdges;
    let sum = 0;
    for (const edge of edges) {
      sum += edge.weight;
      inbound[edge.to]?.push({ from: i, weight: edge.weight });
    }
    outSum[i] = sum;
  }

  // Personalization: uniform base + seeded boosts, normalized to sum 1.
  const pers = new Array<number>(n).fill(1);
  const seedFiles = new Set((options.seedFiles ?? []).map(posixize));
  if (seedFiles.size > 0) {
    for (let i = 0; i < n; i += 1) {
      const file = files[i];
      if (file !== undefined && seedFiles.has(file)) pers[i] = (pers[i] ?? 1) + seedFileBoost;
    }
  }
  const seedIdentifiers = new Set(
    (options.seedIdentifiers ?? []).map((s) => s.toLowerCase()).filter((s) => s.length >= 3),
  );
  if (seedIdentifiers.size > 0) {
    const boosted = new Set<string>();
    for (const def of graph.definitions) {
      if (seedIdentifiers.has(def.name.toLowerCase())) boosted.add(def.path);
    }
    for (const path of boosted) {
      const i = index.get(path);
      if (i !== undefined) pers[i] = (pers[i] ?? 1) + seedSymbolBoost;
    }
  }
  let persSum = 0;
  for (const p of pers) persSum += p;
  const persNorm = pers.map((p) => p / persSum);

  let rank = new Array<number>(n).fill(1 / n);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) {
      const out = outSum[i] ?? 0;
      if (out === 0) danglingMass += rank[i] ?? 0;
    }
    const next = new Array<number>(n);
    let delta = 0;
    let sumNext = 0;
    for (let i = 0; i < n; i += 1) {
      const persI = persNorm[i] ?? 0;
      let acc = danglingMass * persI;
      for (const { from, weight } of inbound[i] ?? []) {
        acc += ((rank[from] ?? 0) * weight) / (outSum[from] ?? 1);
      }
      const value = (1 - damping) * persI + damping * acc;
      next[i] = value;
      sumNext += value;
    }
    // Renormalize every iteration to pin the sum at 1 despite floating-point drift.
    if (sumNext > 0) {
      for (let i = 0; i < n; i += 1) next[i] = (next[i] ?? 0) / sumNext;
    }
    for (let i = 0; i < n; i += 1) delta += Math.abs((next[i] ?? 0) - (rank[i] ?? 0));
    rank = next;
    if (delta < tolerance) break;
  }

  return files
    .map((path, i) => ({ path, rank: rank[i] ?? 0 }))
    .sort((a, b) => b.rank - a.rank || byCodeUnits(a.path, b.path));
}
