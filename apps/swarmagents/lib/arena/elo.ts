export const ELO_DEFAULT_RATING = 1200;
export const ELO_STARTING_K = 32;

export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export interface EloUpdateOptions {
  k?: number;
  /** 1 = player A won, 0.5 = draw, 0 = player B won. Defaults to 1. */
  scoreA?: 0 | 0.5 | 1;
}

export interface EloPairUpdate {
  ratingA: number;
  ratingB: number;
  deltaA: number;
  deltaB: number;
}

export function updateEloPair(
  ratingA: number,
  ratingB: number,
  options: EloUpdateOptions = {},
): EloPairUpdate {
  const k = options.k ?? ELO_STARTING_K;
  const scoreA = options.scoreA ?? 1;
  const expA = expectedScore(ratingA, ratingB);
  const deltaA = Math.round(k * (scoreA - expA));
  // Avoid a -0 delta when the rounded change is exactly zero (strict
  // equality and JSON consumers treat -0 as distinct from 0).
  const deltaB = deltaA === 0 ? 0 : -deltaA;
  return {
    ratingA: ratingA + deltaA,
    ratingB: ratingB + deltaB,
    deltaA,
    deltaB,
  };
}

/** Backwards-compatible helper for strict winner/loser matches. */
export function updateElo(
  winnerRating: number,
  loserRating: number,
  options: Omit<EloUpdateOptions, "scoreA"> = {},
): { winner: number; loser: number; delta: number } {
  const res = updateEloPair(winnerRating, loserRating, { ...options, scoreA: 1 });
  return { winner: res.ratingA, loser: res.ratingB, delta: res.deltaA };
}
