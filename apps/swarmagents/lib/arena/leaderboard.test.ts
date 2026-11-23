import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus } from "../telemetry/bus";
import { ELO_DEFAULT_RATING } from "./elo";
import {
  ArenaLeaderboardStore,
  dynamicKFactor,
  playerKey,
  selectArenaMatchup,
} from "./leaderboard";
import type { ArenaContender } from "./runner";

function tempStore(bus = new TelemetryBus({ persist: false })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-arena-lb-"));
  const filePath = path.join(dir, "leaderboard.json");
  const store = new ArenaLeaderboardStore({ filePath, bus, maxHistory: 10 });
  return {
    store,
    bus,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeContender(
  provider: string,
  model: string,
  latencyMs: number,
  costUsd = 0.01,
): ArenaContender {
  return {
    provider,
    model,
    run: async () => ({ text: `${provider}/${model} response`, latencyMs, costUsd }),
  };
}

test("playerKey normalizes provider and model identifiers", () => {
  assert.equal(playerKey("anthropic", "claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
  assert.equal(playerKey("anthropic", "anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
  assert.equal(playerKey("ollama"), "ollama");
});

test("runAndRecordBattle updates Elo, metrics, match history, and emits telemetry", async () => {
  const { store, bus, cleanup } = tempStore();
  try {
    const events: Array<{ type: string; data: unknown }> = [];
    bus.subscribe("arena", 0, (e) => events.push({ type: e.type, data: e.data }));

    const { match } = await store.runAndRecordBattle(
      {
        contenders: [
          fakeContender("anthropic", "claude-sonnet-4-5", 1900, 0.03),
          fakeContender("openai", "gpt-5", 650, 0.02),
        ],
        mode: "hedged",
        hedgeDelayMs: 1500,
        verify: async ({ provider }) => ({
          status: "passed",
          passed: true,
          score: provider === "openai" ? 94 : 81,
          violations: [],
        }),
      },
      { promptTag: "ts-refactor", now: 1_000 },
    );

    assert.equal(match.outcome, "win");
    assert.equal(match.winner, "openai/gpt-5");
    assert.equal(match.loser, "anthropic/claude-sonnet-4-5");
    assert.equal(match.winnerRatingBefore, ELO_DEFAULT_RATING);
    assert.equal(match.winnerRatingAfter + match.loserRatingAfter, ELO_DEFAULT_RATING * 2);
    assert.equal(match.hedgeFired, true);
    assert.match(match.raceSummary, /hedged/);

    const standings = store.standings();
    assert.equal(standings.length, 2);
    assert.equal(standings[0].player, "openai/gpt-5");
    assert.equal(standings[0].wins, 1);
    assert.equal(standings[0].streak, 1);
    assert.equal(standings[0].hedgeWins, 1);
    assert.equal(standings[1].losses, 1);
    assert.equal(standings[1].streak, -1);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "arena.battle.recorded");
  } finally {
    cleanup();
  }
});

test("mutual verification failure records a draw instead of rewarding broken output", async () => {
  const { store, cleanup } = tempStore();
  try {
    const { match } = await store.runAndRecordBattle({
      contenders: [
        fakeContender("anthropic", "claude-sonnet-4-5", 400),
        fakeContender("openai", "gpt-5", 900),
      ],
      verify: async () => ({ status: "failed", passed: false, score: 20, violations: ["tests failed"] }),
    });

    assert.equal(match.outcome, "draw");
    assert.equal(match.delta, 0);
    assert.equal(store.player("anthropic", "claude-sonnet-4-5")?.draws, 1);
    assert.equal(store.player("openai", "gpt-5")?.draws, 1);
    assert.equal(store.player("anthropic", "claude-sonnet-4-5")?.streak, 0);
  } finally {
    cleanup();
  }
});

test("dynamicKFactor scales from provisional to established ratings", () => {
  assert.equal(dynamicKFactor(undefined), 40);
  assert.equal(dynamicKFactor({ matches: 4, rating: 1300 }), 40);
  assert.equal(dynamicKFactor({ matches: 12, rating: 1450 }), 32);
  assert.equal(dynamicKFactor({ matches: 25, rating: 1650 }), 20);
});

test("selectArenaMatchup prioritizes uncalibrated models and avoids immediate rematches", async () => {
  const { store, cleanup } = tempStore();
  try {
    const pool = [
      fakeContender("anthropic", "claude-sonnet-4-5", 500),
      fakeContender("openai", "gpt-5", 500),
      fakeContender("google", "gemini-2.5-pro", 500),
    ];

    // Record a match between anthropic and openai first.
    await store.runAndRecordBattle({
      contenders: [pool[0], pool[1]],
      verify: async () => ({ status: "passed", passed: true, score: 90, violations: [] }),
    });

    // Next matchup must include the unplayed google contender rather than repeating anthropic vs openai.
    const next = store.pickMatchup(pool);
    assert.ok(next);
    const pickedKeys = next.map((c) => playerKey(c.provider, c.model));
    assert.ok(pickedKeys.includes("google/gemini-2.5-pro"));
    assert.equal(selectArenaMatchup([pool[0]], {}), null);
  } finally {
    cleanup();
  }
});
