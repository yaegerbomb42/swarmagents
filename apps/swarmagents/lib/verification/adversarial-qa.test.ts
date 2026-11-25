import test from "node:test";
import assert from "node:assert/strict";
import {
  ADVERSARIAL_QA_DEFAULT_APP_URL,
  adversarialQaAppUrl,
  adversarialQaEnabled,
  buildQaPrompts,
  parseQaVerdict,
  runAdversarialQa,
  selectQaProviders,
  type AdversarialQaContext,
  type AdversarialQaDeps,
  type HttpTrace,
} from "./adversarial-qa";
import type { ProviderConfig } from "../providers/types";

function provider(id: string, fastModel: string): ProviderConfig {
  return { id, kind: "openai", models: { fast: fastModel } } as ProviderConfig;
}

const criteria = "The home page loads. The health endpoint returns 200.";
const appUrl = "https://swarmagents.codes";

function okTrace(label: string, url: string): HttpTrace {
  return { label, url, method: "GET", status: 200, ok: true, latencyMs: 42, bytes: 1234 };
}

function baseCtx(): AdversarialQaContext {
  return {
    acceptanceCriteria: criteria,
    appUrl,
    checks: [
      { label: "app", url: appUrl },
      { label: "health", url: `${appUrl}/api/health` },
    ],
    qaProvider: "deepseek",
    qaModel: "deepseek-chat",
    qaFamily: "deepseek",
  };
}

function baseDeps(overrides: Partial<AdversarialQaDeps> = {}): AdversarialQaDeps {
  return {
    callLLM: async () =>
      JSON.stringify({ passed: true, score: 95, violations: [], unverifiable: [] }),
    fetchUrl: async (url) => okTrace(url.endsWith("/api/health") ? "health" : "app", url),
    ...overrides,
  };
}

test("adversarial QA is off by default and requires an explicit opt-in", () => {
  assert.equal(adversarialQaEnabled({}), false);
  assert.equal(adversarialQaEnabled({ SWARM_ADVERSARIAL_QA: "0" }), false);
  assert.equal(adversarialQaEnabled({ SWARM_ADVERSARIAL_QA: "true" }), true);
  assert.equal(adversarialQaEnabled({ SWARM_ADVERSARIAL_QA: "1" }), true);
});

test("QA app URL defaults to the live site and honors the override", () => {
  assert.equal(adversarialQaAppUrl({}), ADVERSARIAL_QA_DEFAULT_APP_URL);
  assert.equal(adversarialQaAppUrl({ SWARM_ADVERSARIAL_QA_URL: "https://preview.example.test/" }), "https://preview.example.test");
});

test("QA providers exclude the builder's model family, cheapest first", () => {
  const providers = [
    provider("anthropic", "claude-sonnet-4-5"),
    provider("deepseek", "deepseek-chat"),
    provider("openai", "gpt-4.1"),
  ];
  const qa = selectQaProviders(providers, "claude-sonnet-4-5");
  assert.deepEqual(
    qa.map((c) => c.id),
    ["deepseek", "openai"],
  );
});

test("QA providers exclude same-family models served by another host", () => {
  // claude served via OpenRouter is still the claude family — not independent.
  const providers = [provider("openrouter", "anthropic/claude-sonnet-4.5"), provider("google", "gemini-2.5-flash")];
  assert.deepEqual(
    selectQaProviders(providers, "claude-sonnet-4-5").map((c) => c.id),
    ["google"],
  );
});

test("no QA provider when every provider shares the builder's family", () => {
  const providers = [provider("anthropic", "claude-sonnet-4-5"), provider("openrouter", "anthropic/claude-haiku-4-5")];
  assert.deepEqual(selectQaProviders(providers, "claude-sonnet-4-5"), []);
});

test("unknown builder model only admits providers with a known different family", () => {
  const providers = [provider("mystery", "some-unknown-model"), provider("deepseek", "deepseek-chat")];
  assert.deepEqual(
    selectQaProviders(providers, "some-unknown-model").map((c) => c.id),
    ["deepseek"],
  );
});

test("QA prompt is blind: criteria, URL and traces only — no builder chat or diff", () => {
  const { system, user } = buildQaPrompts(criteria, appUrl, [okTrace("app", appUrl)], [
    { label: "live app screenshot (1280x800, frame #1)", url: appUrl, ok: true },
  ]);
  assert.match(user, /Acceptance criteria:/);
  assert.match(user, /The home page loads/);
  assert.match(user, /https:\/\/swarmagents\.codes/);
  assert.match(user, /HTTP 200/);
  assert.match(user, /live app screenshot/);
  assert.match(system, /never seen the builder's work, chat, or code/);
  // Nothing in either prompt could carry builder state: no such field exists.
  assert.doesNotMatch(user, /builder chat|diff:|run log/i);
});

test("QA verdict parsing accepts a verdict and rejects malformed replies", () => {
  assert.deepEqual(parseQaVerdict(JSON.stringify({ passed: true, score: 90, violations: [], unverifiable: ["x"] })), {
    passed: true,
    score: 90,
    violations: [],
    unverifiable: ["x"],
  });
  assert.deepEqual(parseQaVerdict('noise {"passed": false, "score": 10, "violations": ["down"]} trailing'), {
    passed: false,
    score: 10,
    violations: ["down"],
    unverifiable: [],
  });
  assert.equal(parseQaVerdict("not json at all"), null);
  assert.equal(parseQaVerdict(JSON.stringify({ passed: "yes", score: 90, violations: [] })), null);
  assert.equal(parseQaVerdict(JSON.stringify({ passed: true, score: 90, violations: [42] })), null);
});

test("a passing QA verdict passes with traces, screenshots and provider recorded", async () => {
  const lines: string[] = [];
  const summary = await runAdversarialQa(
    baseDeps({
      screenshot: async () => ({ ok: true, label: "live app screenshot (1280x800, frame #1)" }),
      log: (line) => lines.push(line),
    }),
    baseCtx(),
  );
  assert.ok(summary);
  assert.equal(summary.passed, true);
  assert.equal(summary.badge, "pass");
  assert.equal(summary.score, 95);
  assert.equal(summary.qaProvider, "deepseek");
  assert.equal(summary.qaModel, "deepseek-chat");
  assert.equal(summary.qaFamily, "deepseek");
  assert.equal(summary.httpTraces.length, 2);
  assert.equal(summary.httpTraces[0].status, 200);
  assert.equal(summary.screenshots.length, 1);
  assert.equal(summary.screenshots[0].ok, true);
  assert.match(lines.join("\n"), /qa: PASSED/);
});

test("a failing QA verdict blocks with violations and a remediation prompt", async () => {
  const summary = await runAdversarialQa(
    baseDeps({
      callLLM: async () =>
        JSON.stringify({
          passed: false,
          score: 20,
          violations: ["Home page shows a blank screen"],
          unverifiable: ["Login flow"],
          remediationPrompt: "Fix the blank home page.",
        }),
    }),
    baseCtx(),
  );
  assert.ok(summary);
  assert.equal(summary.passed, false);
  assert.equal(summary.badge, "fail");
  assert.deepEqual(summary.violations, ["Home page shows a blank screen"]);
  assert.deepEqual(summary.unverifiable, ["Login flow"]);
  assert.equal(summary.remediationPrompt, "Fix the blank home page.");
});

test("unverifiable criteria are reported, not silently passed", async () => {
  const summary = await runAdversarialQa(
    baseDeps({
      callLLM: async () =>
        JSON.stringify({ passed: true, score: 80, violations: [], unverifiable: ["2FA handoff"] }),
    }),
    baseCtx(),
  );
  assert.ok(summary);
  assert.equal(summary.passed, true);
  assert.deepEqual(summary.unverifiable, ["2FA handoff"]);
});

test("a failed probe blocks completion with HTTP traces and no judge call", async () => {
  let judgeCalls = 0;
  const summary = await runAdversarialQa(
    baseDeps({
      callLLM: async () => {
        judgeCalls += 1;
        return JSON.stringify({ passed: true, score: 100, violations: [], unverifiable: [] });
      },
      fetchUrl: async (url) =>
        url.endsWith("/api/health")
          ? { label: "health", url, method: "GET", status: 500, ok: false, latencyMs: 10, bytes: 50 }
          : okTrace("app", url),
    }),
    baseCtx(),
  );
  assert.ok(summary);
  assert.equal(summary.passed, false);
  assert.equal(summary.badge, "fail");
  assert.equal(summary.buildBroke, true);
  assert.equal(judgeCalls, 0);
  assert.match(summary.violations[0], /health.*HTTP 500/);
  assert.match(summary.remediationPrompt ?? "", /HTTP traces:/);
  assert.match(summary.remediationPrompt ?? "", /health: GET .* -> HTTP 500/);
});

test("a network probe error blocks with the error in the trace", async () => {
  const summary = await runAdversarialQa(
    baseDeps({
      fetchUrl: async (url) => ({
        label: "app",
        url,
        method: "GET",
        status: 0,
        ok: false,
        latencyMs: 5,
        bytes: 0,
        error: "ECONNREFUSED",
      }),
    }),
    baseCtx(),
  );
  assert.ok(summary);
  assert.equal(summary.passed, false);
  assert.match(summary.violations[0], /ECONNREFUSED/);
});

test("the gate still runs on traces alone when no screenshot driver is wired", async () => {
  const summary = await runAdversarialQa(baseDeps(), baseCtx());
  assert.ok(summary);
  assert.equal(summary.passed, true);
  assert.deepEqual(summary.screenshots, []);
});

test("a failed screenshot is recorded as evidence, not a gate failure", async () => {
  const summary = await runAdversarialQa(
    baseDeps({ screenshot: async () => ({ ok: false, reason: "no Chromium" }) }),
    baseCtx(),
  );
  assert.ok(summary);
  assert.equal(summary.passed, true);
  assert.equal(summary.screenshots[0].ok, false);
  assert.equal(summary.screenshots[0].reason, "no Chromium");
});

test("judge call failure skips the gate instead of blocking the run", async () => {
  const lines: string[] = [];
  const summary = await runAdversarialQa(
    baseDeps({
      callLLM: async () => {
        throw new Error("provider down");
      },
      log: (line) => lines.push(line),
    }),
    baseCtx(),
  );
  assert.equal(summary, undefined);
  assert.match(lines.join("\n"), /judge call failed — skipping/);
});

test("unparseable judge verdict skips the gate instead of blocking the run", async () => {
  const summary = await runAdversarialQa(
    baseDeps({ callLLM: async () => "looks fine to me, ship it" }),
    baseCtx(),
  );
  assert.equal(summary, undefined);
});
