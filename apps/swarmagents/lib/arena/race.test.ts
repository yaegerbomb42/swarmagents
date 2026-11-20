import test from "node:test";
import assert from "node:assert/strict";
import {
  sortParticipants,
  buildRaceReport,
  formatHedgeLine,
  type RaceParticipant,
} from "./race";

function participant(overrides: Partial<RaceParticipant> = {}): RaceParticipant {
  return { provider: "anthropic", latencyMs: 1000, status: "aborted", ...overrides };
}

test("sortParticipants orders by first-token, then total latency", () => {
  const pts = [
    participant({ provider: "b", firstTokenMs: 800, latencyMs: 2000 }),
    participant({ provider: "a", firstTokenMs: 300, latencyMs: 900 }),
    participant({ provider: "c", firstTokenMs: 300, latencyMs: 600 }),
  ];
  assert.deepEqual(
    sortParticipants(pts).map((p) => p.provider),
    ["c", "a", "b"],
  );
});

test("buildRaceReport picks the winner and computes latency saved", () => {
  const report = buildRaceReport(
    "simultaneous",
    [
      participant({ provider: "anthropic", firstTokenMs: 1500, latencyMs: 2500, status: "aborted" }),
      participant({ provider: "openai", firstTokenMs: 500, latencyMs: 1200, status: "winner" }),
    ],
    1500,
  );
  assert.equal(report.winner?.provider, "openai");
  assert.equal(report.hedgeFired, false);
  assert.equal(report.latencySavedMs, 1000);
});

test("hedged mode marks hedgeFired when a participant stalls past the delay", () => {
  const report = buildRaceReport(
    "hedged",
    [
      participant({ provider: "anthropic", firstTokenMs: 2000, latencyMs: 2400, status: "aborted" }),
      participant({ provider: "openai", firstTokenMs: 900, latencyMs: 900, status: "winner" }),
    ],
    1500,
  );
  assert.equal(report.hedgeFired, true);
});

test("formatHedgeLine renders the stalled→hedge→won narrative", () => {
  const report = buildRaceReport(
    "hedged",
    [
      participant({ provider: "Anthropic", firstTokenMs: 1500, latencyMs: 2500, status: "aborted" }),
      participant({ provider: "OpenAI", firstTokenMs: 820, latencyMs: 820, status: "winner", costUsd: 0.01 }),
    ],
    1200,
  );
  const line = formatHedgeLine({ ...report, savedUsd: 0.04 });
  assert.match(line, /Anthropic stalled at 1\.5s/);
  assert.match(line, /hedged/);
  assert.match(line, /OpenAI won in 820ms/);
  assert.match(line, /saved \$0\.04/);
});

test("formatHedgeLine degrades gracefully with no participants and no savings", () => {
  const empty = formatHedgeLine(buildRaceReport("hedged", [], 1500));
  assert.equal(empty, "No race data.");

  const min = formatHedgeLine(
    buildRaceReport(
      "simultaneous",
      [
        participant({ provider: "Anthropic", latencyMs: 1200, status: "winner" }),
        participant({ provider: "OpenAI", latencyMs: 1600, status: "aborted" }),
      ],
      1500,
    ),
  );
  assert.match(min, /raced Anthropic \+ OpenAI/);
});
