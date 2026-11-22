import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SequencedEvent, TelemetryEvent } from "./bus";
import { TelemetryBus } from "./bus";
import { configureRunsDir } from "./paths";
import {
  aggregateRunUsage,
  aggregateUsage,
  computeUsage,
  providerBudgetStatuses,
  type RunUsage,
} from "./usage";
import type { ProviderConfig } from "../providers/types";

let seq = 0;
function event(
  runId: string,
  type: string,
  fields: Record<string, unknown> = {},
  ts = Date.now(),
): SequencedEvent {
  return { type, seq: ++seq, runId, ts, ...fields } as SequencedEvent;
}

function usageEvent(runId: string, input: number, output: number, cached = 0, ts = Date.now()): SequencedEvent {
  return event(runId, "usage", { inputTokens: input, outputTokens: output, cachedTokens: cached }, ts);
}

test("aggregateRunUsage sums usage events and carries run.finished cost", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const events = [
    event("run_a", "run.created", { data: { prompt: "hi", userId: "alice" } }, t0),
    event("run_a", "run.started", { sessionId: "s1", model: "claude-sonnet" }, t0 + 100),
    usageEvent("run_a", 500, 30, 0, t0 + 200),
    usageEvent("run_a", 300, 20, 100, t0 + 300),
    event("run_a", "run.finished", { exitCode: 0, sessionId: "s1", costUsd: 0.042, durationMs: 3350, numTurns: 2 }, t0 + 3350),
  ];
  const run = aggregateRunUsage("run_a", events);
  assert.equal(run.status, "finished");
  assert.equal(run.userId, "alice");
  assert.equal(run.model, "claude-sonnet");
  assert.equal(run.provider, "unknown");
  assert.equal(run.tokensIn, 800);
  assert.equal(run.tokensOut, 50);
  assert.equal(run.tokensCached, 100);
  assert.equal(run.costUsd, 0.042);
  assert.equal(run.durationMs, 3350);
  assert.equal(run.numTurns, 2);
  assert.equal(run.createdAt, t0);
  assert.equal(run.finishedAt, t0 + 3350);
});

test("aggregateRunUsage sums llm.call costs and tracks the serving provider", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const llmCall = (provider: string, outcome: string, costUsd: number | null) =>
    event("run_llm", "llm.call", {
      data: { provider, model: "m", attempt: 1, outcome, latencyMs: 120, costUsd },
    }, t0);
  const events = [
    event("run_llm", "run.created", { data: { userId: "alice" } }, t0),
    event("run_llm", "run.started", { provider: "first", model: "m" }, t0 + 10),
    llmCall("first", "429", null),
    llmCall("second", "ok", 0.0042),
    llmCall("second", "ok", 0.0013),
    event("run_llm", "run.finished", { costUsd: 0.5 }, t0 + 100),
  ];
  const run = aggregateRunUsage("run_llm", events);
  // Failed attempts never count toward the run cost; ok calls do.
  assert.equal(run.callCostUsd, 0.0055);
  // The last ok call is the serving provider.
  assert.equal(run.provider, "second");
});

test("a lens cost is added on top of the run's own cost, and keeps the serving provider", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const events = [
    event("run_lens", "run.created", { data: { userId: "alice" } }, t0),
    event("run_lens", "run.started", { provider: "anthropic", model: "m" }, t0 + 10),
    event("run_lens", "llm.call", {
      data: { provider: "anthropic", model: "m", attempt: 1, outcome: "ok", latencyMs: 120, costUsd: 0.004 },
    }, t0 + 20),
    event("run_lens", "llm.call", {
      data: { provider: "openai", model: "gpt-4.1-mini", attempt: 1, outcome: "ok", latencyMs: 90, costUsd: 0.0012, lens: "eli5", source: "lens" },
    }, t0 + 30),
    event("run_lens", "run.finished", { costUsd: 0.5 }, t0 + 100),
  ];
  const run = aggregateRunUsage("run_lens", events);
  assert.equal(run.callCostUsd, 0.004);
  assert.equal(run.lensCostUsd, 0.0012);
  // The lens provider does not take over the run's serving provider.
  assert.equal(run.provider, "anthropic");
  const report = aggregateUsage([run]);
  assert.equal(report.days[0].costUsd, 0.0052);
});

test("aggregateUsage prefers llm.call cost over run.finished cost in slice totals", () => {
  const day = Date.parse("2026-11-10T10:00:00Z");
  const runs: RunUsage[] = [
    {
      runId: "r-call", status: "finished", provider: "groq", model: "m1",
      createdAt: day, finishedAt: day + 1000,
      tokensIn: 100, tokensOut: 10, tokensCached: 0,
      costUsd: 9.99, callCostUsd: 0.001,
    },
    {
      runId: "r-finish", status: "finished", provider: "groq", model: "m1",
      createdAt: day, finishedAt: day + 2000,
      tokensIn: 200, tokensOut: 20, tokensCached: 0,
      costUsd: 0.02,
    },
  ];
  const report = aggregateUsage(runs);
  assert.equal(report.days[0].costUsd, 0.021);
  assert.equal(report.days[0].runsWithCost, 2);
});

test("aggregateRunUsage takes the provider from the last run.failover event", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const events = [
    event("run_b", "run.created", { data: { userId: "alice" } }, t0),
    event("run_b", "run.failover", { data: { provider: "groq", model: "llama", message: "429" } }, t0 + 10),
    event("run_b", "run.failover", { data: { provider: "openrouter", model: "x", message: "429" } }, t0 + 20),
    event("run_b", "run.finished", { exitCode: 0, sessionId: "s1" }, t0 + 100),
  ];
  assert.equal(aggregateRunUsage("run_b", events).provider, "openrouter");
});

test("aggregateRunUsage records the provider named on run.started", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const run = aggregateRunUsage("run_p", [
    event("run_p", "run.created", { data: { userId: "alice" } }, t0),
    event("run_p", "run.started", { sessionId: "s1", model: "claude", provider: "mercury" }, t0 + 10),
    event("run_p", "run.finished", { exitCode: 0, sessionId: "s1" }, t0 + 100),
  ]);
  assert.equal(run.provider, "mercury");
  assert.equal(run.model, "claude");
});

test("aggregateRunUsage handles a run with no usage and no finish", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const run = aggregateRunUsage("run_c", [
    event("run_c", "run.created", { data: { userId: "alice" } }, t0),
    event("run_c", "assistant.text", { text: "hello" }, t0 + 5),
  ]);
  assert.equal(run.status, "running");
  assert.equal(run.tokensIn, 0);
  assert.equal(run.costUsd, undefined);
});

test("aggregateRunUsage ignores malformed usage values", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const run = aggregateRunUsage("run_d", [
    usageEvent("run_d", 100, 10, 0, t0),
    event("run_d", "usage", { inputTokens: "nope", outputTokens: Number.NaN }, t0 + 1),
    event("run_d", "run.finished", { exitCode: 0, sessionId: "s1", costUsd: "free" }, t0 + 2),
  ]);
  assert.equal(run.tokensIn, 100);
  assert.equal(run.tokensOut, 10);
  assert.equal(run.costUsd, undefined);
});

test("aggregateRunUsage reports queued runs as queued and fills model gaps from later events", () => {
  const t0 = Date.parse("2026-11-10T10:00:00Z");
  const queuedEvents = [
    event("run_q", "run.created", { data: { prompt: "hi", userId: "alice" } }, t0),
    event("run_q", "run.queued", { data: { position: 1, userId: "alice" } }, t0 + 10),
  ];
  const queued = aggregateRunUsage("run_q", queuedEvents);
  assert.equal(queued.status, "queued");
  assert.equal(queued.provider, "unknown");

  // run.started names the provider but no model: running now, model still unknown.
  const started = aggregateRunUsage("run_q", [
    ...queuedEvents,
    event("run_q", "run.started", { sessionId: "s1", provider: "radium" }, t0 + 20),
    usageEvent("run_q", 10, 5, 0, t0 + 30),
  ]);
  assert.equal(started.status, "running");
  assert.equal(started.provider, "radium");
  assert.equal(started.model, undefined);

  // A usage event carrying the generating model fills the gap.
  const filled = aggregateRunUsage("run_q", [
    ...queuedEvents,
    event("run_q", "run.started", { sessionId: "s1", provider: "radium" }, t0 + 20),
    event("run_q", "usage", { inputTokens: 10, outputTokens: 5, model: "clarke-1.0" }, t0 + 30),
  ]);
  assert.equal(filled.status, "running");
  assert.equal(filled.provider, "radium");
  assert.equal(filled.model, "clarke-1.0");
});

test("aggregateUsage groups runs into per-day totals with provider/model splits", () => {
  const day1 = Date.parse("2026-11-10T10:00:00Z");
  const day2 = Date.parse("2026-11-11T10:00:00Z");
  const runs: RunUsage[] = [
    {
      runId: "r1", status: "finished", provider: "groq", model: "m1",
      createdAt: day1, finishedAt: day1 + 1000,
      tokensIn: 100, tokensOut: 10, tokensCached: 5, costUsd: 0.01,
    },
    {
      runId: "r2", status: "finished", provider: "unknown", model: "m1",
      createdAt: day1, finishedAt: day1 + 2000,
      tokensIn: 200, tokensOut: 20, tokensCached: 0, costUsd: 0.02,
    },
    {
      runId: "r3", status: "error", provider: "groq", model: "m2",
      createdAt: day2, finishedAt: day2 + 1000,
      tokensIn: 50, tokensOut: 5, tokensCached: 0,
    },
  ];
  const report = aggregateUsage(runs);
  assert.equal(report.days.length, 2);
  assert.equal(report.days[0].date, "2026-11-11");
  assert.equal(report.days[0].tokensIn, 50);
  assert.equal(report.days[0].costUsd, 0);
  assert.equal(report.days[0].runsWithCost, 0);
  assert.equal(report.days[1].date, "2026-11-10");
  assert.equal(report.days[1].tokensIn, 300);
  assert.equal(report.days[1].tokensOut, 30);
  assert.equal(report.days[1].tokensCached, 5);
  assert.equal(report.days[1].costUsd, 0.03);
  assert.equal(report.days[1].runs, 2);
  assert.equal(report.days[1].runsWithCost, 2);
  assert.equal(report.days[1].byProvider.groq.tokensIn, 100);
  assert.equal(report.days[1].byProvider.groq.runs, 1);
  assert.equal(report.days[1].byProvider.unknown.tokensIn, 200);
  assert.equal(report.days[1].byModel.m1.tokensIn, 300);
  assert.equal(report.days[1].byModel.m1.runs, 2);
  assert.equal(report.totals.tokensIn, 350);
  assert.equal(report.totals.costUsd, 0.03);
  assert.equal(report.totals.runs, 3);
  assert.equal(report.totals.runsWithCost, 2);
  // Runs newest first.
  assert.deepEqual(report.runs.map((r) => r.runId), ["r3", "r2", "r1"]);
});

test("aggregateUsage buckets a still-running run by its creation day", () => {
  const day1 = Date.parse("2026-11-10T10:00:00Z");
  const report = aggregateUsage([
    {
      runId: "r9", status: "running", provider: "unknown",
      createdAt: day1, tokensIn: 7, tokensOut: 1, tokensCached: 0,
    },
  ]);
  assert.equal(report.days[0].date, "2026-11-10");
  assert.equal(report.days[0].tokensIn, 7);
});

test("computeUsage reads durable logs, scopes by user, and drops old runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-usage-"));
  configureRunsDir(dir);
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1000;
    // Current run for alice.
    bus.publish("run_now", { type: "run.created", data: { prompt: "now", userId: "alice" } });
    bus.publish("run_now", { type: "usage", inputTokens: 100, outputTokens: 10 } as TelemetryEvent);
    bus.publish("run_now", { type: "run.finished", exitCode: 0, sessionId: "s1", costUsd: 0.05 } as TelemetryEvent);
    // Another user's run: same shape, must be excluded for alice.
    bus.publish("run_bob", { type: "run.created", data: { prompt: "bob", userId: "bob" } });
    bus.publish("run_bob", { type: "usage", inputTokens: 999, outputTokens: 99 } as TelemetryEvent);
    bus.publish("run_bob", { type: "run.finished", exitCode: 0, sessionId: "s2", costUsd: 9.99 } as TelemetryEvent);

    const report = computeUsage({ userId: "alice", days: 30 });
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].runId, "run_now");
    assert.equal(report.runs[0].tokensIn, 100);
    assert.equal(report.runs[0].costUsd, 0.05);
    assert.equal(report.totals.tokensIn, 100);
    assert.equal(report.totals.costUsd, 0.05);
    assert.equal(report.days.length, 1);

    // Bob sees only his own run.
    assert.equal(computeUsage({ userId: "bob" }).totals.tokensIn, 999);

    // A 1-day window still includes today's runs; the 40-day-old run is out.
    // (Old run seeded by rewriting its log timestamps is covered by the
    // cutoff check below via a hand-written log.)
    const oldDir = path.join(dir, "old");
    fs.mkdirSync(oldDir, { recursive: true });
    const oldLine = JSON.stringify({
      type: "run.finished", seq: 1, runId: "run_old", ts: old,
      exitCode: 0, sessionId: "s9", costUsd: 1,
    });
    fs.writeFileSync(path.join(dir, "run_old.jsonl"), `${oldLine}\n`);
    const fresh = computeUsage({ days: 30 });
    assert.equal(fresh.runs.some((r) => r.runId === "run_old"), false);
    assert.equal(computeUsage({ days: 90 }).runs.some((r) => r.runId === "run_old"), true);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function providerWithBudget(id: string, dailyBudgetUsd: number): ProviderConfig {
  return { id, kind: "openai", dailyBudgetUsd };
}

test("providerBudgetStatuses reports budget/spent/remaining for configured budgets", () => {
  const statuses = providerBudgetStatuses(
    [providerWithBudget("anthropic", 10), providerWithBudget("openai", 5)],
    { anthropic: 4, openai: 0 },
  );
  assert.equal(statuses.length, 2);
  assert.deepEqual(statuses[0], {
    id: "anthropic",
    budgetUsd: 10,
    spentTodayUsd: 4,
    remainingUsd: 6,
    fractionUsed: 0.4,
  });
  assert.deepEqual(statuses[1], {
    id: "openai",
    budgetUsd: 5,
    spentTodayUsd: 0,
    remainingUsd: 5,
    fractionUsed: 0,
  });
});

test("providerBudgetStatuses omits unbudgeted providers and allows overspend", () => {
  const statuses = providerBudgetStatuses(
    [
      providerWithBudget("groq", 2),
      { id: "unbudgeted", kind: "openai" },
      { id: "zero-budget", kind: "openai", dailyBudgetUsd: 0 },
    ],
    { groq: 3 },
  );
  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0], {
    id: "groq",
    budgetUsd: 2,
    spentTodayUsd: 3,
    remainingUsd: 0,
    fractionUsed: 1.5,
  });
});

test("computeUsage attaches per-provider budgets when providers are supplied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-usage-budget-"));
  configureRunsDir(dir);
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    bus.publish("run_now", { type: "run.created", data: { prompt: "now", userId: "alice" } });
    bus.publish("run_now", { type: "run.failover", data: { provider: "anthropic", model: "m", message: "429" } } as TelemetryEvent);
    bus.publish("run_now", { type: "usage", inputTokens: 100, outputTokens: 10 } as TelemetryEvent);
    bus.publish("run_now", { type: "run.finished", exitCode: 0, sessionId: "s1", costUsd: 0.42 } as TelemetryEvent);

    const report = computeUsage({
      userId: "alice",
      days: 1,
      providers: [
        providerWithBudget("anthropic", 10),
        providerWithBudget("openai", 5),
      ],
    });
    assert.equal(report.budgets.length, 2);
    const anthropic = report.budgets.find((b) => b.id === "anthropic")!;
    assert.equal(anthropic.budgetUsd, 10);
    assert.equal(anthropic.spentTodayUsd, 0.42);
    assert.equal(anthropic.remainingUsd, 9.58);
    assert.ok(Math.abs(anthropic.fractionUsed! - 0.042) < 1e-9);
    // No budget configured for the serving "unknown" provider.
    assert.ok(!report.budgets.some((b) => b.id === "unknown"));
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("computeUsage returns an empty report when persistence is disabled", () => {
  const report = computeUsage({ runsDir: null });
  assert.deepEqual(report, {
    days: [],
    runs: [],
    budgets: [],
    totals: { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, runs: 0, runsWithCost: 0 },
  });
});

test("failed llm.call does not count toward run cost or shadow run.finished", () => {
  const events: SequencedEvent[] = [
    event("r1", "run.created", { userId: "alice" }),
    event("r1", "llm.call", { outcome: "error", costUsd: 0.25, provider: "anthropic" }),
    event("r1", "llm.call", { outcome: "error", costUsd: 0, provider: "anthropic" }),
    event("r1", "run.finished", { costUsd: 0.15 }),
  ];
  const run = aggregateRunUsage("r1", events);
  assert.equal(run.callCostUsd, undefined);
  assert.equal(run.costUsd, 0.15);
  // Lens failed calls also do not count
  const lensEvents: SequencedEvent[] = [
    event("r2", "run.created", { userId: "alice" }),
    event("r2", "llm.call", { source: "lens", outcome: "error", costUsd: 0.05 }),
    event("r2", "llm.call", { source: "lens", outcome: "ok", costUsd: 0.03 }),
  ];
  const lensRun = aggregateRunUsage("r2", lensEvents);
  assert.equal(lensRun.lensCostUsd, 0.03);
});

test("NaN and negative cost payloads are ignored to prevent poisoning", () => {
  const events: SequencedEvent[] = [
    event("r1", "run.created", { userId: "alice" }),
    event("r1", "llm.call", { outcome: "ok", costUsd: NaN, provider: "anthropic" }),
    event("r1", "llm.call", { outcome: "ok", costUsd: Infinity, provider: "anthropic" }),
    event("r1", "llm.call", { outcome: "ok", costUsd: -5, provider: "anthropic" }),
    event("r1", "llm.call", { outcome: "ok", costUsd: 0.10, provider: "anthropic" }),
  ];
  const run = aggregateRunUsage("r1", events);
  assert.equal(run.callCostUsd, 0.10);
});

test("run.paused sets status to paused", () => {
  const events: SequencedEvent[] = [
    event("r1", "run.created", { userId: "alice" }),
    event("r1", "run.started", { provider: "anthropic" }),
    event("r1", "run.paused", {}),
  ];
  const run = aggregateRunUsage("r1", events);
  assert.equal(run.status, "paused");
});

test("computeUsage handles NaN days and limit gracefully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-usage-nan-"));
  configureRunsDir(dir);
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    bus.publish("run_1", { type: "run.created", data: { userId: "alice" } });
    bus.publish("run_1", { type: "run.finished", costUsd: 0.10 } as TelemetryEvent);

    const report = computeUsage({
      runsDir: dir,
      userId: "alice",
      days: NaN,
      limit: NaN,
    });
    assert.equal(report.runs.length, 1);
    assert.equal(report.days.length, 1);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("providerBudgetStatuses attributes spend to each provider across failovers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-failover-budget-"));
  configureRunsDir(dir);
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    const runId = "run_failover_attribution";
    bus.publish(runId, { type: "run.created", data: { userId: "alice" } });
    bus.publish(runId, { type: "run.started", model: "claude-3-opus", provider: "anthropic" } as TelemetryEvent);
    // Call 1 on anthropic
    bus.publish(runId, {
      type: "llm.call",
      data: { provider: "anthropic", model: "claude-3-opus", outcome: "ok", costUsd: 1.50 },
    } as TelemetryEvent);
    // Failover to openai
    bus.publish(runId, {
      type: "run.failover",
      data: { provider: "openai", model: "gpt-4o", message: "rate limited" },
    } as TelemetryEvent);
    // Call 2 on openai
    bus.publish(runId, {
      type: "llm.call",
      data: { provider: "openai", model: "gpt-4o", outcome: "ok", costUsd: 2.25 },
    } as TelemetryEvent);
    bus.publish(runId, { type: "run.finished", exitCode: 0, sessionId: "s1" } as TelemetryEvent);

    const report = computeUsage({
      userId: "alice",
      days: 1,
      providers: [
        providerWithBudget("anthropic", 10),
        providerWithBudget("openai", 10),
      ],
    });

    const anthropicBudget = report.budgets.find((b) => b.id === "anthropic")!;
    const openaiBudget = report.budgets.find((b) => b.id === "openai")!;
    assert.equal(anthropicBudget.spentTodayUsd, 1.50, "anthropic should be attributed its own call cost ($1.50)");
    assert.equal(openaiBudget.spentTodayUsd, 2.25, "openai should be attributed its own call cost ($2.25)");
    assert.equal(anthropicBudget.remainingUsd, 8.50);
    assert.equal(openaiBudget.remainingUsd, 7.75);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
