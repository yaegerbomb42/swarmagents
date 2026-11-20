import test from "node:test";
import assert from "node:assert/strict";
import {
  runArenaBattle,
  type ArenaContender,
  type ArenaBattleOptions,
  type ContenderRunContext,
} from "./runner";
import type { VerificationResult } from "../verification";

function contender(
  provider: string,
  spec: Partial<{ text: string; latencyMs: number; costUsd?: number; error?: Error }> = {},
): ArenaContender {
  return {
    provider,
    model: spec.error ? undefined : `${provider}-m`,
    run: () =>
      spec.error
        ? Promise.reject(spec.error)
        : Promise.resolve({
            text: spec.text ?? `answer from ${provider}`,
            latencyMs: spec.latencyMs ?? 1000,
            costUsd: spec.costUsd,
          }),
  };
}

function verifyFor(scoreByProvider: Record<string, number>): ArenaBattleOptions["verify"] {
  return async ({ provider }) =>
    ({
      passed: (scoreByProvider[provider] ?? 0) >= 70,
      score: scoreByProvider[provider] ?? 0,
      violations: (scoreByProvider[provider] ?? 0) >= 70 ? [] : [`${provider} failed verification`],
    }) as VerificationResult;
}

test("runArenaBattle picks the higher-verified winner and reports both outcomes", async () => {
  const result = await runArenaBattle({
    contenders: [contender("anthropic", { latencyMs: 800 }), contender("openai", { latencyMs: 1200 })],
    verify: verifyFor({ anthropic: 92, openai: 55 }),
    // Keep the early-win threshold above the winner's score so the hedge
    // contender actually runs and reports its own outcome.
    earlyWinMinScore: 100,
  });
  assert.ok(result.winner);
  assert.equal(result.winner.provider, "anthropic");
  assert.equal(result.winner.status, "winner");
  const loser = result.outcomes.find((o) => o.provider === "openai")!;
  assert.equal(loser.status, "aborted");
  assert.equal(loser.score, 55);
  assert.equal(result.race.winner?.provider, "anthropic");
});

test("ties break by lower latency", async () => {
  const result = await runArenaBattle({
    contenders: [contender("anthropic", { latencyMs: 900 }), contender("openai", { latencyMs: 500 })],
    verify: verifyFor({ anthropic: 80, openai: 80 }),
  });
  assert.ok(result.winner);
  assert.equal(result.winner.provider, "openai");
});

test("a failed contender becomes a failed outcome and never throws", async () => {
  const result = await runArenaBattle({
    contenders: [
      contender("anthropic", { error: new Error("provider down") }),
      contender("openai", { latencyMs: 700 }),
    ],
    verify: verifyFor({ openai: 90 }),
  });
  assert.ok(result.winner);
  assert.equal(result.winner.provider, "openai");
  const failed = result.outcomes.find((o) => o.provider === "anthropic")!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.passed, false);
  assert.ok(failed.verification.violations[0].includes("provider down"));
});

test("hedge telemetry surfaces on the race report", async () => {
  const result = await runArenaBattle({
    contenders: [contender("anthropic", { latencyMs: 2000 }), contender("openai", { latencyMs: 900 })],
    verify: verifyFor({ anthropic: 88, openai: 85 }),
    mode: "hedged",
    hedgeDelayMs: 1500,
  });
  assert.equal(result.race.mode, "hedged");
  assert.equal(result.race.hedgeFired, true);
  assert.ok(result.winner);
  assert.equal(result.winner.provider, "anthropic");
});

test("double failure yields no winner, no draw, and never throws", async () => {
  const result = await runArenaBattle({
    contenders: [
      contender("anthropic", { error: new Error("a down") }),
      contender("openai", { error: new Error("b down") }),
    ],
    verify: verifyFor({}),
    mode: "simultaneous",
  });
  assert.equal(result.winner, null);
  assert.equal(result.isDraw, false);
  assert.deepEqual(
    result.outcomes.map((o) => o.status),
    ["failed", "failed"],
  );
  assert.ok(result.outcomes.every((o) => o.text === "" && o.passed === false && o.score === 0));
});

test("equal top scores with equal pass state produce a draw", async () => {
  const result = await runArenaBattle({
    contenders: [contender("anthropic", { latencyMs: 900 }), contender("openai", { latencyMs: 500 })],
    verify: verifyFor({ anthropic: 80, openai: 80 }),
    mode: "simultaneous",
  });
  assert.equal(result.isDraw, true);
  assert.ok(result.winner);
  // Tie-break still picks the faster contender as the nominal winner.
  assert.equal(result.winner.provider, "openai");
});

test("different top scores are not a draw", async () => {
  const result = await runArenaBattle({
    contenders: [contender("anthropic", { latencyMs: 800 }), contender("openai", { latencyMs: 1200 })],
    verify: verifyFor({ anthropic: 92, openai: 55 }),
    mode: "simultaneous",
    earlyWinMinScore: 100,
  });
  assert.equal(result.isDraw, false);
  assert.ok(result.winner);
  assert.equal(result.winner.provider, "anthropic");
});

test("hedged mode staggers hedge contender starts by hedgeDelayMs", async () => {
  const starts: number[] = [];
  const t0 = performance.now();
  const mk = (provider: string, runMs: number): ArenaContender => ({
    provider,
    run: async () => {
      starts.push(performance.now() - t0);
      await new Promise((resolve) => setTimeout(resolve, runMs));
      return { text: `answer from ${provider}`, latencyMs: runMs };
    },
  });
  const result = await runArenaBattle({
    contenders: [mk("anthropic", 200), mk("openai", 50)],
    verify: verifyFor({ anthropic: 80, openai: 80 }),
    mode: "hedged",
    hedgeDelayMs: 80,
  });
  assert.equal(starts.length, 2);
  assert.ok(starts[0] < 60, `primary should start immediately, started at ${starts[0]}ms`);
  assert.ok(starts[1] >= 60, `hedge should start after ~80ms, started at ${starts[1]}ms`);
  assert.ok(result.winner);
});

test("hedged mode starts the hedge immediately when the primary settles early", async () => {
  const starts: number[] = [];
  const t0 = performance.now();
  const mk = (provider: string, runMs: number): ArenaContender => ({
    provider,
    run: async () => {
      starts.push(performance.now() - t0);
      await new Promise((resolve) => setTimeout(resolve, runMs));
      return { text: `answer from ${provider}`, latencyMs: runMs };
    },
  });
  const result = await runArenaBattle({
    contenders: [mk("anthropic", 5), mk("openai", 50)],
    verify: verifyFor({ anthropic: 80, openai: 80 }),
    mode: "hedged",
    hedgeDelayMs: 1500,
  });
  assert.equal(starts.length, 2);
  assert.ok(starts[1] < 500, `hedge should start early once the primary settles, started at ${starts[1]}ms`);
  assert.ok(result.winner);
});

test("early win aborts a running slower contender", async () => {
  let loserSawAbort = false;
  const fast: ArenaContender = {
    provider: "anthropic",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { text: "fast answer", latencyMs: 20 };
    },
  };
  const slow: ArenaContender = {
    provider: "openai",
    run: (ctx: ContenderRunContext) =>
      new Promise<{ text: string; latencyMs: number }>((resolve) => {
        ctx.signal.addEventListener(
          "abort",
          () => {
            loserSawAbort = true;
            resolve({ text: "late answer", latencyMs: 10 });
          },
          { once: true },
        );
        setTimeout(() => resolve({ text: "late answer", latencyMs: 400 }), 400);
      }),
  };
  const result = await runArenaBattle({
    contenders: [fast, slow],
    verify: verifyFor({ anthropic: 95, openai: 80 }),
    mode: "simultaneous",
    earlyWinMinScore: 90,
  });
  assert.ok(result.winner);
  assert.equal(result.winner.provider, "anthropic");
  assert.equal(loserSawAbort, true);
});

test("records true first-token timing via onFirstToken", async () => {
  const result = await runArenaBattle({
    contenders: [
      {
        provider: "anthropic",
        run: async (ctx: ContenderRunContext) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          ctx.onFirstToken();
          await new Promise((resolve) => setTimeout(resolve, 70));
          return { text: "answer", latencyMs: 80 };
        },
      },
      {
        provider: "openai",
        run: async () => ({ text: "other", latencyMs: 500 }),
      },
    ],
    verify: verifyFor({ anthropic: 90, openai: 70 }),
    mode: "simultaneous",
  });
  const winner = result.outcomes.find((o) => o.provider === "anthropic")!;
  assert.ok(winner.firstTokenMs !== undefined);
  assert.ok(
    winner.firstTokenMs < winner.latencyMs,
    `firstTokenMs ${winner.firstTokenMs} should be < latency ${winner.latencyMs}`,
  );
});
