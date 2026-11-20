import test from "node:test";
import assert from "node:assert/strict";
import { applyArenaMatch, getPlayerRating } from "./leaderboard";
import { ELO_DEFAULT_RATING } from "../arena/elo";
import type { BoardStore } from "./types";

function emptyStore(): BoardStore {
  return { tasks: [], proposals: [], messages: [], leaderboard: [], matches: [] };
}

test("getPlayerRating seeds a fresh player at the default rating", () => {
  const rating = getPlayerRating(emptyStore(), "anthropic/claude-sonnet-4-5");
  assert.equal(rating.player, "anthropic/claude-sonnet-4-5");
  assert.equal(rating.rating, ELO_DEFAULT_RATING);
  assert.equal(rating.matches, 0);
});

test("applyArenaMatch updates Elo, records the match, and is immutable", () => {
  const store = emptyStore();
  const result = applyArenaMatch(store, {
    winner: "openai/gpt-5",
    loser: "anthropic/claude-sonnet-4-5",
    reason: "verification score",
    winnerScore: 95,
    loserScore: 80,
    winnerLatencyMs: 820,
    loserLatencyMs: 1300,
  });

  // Original store untouched (immutability).
  assert.equal(store.leaderboard!.length, 0);
  assert.equal(store.matches!.length, 0);
  assert.ok(result.match);

  assert.equal(result.leaderboard.length, 2);
  const winner = result.leaderboard.find((r) => r.player === "openai/gpt-5")!;
  const loser = result.leaderboard.find((r) => r.player === "anthropic/claude-sonnet-4-5")!;
  assert.ok(winner.rating > ELO_DEFAULT_RATING);
  assert.ok(loser.rating < ELO_DEFAULT_RATING);
  assert.equal(winner.wins, 1);
  assert.equal(loser.losses, 1);
  assert.equal(result.delta, winner.rating - ELO_DEFAULT_RATING);

  assert.equal(result.match.winner, "openai/gpt-5");
  assert.equal(result.match.reason, "verification score");
  assert.equal(result.match.winnerScore, 95);
  assert.ok(result.match.id.startsWith("match_"));
});

test("applyArenaMatch accumulates across matches", () => {
  const store = emptyStore();
  const first = applyArenaMatch(store, { winner: "a", loser: "b", reason: "r1" });
  const store2: BoardStore = { ...store, leaderboard: first.leaderboard, matches: [first.match] };

  const second = applyArenaMatch(store2, { winner: "a", loser: "c", reason: "r2" });
  assert.equal(second.leaderboard.length, 3);
  const a = second.leaderboard.find((r) => r.player === "a")!;
  assert.equal(a.matches, 2);
  assert.equal(a.wins, 2);
});

test("applyArenaMatch rejects a self-match", () => {
  assert.throws(() => applyArenaMatch(emptyStore(), { winner: "a", loser: "a", reason: "r" }), /distinct/);
});
