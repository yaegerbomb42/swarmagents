import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "../providers/store";
import { buildLensUserMessage, capFiles, MAX_FILES, MAX_MESSAGE_CHARS } from "./prompts";
import { getCachedLens, lensCacheKey, readLensCache, writeLensCacheEntry } from "./cache";
import { orderProvidersByCost, providerModelPrice, runLens } from "./run";
import { telemetryBus, type SequencedEvent } from "../telemetry";
import { aggregateRunUsage } from "../telemetry/usage";
import type { ProviderConfig } from "../providers/types";

const USER = "lens-tester@example.com";
const OTHER_USER = "other@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-lenses-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  process.env.SWARM_KEYS_OPENAI = "sk-test-openai-lens";
  delete process.env.SWARM_KEYS_ANTHROPIC;
  delete process.env.SWARM_KEYS_GEMINI;
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function openaiOk(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
    model: "gpt-4.1-mini",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the message and the referenced files are capped before they reach a model", () => {
  const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
  const message = buildLensUserMessage({ message: long });
  assert.ok(message.length <= MAX_MESSAGE_CHARS + 40, `message too long: ${message.length}`);
  assert.match(message, /truncated/);

  const files = Array.from({ length: MAX_FILES + 3 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    content: "y".repeat(10_000),
  }));
  const capped = capFiles(files);
  assert.equal(capped.length, MAX_FILES);
  assert.ok(capped.every((file) => file.content.length <= 4_100));

  const withFiles = buildLensUserMessage({ message: "hi", files });
  assert.match(withFiles, /<referenced_files>/);
  assert.match(withFiles, /src\/file-0\.ts/);
});

test("the cache key depends on the message, the lens, the run and the files, and never holds the message", () => {
  const key = lensCacheKey("secret message", "eli5");
  assert.match(key, /^eli5:[0-9a-f]{32}$/);
  assert.equal(key.includes("secret"), false);
  assert.notEqual(key, lensCacheKey("secret message", "security"));
  assert.notEqual(key, lensCacheKey("other message", "eli5"));

  // The same message on a different run is a different answer.
  assert.notEqual(key, lensCacheKey("secret message", "eli5", { runId: "run_a" }));
  assert.notEqual(
    lensCacheKey("secret message", "eli5", { runId: "run_a" }),
    lensCacheKey("secret message", "eli5", { runId: "run_b" }),
  );

  // The same message with different workspace files is a different answer.
  const withFiles = lensCacheKey("secret message", "eli5", {
    files: [{ path: "src/a.ts", content: "const a = 1;" }],
  });
  assert.notEqual(key, withFiles);
  assert.notEqual(
    withFiles,
    lensCacheKey("secret message", "eli5", {
      files: [{ path: "src/a.ts", content: "const a = 2;" }],
    }),
  );
  assert.notEqual(
    withFiles,
    lensCacheKey("secret message", "eli5", {
      files: [{ path: "src/b.ts", content: "const a = 1;" }],
    }),
  );
  assert.equal(
    withFiles,
    lensCacheKey("secret message", "eli5", {
      files: [{ path: "src/a.ts", content: "const a = 1;" }],
    }),
    "identical files must hit the same cache entry",
  );
});

test("cached answers are stored per user, never shared", () => {
  const key = lensCacheKey("a message", "eli5");
  writeLensCacheEntry(USER, key, {
    lens: "eli5",
    text: "the answer",
    provider: "openai",
    model: "gpt-4.1-mini",
    costUsd: 0.001,
    latencyMs: 120,
    createdAt: Date.now(),
  });

  assert.equal(getCachedLens(USER, key)?.text, "the answer");
  assert.equal(getCachedLens(OTHER_USER, key), undefined, "another user must not see this answer");
  assert.equal(Object.keys(readLensCache(OTHER_USER).entries).length, 0);
  assert.ok(lensCacheKey("a message", "eli5") in readLensCache(USER).entries);
});

test("providers are ordered cheapest first, free providers before paid ones", () => {
  const providers: ProviderConfig[] = [
    { id: "anthropic", kind: "anthropic", models: { fast: "claude-haiku-4-5" } },
    { id: "openai", kind: "openai", models: { fast: "gpt-4.1-mini" } },
    { id: "free-provider", kind: "openai", isFree: true, models: { fast: "some-free-model" } },
    { id: "mystery", kind: "openai", models: { fast: "mystery-model" } },
  ];
  const ordered = orderProvidersByCost(providers).map((config) => config.id);
  assert.deepEqual(ordered, ["free-provider", "openai", "anthropic", "mystery"]);
  assert.equal(providerModelPrice(providers[2]).price, 0);
});

test("a lens runs on the cheapest capable model and its cost lands in the run telemetry", async () => {
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ""));
    return jsonResponse(openaiOk("Here is the simple version."));
  }) as unknown as typeof globalThis.fetch;

  const events: SequencedEvent[] = [];
  const unsubscribe = telemetryBus.subscribe("run_lens_1", 0, (event) => events.push(event));

  const result = await runLens({
    userId: USER,
    lens: "eli5",
    message: "We refactored the router to fail over faster.",
    runId: "run_lens_1",
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4.1-mini", "the fast (cheapest) tier must be used");
  assert.equal(result.cached, false);
  assert.equal(result.text, "Here is the simple version.");
  assert.ok((result.costUsd ?? 0) > 0, "the lens cost must be estimated");
  assert.match(bodies[0], /5-year-old/, "the lens system prompt must reach the model");

  const call = events.find((event) => event.type === "llm.call");
  assert.ok(call, "the lens call must be published on the run's bus");
  const data = call.data as { costUsd: number | null; lens: string; provider: string };
  assert.equal(data.lens, "eli5");
  assert.equal(data.provider, "openai");
  assert.equal(typeof data.costUsd, "number");

  // The lens cost shows up in the run's telemetry totals.
  const usage = aggregateRunUsage("run_lens_1", events);
  assert.ok((usage.lensCostUsd ?? 0) > 0, "the run usage must include the lens cost");
  assert.equal(usage.callCostUsd, undefined, "the lens cost is kept apart from the run's own calls");

  unsubscribe();
});

test("the same message and lens is served from the cache the second time", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(openaiOk("cached answer"));
  }) as unknown as typeof globalThis.fetch;

  const message = "A message worth caching.";
  const first = await runLens({ userId: USER, lens: "executive", message });
  const second = await runLens({ userId: USER, lens: "executive", message });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.text, "cached answer");
  assert.equal(calls, 1, "the cached answer must not cost a second provider call");

  // A different lens is a different answer.
  await runLens({ userId: USER, lens: "security", message });
  assert.equal(calls, 2);
});

test("the same message with different files is not served from the cache", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(openaiOk("review answer"));
  }) as unknown as typeof globalThis.fetch;

  const message = "Review this change.";
  const first = await runLens({
    userId: USER,
    lens: "code-review",
    message,
    files: [{ path: "src/a.ts", content: "v1" }],
  });
  const second = await runLens({
    userId: USER,
    lens: "code-review",
    message,
    files: [{ path: "src/a.ts", content: "v2" }],
  });
  const third = await runLens({
    userId: USER,
    lens: "code-review",
    message,
    files: [{ path: "src/a.ts", content: "v2" }],
  });
  const otherRun = await runLens({
    userId: USER,
    lens: "code-review",
    message,
    runId: "run_other",
    files: [{ path: "src/a.ts", content: "v2" }],
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, false, "different file contents must not hit the first answer");
  assert.equal(third.cached, true, "identical files must be served from the cache");
  assert.equal(otherRun.cached, false, "the same files on a different run must not hit the cache");
  assert.equal(calls, 3, "only the identical repeat may skip a provider call");
});
