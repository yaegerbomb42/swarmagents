import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProviderKey, configureProviderStorePaths, saveProvider } from "./store";
import { createUserRunPool, userPoolProviders, userPoolRouter } from "./user-run-pool";
import { RunProviderPool, classifyPoolError, familyModelFor, runWithPool } from "./run-pool";
import type { AttemptOutcome, RunAttempt, RunPoolEvent } from "./run-pool";
import { modelFamily } from "./model-family";
import type { ProviderConfig } from "./types";

// Fake but key-shaped values. They only ever live in this temp store.
const GROQ_KEYS = ["gsk_free_alpha_1111", "gsk_free_bravo_2222", "gsk_free_charlie_3333"];
const OPENROUTER_KEY = "sk-or-v1-delta-4444";
const GITHUB_KEY = "github_pat_echo_5555";
const DEEPINFRA_KEY = "di_foxtrot_6666";
const HOST_ENV_KEY = "host-env-key-must-never-be-used";
const ALL_KEYS = [...GROQ_KEYS, OPENROUTER_KEY, GITHUB_KEY, DEEPINFRA_KEY, HOST_ENV_KEY];

const U = "pool_tester@example.com";
let tempDir: string;
let savedEnv: Record<string, string | undefined>;
let clock: number;
const now = () => clock;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-run-pool-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  clock = 1_000_000;
  // A host key in env must be ignored: pool keys come from the user's config only.
  savedEnv = { SWARM_KEYS_GROQ: process.env.SWARM_KEYS_GROQ, SWARM_KEYS_OPENROUTER: process.env.SWARM_KEYS_OPENROUTER };
  process.env.SWARM_KEYS_GROQ = HOST_ENV_KEY;
  process.env.SWARM_KEYS_OPENROUTER = HOST_ENV_KEY;
});

test.afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

/** A free-tier host with three keys, plus a paid backup ranked after it. */
function saveFreeTierUser(): void {
  saveProvider(U, { id: "groq", apiKey: GROQ_KEYS[0], isFree: true, rank: 0 });
  addProviderKey(U, "groq", GROQ_KEYS[1]);
  addProviderKey(U, "groq", GROQ_KEYS[2]);
  saveProvider(U, { id: "openrouter", apiKey: OPENROUTER_KEY, rank: 1 });
}

/**
 * Stand-in for the Claude Code CLI: decides each attempt's outcome from the
 * credential the attempt was given, and records what it was launched with.
 */
function fakeCli(script: (token: string, attempt: RunAttempt) => AttemptOutcome) {
  const launches: Array<{ token: string; model: string; resume?: string }> = [];
  const execute = async (attempt: RunAttempt): Promise<AttemptOutcome> => {
    const token = attempt.selection.env.ANTHROPIC_AUTH_TOKEN ?? attempt.selection.env.ANTHROPIC_API_KEY ?? "";
    launches.push({ token, model: attempt.selection.env.ANTHROPIC_MODEL, ...(attempt.resumeSessionId ? { resume: attempt.resumeSessionId } : {}) });
    return script(token, attempt);
  };
  return { launches, execute };
}

function assertNoKeys(value: unknown, label: string): void {
  const text = JSON.stringify(value);
  for (const key of ALL_KEYS) assert.equal(text.includes(key), false, `${label} leaked a key value`);
}

test("acceptance: a run completes across a free-tier key rotation with no provider error", async () => {
  saveFreeTierUser();
  const events: RunPoolEvent[] = [];
  const router = userPoolRouter(U, { now });
  const pool = new RunProviderPool(router, { onEvent: (e) => events.push(e) });

  const cli = fakeCli((token) => {
    if (token === GROQ_KEYS[0]) return { status: "error", sessionId: "sess-1", message: "API Error: 429 {\"error\":{\"message\":\"Rate limit reached for model on free tier\"}}" };
    if (token === GROQ_KEYS[1]) return { status: "error", sessionId: "sess-1", message: "API Error: You exceeded your current quota (insufficient_quota)" };
    if (token === GROQ_KEYS[2]) return { status: "done", sessionId: "sess-1" };
    return { status: "error", message: "unexpected provider" };
  });

  const result = await runWithPool(pool, cli.execute);

  assert.equal(result.ok, true, result.error ?? "");
  assert.equal(result.error, undefined, "the user sees no provider error");
  assert.deepEqual(
    result.attempts.map((a) => [a.provider, a.keyId, a.reason]),
    [
      ["groq", "groq:key-1", "initial"],
      ["groq", "groq:key-2", "key-rotation"],
      ["groq", "groq:key-3", "key-rotation"],
    ],
    "rotates through the same free-tier provider's keys before any failover"
  );
  // Each rotation resumes the same CLI conversation instead of starting over.
  assert.deepEqual(cli.launches.map((l) => l.resume), [undefined, "sess-1", "sess-1"]);
  assert.deepEqual(cli.launches.map((l) => l.token), GROQ_KEYS, "only the user's saved keys were used");
  assert.ok(cli.launches.every((l) => l.model === "llama-3.3-70b-versatile"));
  assert.equal(events.filter((e) => e.type === "pool.failover").length, 0);
  assert.deepEqual(
    events.filter((e) => e.type === "pool.rotate").map((e) => e.type === "pool.rotate" && [e.fromKeyId, e.kind]),
    [["groq:key-1", "rate_limit"], ["groq:key-2", "quota_exhausted"]]
  );

  // The two failing keys are benched in the shared pool; the winner is healthy.
  const stats = router.keyPool("groq")!.stats();
  assert.deepEqual(stats.map((s) => s.available), [false, false, true]);
  assert.deepEqual(stats.map((s) => s.successes), [0, 0, 1]);
  assertNoKeys(events, "pool events");
  assertNoKeys(result, "run result");
});

test("a later run on the same router skips the benched key from the start", async () => {
  saveFreeTierUser();
  const router = userPoolRouter(U, { now });
  const first = await runWithPool(new RunProviderPool(router), fakeCli((token) =>
    token === GROQ_KEYS[0] ? { status: "error", message: "429 Too Many Requests" } : { status: "done" }
  ).execute);
  assert.equal(first.ok, true);
  const second = await runWithPool(new RunProviderPool(router), fakeCli(() => ({ status: "done" })).execute);
  // key-1 is cooling; the pool spreads load to the least recently used healthy key.
  assert.equal(second.attempts.length, 1);
  assert.equal(second.attempts[0].keyId, "groq:key-3");
  assert.equal(second.attempts[0].reason, "initial");
});

test("fails over to the next provider only after every key of the first is benched", async () => {
  saveFreeTierUser();
  const events: RunPoolEvent[] = [];
  const pool = createUserRunPool(U, { onEvent: (e) => events.push(e) }, { now });
  const cli = fakeCli((token) =>
    GROQ_KEYS.includes(token) ? { status: "error", sessionId: "sess-9", message: "Error: 429 rate_limit_exceeded" } : { status: "done" }
  );
  const result = await runWithPool(pool, cli.execute);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.attempts.map((a) => [a.provider, a.reason]),
    [["groq", "initial"], ["groq", "key-rotation"], ["groq", "key-rotation"], ["openrouter", "failover"]]
  );
  assert.equal(cli.launches[3].token, OPENROUTER_KEY);
  assert.equal(cli.launches[3].resume, "sess-9", "failover also resumes the conversation");
  assert.equal(events.filter((e) => e.type === "pool.failover").length, 1);
});

test("provider-wide failures (5xx, overload) fail over at once instead of burning keys", async () => {
  saveFreeTierUser();
  const pool = createUserRunPool(U, {}, { now });
  const cli = fakeCli((token) =>
    token === GROQ_KEYS[0] ? { status: "error", message: "API Error: 503 Service Unavailable" } : { status: "done" }
  );
  const result = await runWithPool(pool, cli.execute);
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((a) => [a.provider, a.reason]), [["groq", "initial"], ["openrouter", "failover"]]);
});

test("a non-provider error ends the run without benching the key", async () => {
  saveFreeTierUser();
  const router = userPoolRouter(U, { now });
  const pool = new RunProviderPool(router);
  const result = await runWithPool(pool, fakeCli(() => ({ status: "error", message: "Tool Bash failed: exit code 1" })).execute);
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 1);
  assert.match(result.error ?? "", /Tool Bash failed/);
  assert.deepEqual(router.keyPool("groq")!.stats().map((s) => [s.available, s.failures]), [[true, 0], [true, 0], [true, 0]]);
});

test("when every key everywhere is exhausted the run ends with a redacted summary", async () => {
  saveFreeTierUser();
  const pool = createUserRunPool(U, {}, { now });
  // A provider that echoes the key back in its error body must not leak it.
  const result = await runWithPool(pool, fakeCli((token) => ({ status: "error", message: `401 invalid api key ${token}` })).execute);
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 4);
  assert.match(result.error ?? "", /All provider attempts failed/);
  assertNoKeys(result, "failure summary");
});

test("the attempt cap stops a run that keeps failing", async () => {
  saveFreeTierUser();
  const pool = createUserRunPool(U, { maxAttempts: 2 }, { now });
  const result = await runWithPool(pool, fakeCli(() => ({ status: "error", message: "429" })).execute);
  assert.equal(result.ok, false);
  assert.equal(result.attempts.length, 2);
});

test("pool keys come only from the user's saved config, never host env", () => {
  // No saved providers: the env keys set in beforeEach must not appear.
  const providers = userPoolProviders(U);
  assert.ok(providers.length > 0, "built-in defaults are still listed");
  for (const p of providers) {
    assert.deepEqual(p.keys, [], `${p.id} must have an explicit empty key list`);
    assert.equal(p.envKeys, undefined);
  }
  const pool = createUserRunPool(U, {}, { now });
  assert.equal(pool.next(), null, "nothing to lease without saved keys");
  assert.match(pool.failureSummary(), /No provider attempt/);

  // Another account's keys are invisible to this user.
  saveProvider("someone_else@example.com", { id: "groq", apiKey: GROQ_KEYS[0] });
  assert.equal(createUserRunPool(U, {}, { now }).next(), null);
});

test("acceptance: a run switches to a different model family mid-task and resumes the session", async () => {
  saveProvider(U, { id: "openrouter", apiKey: OPENROUTER_KEY, rank: 0, models: ["anthropic/claude-sonnet-4-5"] });
  saveProvider(U, { id: "github", apiKey: GITHUB_KEY, rank: 1, models: ["openai/gpt-4.1"] });
  const events: RunPoolEvent[] = [];
  const router = userPoolRouter(U, { now });
  const pool = new RunProviderPool(router, { onEvent: (e) => events.push(e) });

  const cli = fakeCli((_token, attempt) =>
    attempt.n === 1
      ? { status: "switch-family", family: "gpt", reason: "second opinion from another family", sessionId: "sess-claude" }
      : { status: "done", sessionId: "sess-claude" }
  );
  const result = await runWithPool(pool, cli.execute);

  assert.equal(result.ok, true, result.error ?? "");
  assert.deepEqual(
    result.attempts.map((a) => [a.provider, a.model, a.family, a.reason]),
    [
      ["openrouter", "anthropic/claude-sonnet-4-5", "claude", "initial"],
      ["github", "openai/gpt-4.1", "gpt", "family-switch"],
    ]
  );
  assert.equal(cli.launches[1].token, GITHUB_KEY);
  assert.equal(cli.launches[1].model, "openai/gpt-4.1", "the CLI is launched on the new family's model");
  assert.equal(cli.launches[1].resume, "sess-claude", "same conversation continues on the new family");
  assert.equal(pool.pinnedFamily, "gpt");
  const switchEvent = events.find((e) => e.type === "pool.family");
  assert.deepEqual(switchEvent, { type: "pool.family", from: "claude", to: "gpt", reason: "second opinion from another family" });
  // The claude key was released, not punished, by the switch.
  const [claudeKey] = router.keyPool("openrouter")!.stats();
  assert.deepEqual([claudeKey.available, claudeKey.failures], [true, 0]);
  assert.equal(router.keyPool("github")!.stats()[0].successes, 1);
});

test("after a family switch, failover stays inside the new family", async () => {
  saveProvider(U, { id: "openrouter", apiKey: OPENROUTER_KEY, rank: 0, models: ["anthropic/claude-sonnet-4-5"] });
  saveProvider(U, { id: "github", apiKey: GITHUB_KEY, rank: 1, models: ["openai/gpt-4.1"] });
  saveProvider(U, { id: "deepinfra", apiKey: DEEPINFRA_KEY, rank: 2, models: ["openai/gpt-oss-120b", "meta-llama/Llama-3.3-70B-Instruct"] });
  const router = userPoolRouter(U, { now });
  const pool = new RunProviderPool(router, { model: "anthropic/claude-sonnet-4-5" });

  const a1 = pool.next()!;
  assert.equal(a1.selection.provider, "openrouter");
  assert.equal(pool.switchFamily("gpt", { sessionId: "s-1" }), true);
  const a2 = pool.next()!;
  assert.equal(a2.selection.provider, "github");
  assert.equal(a2.resumeSessionId, "s-1");
  assert.equal(pool.reportFailure(a2, "API Error: 529 overloaded").action, "failover");
  const a3 = pool.next()!;
  assert.equal(a3.selection.provider, "deepinfra", "falls over to another gpt host, not back to claude");
  assert.equal(a3.selection.model, "openai/gpt-oss-120b");
  assert.equal(a3.reason, "failover");
  assert.equal(pool.reportFailure(a3, "API Error: 529 overloaded").action, "failover");
  assert.equal(pool.next(), null, "openrouter still has a healthy key, but it serves no gpt model");
});

test("switching to a family no provider serves is refused and changes nothing", () => {
  saveFreeTierUser();
  const pool = createUserRunPool(U, {}, { now });
  const a1 = pool.next()!;
  assert.equal(pool.switchFamily("gemini"), false);
  assert.equal(pool.pinnedFamily, null);
  pool.reportSuccess(a1);
  assert.throws(() => pool.switchFamily("gpt", { model: "claude-opus-4-1" }), /not in the gpt family/);
});

test("switchFamily can name an exact model", () => {
  saveProvider(U, { id: "openrouter", apiKey: OPENROUTER_KEY, models: ["anthropic/claude-sonnet-4-5", "openai/gpt-4.1", "openai/gpt-5"] });
  const pool = createUserRunPool(U, {}, { now });
  pool.reportSuccess(pool.next()!);
  assert.equal(pool.switchFamily("gpt", { model: "openai/gpt-5" }), true);
  const next = pool.next()!;
  assert.equal(next.selection.provider, "openrouter");
  assert.equal(next.selection.model, "openai/gpt-5");
});

test("attempts must be settled in order", () => {
  saveFreeTierUser();
  const pool = createUserRunPool(U, {}, { now });
  const a1 = pool.next()!;
  assert.throws(() => pool.next(), /settle the current attempt/);
  pool.reportSuccess(a1);
  assert.throws(() => pool.reportSuccess(a1), /not the one in flight/);
});

test("classifyPoolError: key-scoped, provider-scoped and non-provider errors", () => {
  const cases: Array<[string, string | null, number | undefined]> = [
    ["API Error: 429 Too Many Requests", "rate_limit", 429],
    ["Rate limit reached for requests", "rate_limit", undefined],
    ["API Error: 401 Unauthorized", "auth", 401],
    ["403 Forbidden: key lacks models:read", "auth", 403],
    ["Invalid API key provided", "auth", undefined],
    ["402 Payment Required", "quota_exhausted", 402],
    ["insufficient_quota: You exceeded your current quota", "quota_exhausted", undefined],
    ["Insufficient credits, top up", "quota_exhausted", undefined],
    ["API Error: 529 overloaded_error", "server", 529],
    ["502 Bad Gateway", "server", 502],
    ["fetch failed: ECONNRESET", "network", undefined],
    ["Tool Bash failed: exit code 1", null, undefined],
    ["TypeError: cannot read 'x' of undefined at line 403.5", null, undefined],
  ];
  for (const [message, kind, status] of cases) {
    const got = classifyPoolError(message);
    assert.equal(got?.kind ?? null, kind, message);
    if (kind) assert.equal(got?.status, status, message);
  }
});

test("modelFamily groups ids across hosts", () => {
  const cases: Array<[string, string]> = [
    ["claude-sonnet-4-5", "claude"],
    ["anthropic/claude-opus-4.1", "claude"],
    ["gpt-4.1", "gpt"],
    ["openai/gpt-oss-120b", "gpt"],
    ["o3-mini", "gpt"],
    ["openai/o4-mini", "gpt"],
    ["gpt-5-codex", "gpt"],
    ["gemini-2.5-pro", "gemini"],
    ["google/gemma-3-27b-it", "gemma"],
    ["llama-3.3-70b-versatile", "llama"],
    ["meta-llama/Llama-3.3-70B-Instruct", "llama"],
    ["nvidia/llama-3.1-nemotron-70b-instruct", "nemotron"],
    ["deepseek-r1-distill-qwen-32b", "deepseek"],
    ["Qwen/Qwen3-Coder-480B", "qwen"],
    ["devstral-medium", "mistral"],
    ["grok-4", "grok"],
    ["kimi-k2-instruct", "kimi"],
    ["glm-4.6", "glm"],
    ["MiniMax-Text-01", "minimax"],
    ["command-r-plus", "command"],
    ["phi-4", "phi"],
    ["mercury-coder", "mercury"],
    ["some-new-model", "other"],
    ["", "other"],
  ];
  for (const [id, family] of cases) assert.equal(modelFamily(id), family, id);
});

test("familyModelFor prefers the requested model, then tier models, then discovered ones", () => {
  const config: ProviderConfig = {
    id: "openrouter",
    kind: "openai",
    models: { balanced: "anthropic/claude-sonnet-4-5" },
    availableModels: ["openai/gpt-4.1", "google/gemini-2.5-pro"],
  };
  assert.equal(familyModelFor(config, "gpt"), "openai/gpt-4.1");
  assert.equal(familyModelFor(config, "gpt", "openai/gpt-5"), "openai/gpt-5");
  assert.equal(familyModelFor(config, "claude"), "anthropic/claude-sonnet-4-5");
  assert.equal(familyModelFor(config, "grok"), undefined);
});
