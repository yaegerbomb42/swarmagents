export interface CandidateEvaluation {
  clean: boolean;
  newFailuresCount: number;
  reproPassed: boolean;
  extraCasesFailed: number;
  literalLeaksCount: number;
  clusterSize: number;
  diffLines: number;
  filesTouched: number;
  index: number;
  [key: string]: unknown;
}

/** Strict lexicographical rank key (all components ascending after encoding). */
export type RankKey = [
  number, // clean (0 true, 1 false)
  number, // newFailuresCount asc
  number, // reproPassed (0 true, 1 false)
  number, // extraCasesFailed asc
  number, // literalLeaksCount asc
  number, // clusterSize (negated -> asc)
  number, // diffLines asc
  number, // filesTouched asc
  number, // index asc
];

export function computeRankKey(candidate: CandidateEvaluation): RankKey {
  return [
    candidate.clean ? 0 : 1,
    candidate.newFailuresCount,
    candidate.reproPassed ? 0 : 1,
    candidate.extraCasesFailed,
    candidate.literalLeaksCount,
    -candidate.clusterSize,
    candidate.diffLines,
    candidate.filesTouched,
    candidate.index,
  ];
}

function compareArrays(a: RankKey, b: RankKey): number {
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function selectBestCandidate(candidates: CandidateEvaluation[]): CandidateEvaluation | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) =>
    compareArrays(computeRankKey(a), computeRankKey(b)),
  );
  return sorted[0] ?? null;
}
