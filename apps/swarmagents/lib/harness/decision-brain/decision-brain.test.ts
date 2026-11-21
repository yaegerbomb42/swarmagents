import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDecisionPayload,
  truncateReasonToTwelveWords,
} from "./schema.js";
import { detectHighStakesReason, LocalEscalatingRouter } from "./router.js";
import { DecisionLogger } from "./logger.js";
import { evaluateDecisionRouter } from "./eval.js";
import { generateSyntheticDataset } from "./synthetic.js";
import type { AgentSnapshot, DecisionKind, DecisionRouter } from "./types.js";

function benign(): AgentSnapshot {
  return {
    goal: "Fix failing unit tests",
    lastToolCall: { name: "read_file", args: { path: "src/a.ts" } },
    lastToolResult: { ok: true, output: "Read 40 lines." },
    error: null,
    turnCount: 2,
    budgetLeft: { turnsRemaining: 10, tokensRemaining: 40_000 },
  };
}

function chatBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

type FetchStub = typeof fetch;

/** Stub fetch: answers with the given payload per endpoint model name. */
function stubFetch(
  answers: Record<string, string>,
  calls: Array<{ url: string; model: string }>,
  failLocal = false,
): FetchStub {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    calls.push({ url: String(url), model: body.model });
    if (failLocal && body.model === "local-1b") {
      throw new Error("connection refused");
    }
    const content = answers[body.model] ?? answers.default!;
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => chatBody(content),
    } as unknown as Response;
  }) as FetchStub;
}

const LOCAL = { baseUrl: "http://localhost:11434/v1", model: "local-1b" };
const BIG = { baseUrl: "http://localhost:11434/v1", model: "big" };

test("schema: fenced JSON parses; >12-word reason rejected", () => {
  const ok = parseDecisionPayload(
    '```json\n{"decision":"continue","confidence":0.9,"reason":"Progress healthy, more work remains"}\n```',
  );
  assert.equal(ok.decision, "continue");
  assert.throws(
    () =>
      parseDecisionPayload(
        JSON.stringify({
          decision: "continue",
          confidence: 0.9,
          reason: "one two three four five six seven eight nine ten eleven twelve thirteen",
        }),
      ),
    /at most 12 words/,
  );
  assert.throws(
    () =>
      parseDecisionPayload(JSON.stringify({ decision: "explode", confidence: 0.5, reason: "nope" })),
  );
  assert.equal(truncateReasonToTwelveWords("  "), "No reason provided");
});

test("high-stakes: destructive patterns escalate, benign does not", () => {
  const rm = benign();
  rm.lastToolCall = { name: "run_command", args: { command: "rm -rf /var/data/backups" } };
  assert.match(detectHighStakesReason(rm) ?? "", /destructive-pattern/);
  const push = benign();
  push.lastToolCall = { name: "run_command", args: { command: "git push --force origin main" } };
  assert.ok(detectHighStakesReason(push));
  const drop = benign();
  drop.goal = "migrate db";
  drop.lastToolCall = { name: "run_command", args: { command: 'psql -c "DROP TABLE users;"' } };
  assert.ok(detectHighStakesReason(drop));
  assert.equal(detectHighStakesReason(benign()), null);
  assert.equal(detectHighStakesReason(benign(), "ask"), "high-stakes:ask-human");
});

test("router: confident local decision stands, big never called", async () => {
  const calls: Array<{ url: string; model: string }> = [];
  const router = new LocalEscalatingRouter({
    local: LOCAL,
    big: BIG,
    fetchImpl: stubFetch(
      { "local-1b": JSON.stringify({ decision: "continue", confidence: 0.92, reason: "Progress healthy" }) },
      calls,
    ),
  });
  const res = await router.decide(benign());
  assert.equal(res.decision, "continue");
  assert.equal(res.escalated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "local-1b");
});

test("router: low confidence escalates to the big model", async () => {
  const calls: Array<{ url: string; model: string }> = [];
  const logger = new DecisionLogger();
  const router = new LocalEscalatingRouter({
    local: LOCAL,
    big: BIG,
    logger,
    fetchImpl: stubFetch(
      {
        "local-1b": JSON.stringify({ decision: "retry", confidence: 0.5, reason: "Unsure, maybe retry" }),
        big: JSON.stringify({ decision: "verify", confidence: 0.88, reason: "Verify before continuing" }),
      },
      calls,
    ),
  });
  const res = await router.decide(benign());
  assert.equal(res.decision, "verify");
  assert.equal(res.escalated, true);
  assert.equal(calls.length, 2);
  const entry = logger.getEntries()[0]!;
  assert.match(entry.escalationReason ?? "", /low-confidence:0\.50<0\.75/);
  assert.equal(logger.getSummary().escalatedCount, 1);
});

test("router: local error escalates; destructive snapshot escalates despite confident local", async () => {
  const calls: Array<{ url: string; model: string }> = [];
  const router = new LocalEscalatingRouter({
    local: LOCAL,
    big: BIG,
    fetchImpl: stubFetch(
      {
        "local-1b": JSON.stringify({ decision: "continue", confidence: 0.99, reason: "Looks fine" }),
        big: JSON.stringify({ decision: "ask", confidence: 0.95, reason: "Destructive, needs approval" }),
      },
      calls,
      true,
    ),
  });
  const resErr = await router.decide(benign());
  assert.equal(resErr.escalated, true);
  assert.equal(resErr.decision, "ask");

  const calls2: Array<{ url: string; model: string }> = [];
  const router2 = new LocalEscalatingRouter({
    local: LOCAL,
    big: BIG,
    fetchImpl: stubFetch(
      {
        "local-1b": JSON.stringify({ decision: "continue", confidence: 0.99, reason: "Looks fine" }),
        big: JSON.stringify({ decision: "ask", confidence: 0.95, reason: "Destructive, needs approval" }),
      },
      calls2,
    ),
  });
  const rm = benign();
  rm.lastToolCall = { name: "run_command", args: { command: "rm -rf /tmp/x" } };
  const resHs = await router2.decide(rm);
  assert.equal(resHs.escalated, true);
  assert.equal(resHs.decision, "ask");
});

/** Obvious-rules router: proves the eval harness + dataset cohere, no model needed. */
const ruleRouter: DecisionRouter = {
  async decide(s: AgentSnapshot) {
    let decision: DecisionKind = "continue";
    const text = `${s.goal}\n${JSON.stringify(s.lastToolCall?.args ?? {})}\n${s.error ?? ""}\n${s.lastToolResult?.output ?? ""}`;
    if (s.budgetLeft.turnsRemaining <= 0) decision = "stop";
    else if (/\brm\s+-rf\b/i.test(text) || /--force/i.test(text) || /DROP TABLE/i.test(text)) decision = "ask";
    else if (/credential|approval|ENEEDAUTH/i.test(text)) decision = "ask";
    else if (s.lastToolResult && !s.lastToolResult.ok) decision = "retry";
    else if (/ALL CHECKS PASSED/i.test(s.lastToolResult?.output ?? "")) decision = "stop";
    else if (/No tests run yet|not yet validated/i.test(s.lastToolResult?.output ?? "")) decision = "verify";
    return { decision, confidence: 1, reason: "rule router", escalated: false };
  },
};

test("eval: 240-sample dataset + rule router report is coherent", async () => {
  const dataset = generateSyntheticDataset(240);
  assert.equal(dataset.length, 240);
  assert.equal(new Set(dataset.map((s) => s.category)).size, 13);
  const report = await evaluateDecisionRouter("rule-router", ruleRouter, dataset);
  assert.equal(report.totalSamples, 240);
  assert.equal(report.correct, 240);
  assert.equal(report.accuracy, 1);
  assert.equal(report.escalationRate, 0);
  const classTotals = Object.values(report.perClassAccuracy).reduce((n, b) => n + b.total, 0);
  assert.equal(classTotals, 240);
  for (const b of Object.values(report.perClassAccuracy)) assert.equal(b.accuracy, 1);
});
