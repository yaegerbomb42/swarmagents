import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleRecordMatch, handleToolsList } from "./handlers";
import { configureStorePaths, loadStore, saveStoreAtomic, withLockedStore } from "./store";
import type { BoardStore } from "./types";
import { runArenaBattle, type ArenaContender } from "../arena/runner";
import type { VerificationResult } from "../verification";

function emptyStore(): BoardStore {
  return { tasks: [], proposals: [], messages: [], leaderboard: [], matches: [] };
}

async function withTmpStore(fn: () => Promise<void> | void): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-record-match-"));
  const dataFile = path.join(tmpDir, "swarm_board.json");
  configureStorePaths(tmpDir, dataFile);
  try {
    await fn();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function payload(result: { result: { content: Array<{ text: string }> } }): any {
  return JSON.parse(result.result.content[0].text);
}

test("handleRecordMatch rejects invalid input", async () => {
  const store = emptyStore();
  const bad = await handleRecordMatch(store, { winner: "", loser: "b" });
  assert.ok("error" in bad);
  assert.equal(bad.error.code, -32602);
  // No write happened: store still empty.
  assert.equal(store.leaderboard!.length, 0);
});

test("handleRecordMatch validates non-negative numbers", async () => {
  const store = emptyStore();
  const bad = await handleRecordMatch(store, { winner: "a", loser: "b", winnerScore: -5 });
  assert.ok("error" in bad);
  assert.match(bad.error.message, /non-negative/);
});

test("handleRecordMatch persists match and ratings, then loads back", async () => {
  await withTmpStore(async () => {
    const res = await withLockedStore((store) =>
      handleRecordMatch(store, {
        winner: "openai/gpt-5",
        loser: "anthropic/claude-sonnet-4-5",
        reason: "verification score",
        winnerLatencyMs: 820,
        loserLatencyMs: 1300,
      }),
    );
    assert.ok("result" in res);
    const p = payload(res);
    assert.equal(p.message, "Arena match recorded");
    assert.equal(p.match.winner, "openai/gpt-5");
    assert.ok(p.delta > 0);

    const loaded = loadStore();
    assert.equal(loaded.leaderboard!.length, 2);
    assert.equal(loaded.matches!.length, 1);
    assert.equal(loaded.matches![0].winner, "openai/gpt-5");
    const winner = loaded.leaderboard!.find((r) => r.player === "openai/gpt-5")!;
    assert.equal(winner.wins, 1);
  });
});

test("record_match appears in the tools list with the right schema", () => {
  const res = handleToolsList("id");
  const tools = res.result.tools as Array<{ name: string; inputSchema?: { required?: string[] } }>;
  const tool = tools.find((t) => t.name === "record_match");
  assert.ok(tool, "record_match tool is registered");
  assert.deepEqual(tool!.inputSchema!.required, ["winner", "loser"]);
});

test("end-to-end: a winning arena battle feeds the Elo leaderboard", async () => {
  await withTmpStore(async () => {
    const contender = (provider: string, latencyMs: number): ArenaContender => ({
      provider,
      model: `${provider}-m`,
      run: () =>
        Promise.resolve({
          text: `answer from ${provider}`,
          latencyMs,
          costUsd: latencyMs < 1000 ? 0.01 : 0.05,
        }),
    });

    const battle = await runArenaBattle({
      contenders: [contender("openai", 820), contender("anthropic", 1300)],
      verify: async ({ provider }) =>
        ({
          passed: true,
          score: provider === "openai" ? 90 : 80,
          violations: [],
        }) as VerificationResult,
      mode: "hedged",
      hedgeDelayMs: 1500,
      // Keep the threshold above the winner's score so the hedge contender
      // actually runs and reports its own outcome.
      earlyWinMinScore: 100,
    });

    assert.ok(battle.winner, "battle has a winner");
    const battleWinner = battle.winner;
    const battleLoser = battle.outcomes.find((o) => o !== battleWinner)!;

    const res = await withLockedStore((store) =>
      handleRecordMatch(store, {
        winner: battleWinner.provider,
        loser: battleLoser.provider,
        reason: "verified arena winner",
        winnerScore: battleWinner.score,
        loserScore: battleLoser.score,
        winnerLatencyMs: battleWinner.latencyMs,
        loserLatencyMs: battleLoser.latencyMs,
        winnerCostUsd: battleWinner.costUsd,
        loserCostUsd: battleLoser.costUsd,
      }),
    );
    assert.ok("result" in res);

    const winner = loadStore().leaderboard!.find((r) => r.player === "openai")!;
    assert.equal(winner.player, "openai");
    assert.ok(winner.rating > 1200);
    assert.equal(winner.wins, 1);
  });
});
