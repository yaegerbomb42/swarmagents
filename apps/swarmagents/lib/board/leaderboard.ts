/**
 * Arena leaderboard on the Swarm Board: Elo ratings per player (a provider/model
 * pair or an agent) plus the match log. Immutable helpers — they return new
 * arrays and never mutate the store in place.
 */

import { ELO_DEFAULT_RATING, updateElo } from "../arena/elo";
import type { ArenaMatch, BoardStore, PlayerRating } from "./types";

/** The current rating record for a player, seeded if one does not exist yet. */
export function getPlayerRating(board: BoardStore, player: string): PlayerRating {
  const existing = board.leaderboard?.find((entry) => entry.player === player);
  if (existing) return existing;
  return {
    player,
    rating: ELO_DEFAULT_RATING,
    matches: 0,
    wins: 0,
    losses: 0,
    updatedAt: Date.now(),
  };
}

function upsertRatings(ratings: readonly PlayerRating[], updated: readonly PlayerRating[]): PlayerRating[] {
  const existing = ratings.map((entry) => ({ ...entry }));
  for (const next of updated) {
    const index = existing.findIndex((entry) => entry.player === next.player);
    if (index >= 0) existing[index] = next;
    else existing.push(next);
  }
  return existing;
}

export interface ArenaMatchInput {
  winner: string;
  loser: string;
  reason: string;
  winnerScore?: number;
  loserScore?: number;
  winnerLatencyMs?: number;
  loserLatencyMs?: number;
  winnerCostUsd?: number;
  loserCostUsd?: number;
}

export interface ArenaMatchResult {
  leaderboard: PlayerRating[];
  match: ArenaMatch;
  winnerBefore: PlayerRating;
  loserBefore: PlayerRating;
  winnerAfter: PlayerRating;
  loserAfter: PlayerRating;
  delta: number;
}

/**
 * Apply one arena match: update both players' Elo ratings and append a match
 * record. Returns the new leaderboard and match so the caller can persist them
 * atomically with the rest of the board.
 */
export function applyArenaMatch(board: BoardStore, input: ArenaMatchInput): ArenaMatchResult {
  if (input.winner === input.loser) {
    throw new Error("Arena match requires two distinct players.");
  }
  const winnerBefore = getPlayerRating(board, input.winner);
  const loserBefore = getPlayerRating(board, input.loser);

  const { winner, loser, delta } = updateElo(winnerBefore.rating, loserBefore.rating);
  const now = Date.now();
  const winnerAfter: PlayerRating = {
    ...winnerBefore,
    rating: winner,
    matches: winnerBefore.matches + 1,
    wins: winnerBefore.wins + 1,
    updatedAt: now,
  };
  const loserAfter: PlayerRating = {
    ...loserBefore,
    rating: loser,
    matches: loserBefore.matches + 1,
    losses: loserBefore.losses + 1,
    updatedAt: now,
  };

  const leaderboard = upsertRatings(board.leaderboard ?? [], [winnerAfter, loserAfter]);
  const match: ArenaMatch = {
    id: `match_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    winner: input.winner,
    loser: input.loser,
    reason: input.reason,
    ...(input.winnerScore !== undefined ? { winnerScore: input.winnerScore } : {}),
    ...(input.loserScore !== undefined ? { loserScore: input.loserScore } : {}),
    ...(input.winnerLatencyMs !== undefined ? { winnerLatencyMs: input.winnerLatencyMs } : {}),
    ...(input.loserLatencyMs !== undefined ? { loserLatencyMs: input.loserLatencyMs } : {}),
    ...(input.winnerCostUsd !== undefined ? { winnerCostUsd: input.winnerCostUsd } : {}),
    ...(input.loserCostUsd !== undefined ? { loserCostUsd: input.loserCostUsd } : {}),
    createdAt: now,
  };

  return { leaderboard, match, winnerBefore, loserBefore, winnerAfter, loserAfter, delta };
}
