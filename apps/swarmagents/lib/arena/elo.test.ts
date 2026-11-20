import test from "node:test";
import assert from "node:assert/strict";
import { ELO_DEFAULT_RATING, ELO_STARTING_K, expectedScore, updateElo, updateEloPair } from "./elo";

test("ELO defaults are sensible", () => {
  assert.equal(ELO_DEFAULT_RATING, 1200);
  assert.equal(ELO_STARTING_K, 32);
});

test("expectedScore is 0.5 for equal ratings and favors the higher rating", () => {
  assert.equal(expectedScore(1200, 1200), 0.5);
  assert.ok(expectedScore(1400, 1200) > 0.5);
  assert.ok(expectedScore(1200, 1400) < 0.5);
});

test("updateElo moves rating toward the winner and conserves the sum", () => {
  const { winner, loser, delta } = updateElo(1200, 1200);
  assert.equal(delta, 16);
  assert.equal(winner, 1216);
  assert.equal(loser, 1184);
  assert.equal(winner + loser, 2400);
});

test("updateElo honors a custom K factor", () => {
  const { delta } = updateElo(1200, 1200, { k: 64 });
  assert.equal(delta, 32);
});

test("an upset produces a larger swing than a favorite winning", () => {
  const favoriteWins = updateElo(1600, 1200);
  const upsetWins = updateElo(1200, 1600);
  assert.ok(upsetWins.delta > favoriteWins.delta);
});

test("updateEloPair supports draws (scoreA 0.5) with no movement at equal ratings", () => {
  const res = updateEloPair(1200, 1200, { scoreA: 0.5 });
  assert.equal(res.deltaA, 0);
  assert.equal(res.deltaB, 0);
  assert.equal(res.ratingA, 1200);
  assert.equal(res.ratingB, 1200);
});

test("updateEloPair draw moves points from the favorite to the underdog", () => {
  const res = updateEloPair(1400, 1200, { scoreA: 0.5 });
  assert.ok(res.deltaA < 0, "favorite loses points on a draw");
  assert.equal(res.deltaB, -res.deltaA);
  assert.equal(res.ratingA + res.ratingB, 2600);
});

test("updateEloPair loss (scoreA 0) mirrors a win", () => {
  const res = updateEloPair(1200, 1200, { scoreA: 0 });
  assert.equal(res.deltaA, -16);
  assert.equal(res.deltaB, 16);
  assert.equal(res.ratingA, 1184);
  assert.equal(res.ratingB, 1216);
});
