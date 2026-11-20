import test from "node:test";
import assert from "node:assert/strict";

import { HealthChecker } from "./health";
import type { FetchLike, ProviderConfig, ProviderKind } from "./types";

function provider(
  id: string,
  kind: ProviderKind,
  keys: string[],
  rank: number
): ProviderConfig {
  return {
    id,
    kind,
    keys,
    rank,
    models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
  };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function anthropicOk() {
  return {
    content: [{ type: "text", text: "pong" }],
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "test-fast",
  };
}

function openaiOk() {
  return {
    choices: [{ message: { content: "pong" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    model: "test-fast",
  };
}

test("checkProvider probes a single provider and returns its health", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => {
    calls += 1;
    return jsonResponse(openaiOk());
  };
  const checker = new HealthChecker({
    providers: [
      provider("openai", "openai", ["sk-openai-health"], 0),
      provider("anthropic", "anthropic", ["sk-ant-health"], 1),
    ],
    fetch: fetchMock,
    now: () => 2000,
  });

  const health = await checker.checkProvider("openai");
  assert.ok(health);
  assert.equal(health.id, "openai");
  assert.equal(health.ok, true);
  assert.equal(health.latencyMs, 0);
  assert.equal(health.checkedAt, 2000);
  assert.equal(calls, 1);
});

test("checkProvider returns null for an unknown provider", async () => {
  const checker = new HealthChecker({
    providers: [provider("openai", "openai", ["sk-openai-health"], 0)],
    fetch: async () => jsonResponse(openaiOk()),
  });
  assert.equal(await checker.checkProvider("nope"), null);
});

test("checkProvider probes a disabled provider so a new key can be verified", async () => {
  const checker = new HealthChecker({
    providers: [{ ...provider("openai", "openai", ["sk-openai-health"], 0), enabled: false }],
    fetch: async () => jsonResponse(openaiOk()),
    now: () => 3000,
  });
  const health = await checker.checkProvider("openai");
  assert.ok(health);
  assert.equal(health.ok, true);
});

test("marks provider healthy on 200 with valid completion body", async () => {
  let calledUrl = "";
  const fetchMock: FetchLike = async (url) => {
    calledUrl = url;
    return jsonResponse(anthropicOk());
  };

  const checker = new HealthChecker({
    providers: [provider("anthropic", "anthropic", ["sk-ant-health"], 0)],
    fetch: fetchMock,
    now: () => 1000,
  });

  await checker.checkAll();
  const [snapshot] = checker.snapshot;

  assert.equal(snapshot.id, "anthropic");
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.latencyMs, 0);
  assert.equal(snapshot.checkedAt, 1000);
  assert.ok(calledUrl.includes("anthropic"));
});

test("marks provider unhealthy on HTTP error and invokes callback", async () => {
  const fetchMock: FetchLike = async () =>
    jsonResponse({ error: { message: "boom" } }, { status: 500 });

  let unhealthyId = "";
  let cooldownMs = 0;

  const checker = new HealthChecker({
    providers: [provider("openai", "openai", ["sk-oai-health"], 0)],
    fetch: fetchMock,
    now: () => 2000,
    onUnhealthy: (id, ms) => {
      unhealthyId = id;
      cooldownMs = ms;
    },
  });

  await checker.checkAll();
  const [snapshot] = checker.snapshot;

  assert.equal(snapshot.id, "openai");
  assert.equal(snapshot.ok, false);
  assert.equal(unhealthyId, "openai");
  assert.equal(cooldownMs, 60_000); // interval default 30s * 2 capped at 60s
  assert.match(snapshot.error ?? "", /HTTP 500/);
});

test("marks provider unhealthy on network/parse error", async () => {
  const fetchMock: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };

  const checker = new HealthChecker({
    providers: [provider("gemini", "gemini", ["gem-health"], 0)],
    fetch: fetchMock,
    now: () => 3000,
  });

  await checker.checkAll();
  const [snapshot] = checker.snapshot;

  assert.equal(snapshot.id, "gemini");
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.error, "ECONNREFUSED");
});

test("marks provider unhealthy when no keys are configured", async () => {
  const checker = new HealthChecker({
    providers: [provider("anthropic", "anthropic", [], 0)],
    fetch: async () => jsonResponse({}),
    now: () => 4000,
  });

  await checker.checkAll();
  const [snapshot] = checker.snapshot;

  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.error, "No keys configured");
});

test("no-keys failure reports latencyMs null, never an epoch value", async () => {
  const checker = new HealthChecker({
    providers: [provider("anthropic", "anthropic", [], 0)],
    fetch: async () => jsonResponse({}),
    // A wall-clock now(): the old code reported now() - 0 here.
    now: () => 1_794_512_319_954,
  });

  await checker.checkAll();
  const [snapshot] = checker.snapshot;

  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.latencyMs, null);
  assert.equal(snapshot.checkedAt, 1_794_512_319_954);
});

test("empty-text and reasoning-only completions count as healthy", async () => {
  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) {
      // Reasoning model: thinking block only, no text.
      return jsonResponse({
        content: [{ type: "thinking", thinking: "let me think" }],
        usage: { input_tokens: 1, output_tokens: 0 },
        model: "test-fast",
      });
    }
    if (url.includes("generativelanguage")) {
      // Gemini: candidate with no text parts.
      return jsonResponse({
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        modelVersion: "test-fast",
      });
    }
    // OpenAI-compatible reasoning model: empty content, reasoning only.
    return jsonResponse({
      choices: [
        {
          message: { role: "assistant", content: "", reasoning_content: "thinking…" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
      model: "test-fast",
    });
  };

  const checker = new HealthChecker({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant"], 0),
      provider("openai", "openai", ["sk-oai"], 1),
      provider("gemini", "gemini", ["sk-gem"], 2),
    ],
    fetch: fetchMock,
    now: () => 6000,
  });

  await checker.checkAll();
  const snapshot = checker.snapshot;

  assert.equal(snapshot.length, 3);
  assert.ok(snapshot.every((s) => s.ok), JSON.stringify(snapshot));
});

test("empty content array is a well-formed completion, not a failure", async () => {
  const checker = new HealthChecker({
    providers: [provider("anthropic", "anthropic", ["sk-ant"], 0)],
    fetch: async () =>
      jsonResponse({
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        model: "test-fast",
      }),
    now: () => 6000,
  });

  await checker.checkAll();
  assert.equal(checker.snapshot[0].ok, true);
});

test("malformed 2xx bodies are still unhealthy", async () => {
  const cases: Array<{ body: unknown; pattern: RegExp }> = [
    { body: "{not json", pattern: /not JSON/ },
    { body: { choices: [] }, pattern: /missing choices array/ },
    { body: { choices: [{ finish_reason: "stop" }] }, pattern: /no message/ },
    { body: { error: { message: "model overloaded" } }, pattern: /provider error: model overloaded/ },
    { body: { candidates: [] }, pattern: /missing candidates array/ },
  ];

  for (const { body, pattern } of cases) {
    const kind: ProviderKind =
      typeof body === "object" && body !== null && "candidates" in body
        ? "gemini"
        : "openai";
    const checker = new HealthChecker({
      providers: [provider(kind, kind, ["sk-test"], 0)],
      fetch: async () => jsonResponse(body),
      now: () => 6000,
    });
    await checker.checkAll();
    const [snapshot] = checker.snapshot;
    assert.equal(snapshot.ok, false, JSON.stringify(body));
    assert.match(snapshot.error ?? "", pattern);
  }
});

test("labels 401/402/429 distinctly", async () => {
  const cases: Array<{ status: number; pattern: RegExp }> = [
    { status: 401, pattern: /HTTP 401 \(Unauthorized — invalid or revoked key\)/ },
    { status: 402, pattern: /HTTP 402 \(Payment required — billing or credits exhausted\)/ },
    { status: 429, pattern: /HTTP 429 \(Rate limited — too many requests\)/ },
  ];

  for (const { status, pattern } of cases) {
    const checker = new HealthChecker({
      providers: [provider("openai", "openai", ["sk-oai"], 0)],
      fetch: async () => jsonResponse({ error: { message: "nope" } }, { status }),
      now: () => 6000,
    });
    await checker.checkAll();
    const [snapshot] = checker.snapshot;
    assert.equal(snapshot.ok, false);
    assert.match(snapshot.error ?? "", pattern);
    assert.equal(typeof snapshot.latencyMs, "number");
  }
});

test("probe requests a few tokens, not one", async () => {
  const bodies: string[] = [];
  const fetchMock: FetchLike = async (_url, init) => {
    bodies.push(String((init as { body?: unknown }).body ?? ""));
    return jsonResponse(openaiOk());
  };

  const checker = new HealthChecker({
    providers: [provider("openai", "openai", ["sk-oai"], 0)],
    fetch: fetchMock,
    now: () => 6000,
  });

  await checker.checkAll();
  assert.equal(bodies.length, 1);
  const parsed = JSON.parse(bodies[0]) as { max_tokens?: number };
  assert.ok(
    typeof parsed.max_tokens === "number" && parsed.max_tokens > 1,
    `max_tokens was ${parsed.max_tokens}`
  );
});

test("fullSnapshot reports unprobed providers as checking; ensureChecked awaits the first round", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock: FetchLike = async (url) => {
    await gate;
    if (url.includes("anthropic")) return jsonResponse(anthropicOk());
    return jsonResponse(openaiOk());
  };

  const checker = new HealthChecker({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant"], 0),
      provider("openai", "openai", ["sk-oai"], 1),
    ],
    fetch: fetchMock,
    now: () => 7000,
  });

  checker.start();
  // No probe has finished yet: both providers report as checking, not absent.
  const pending = checker.fullSnapshot();
  assert.equal(pending.length, 2);
  assert.ok(
    pending.every(
      (s) => s.checking === true && s.ok === false && s.latencyMs === null
    ),
    JSON.stringify(pending)
  );

  const ensured = checker.ensureChecked();
  // Still checking while the probe is gated.
  assert.equal(checker.fullSnapshot().filter((s) => s.checking).length, 2);
  release();
  await ensured;

  const done = checker.fullSnapshot();
  assert.ok(done.every((s) => s.ok && s.checking === undefined), JSON.stringify(done));
  checker.stop();
});

test("ensureChecked without start runs one round and returns real results", async () => {
  const checker = new HealthChecker({
    providers: [provider("openai", "openai", ["sk-oai"], 0)],
    fetch: async () => jsonResponse(openaiOk()),
    now: () => 8000,
  });

  assert.equal(checker.fullSnapshot()[0].checking, true);
  await checker.ensureChecked();
  assert.equal(checker.fullSnapshot()[0].ok, true);
  // A second call is a no-op once the first round has settled.
  await checker.ensureChecked();
  assert.equal(checker.snapshot.length, 1);
});

test("checks multiple providers in parallel", async () => {
  const calls: string[] = [];
  const fetchMock: FetchLike = async (url) => {
    calls.push(url);
    if (url.includes("anthropic")) return jsonResponse(anthropicOk());
    return jsonResponse(openaiOk());
  };

  const checker = new HealthChecker({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant"], 0),
      provider("openai", "openai", ["sk-oai"], 1),
    ],
    fetch: fetchMock,
    now: () => 5000,
  });

  await checker.checkAll();
  const snapshot = checker.snapshot;

  assert.equal(snapshot.length, 2);
  assert.ok(snapshot.every((s) => s.ok));
  assert.equal(calls.length, 2);
});

test("never leaks keys into snapshot or errors", async () => {
  const secret = "sk-secret-leak-check";
  const fetchMock: FetchLike = async () =>
    jsonResponse({ error: { message: `bad ${secret}` } }, { status: 401 });

  const checker = new HealthChecker({
    providers: [provider("openai", "openai", [secret], 0)],
    fetch: fetchMock,
  });

  await checker.checkAll();
  const serialized = JSON.stringify(checker.snapshot);
  assert.equal(serialized.includes(secret), false);
});

test("loads provider keys from SWARM_KEYS_<PROVIDER> env", async () => {
  const key = "env-health-key";
  const env = { SWARM_KEYS_OPENAI: key };

  let capturedUrl = "";
  const fetchMock: FetchLike = async (url) => {
    capturedUrl = url;
    return jsonResponse(openaiOk());
  };

  const checker = new HealthChecker({
    providers: [
      {
        id: "openai",
        kind: "openai",
        rank: 0,
        models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
      },
    ],
    env,
    fetch: fetchMock,
  });

  await checker.checkAll();
  assert.equal(checker.snapshot[0].ok, true);
  assert.ok(capturedUrl.includes("openai"));
});

test("respects custom interval and timeout options", async () => {
  const fetchMock: FetchLike = async () => jsonResponse(anthropicOk());

  const checker = new HealthChecker({
    providers: [provider("anthropic", "anthropic", ["sk-ant"], 0)],
    fetch: fetchMock,
    intervalMs: 5_000,
    timeoutMs: 1_000,
    jitter: 0.5,
  });

  assert.equal(checker.snapshot.length, 0); // no checks yet
});

test("feeds router keyPool cooldown via onUnhealthy callback", async () => {
  const { Router } = await import("./router");

  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) {
      return jsonResponse({ error: { message: "dead" } }, { status: 503 });
    }
    return jsonResponse(openaiOk());
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-dead"], 0),
      provider("openai", "openai", ["sk-oai-live"], 1),
    ],
    fetch: async () => jsonResponse(openaiOk()),
    now: () => 5000,
  });

  const checker = new HealthChecker({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-dead"], 0),
      provider("openai", "openai", ["sk-oai-live"], 1),
    ],
    fetch: fetchMock,
    now: () => 5000,
    onUnhealthy: (id, ms) => {
      router.keyPool(id)?.cooldownAllKeys(ms);
    },
  });

  await checker.checkAll();

  // Anthropic keys should be on cooldown
  const anthropicPool = router.keyPool("anthropic");
  assert.ok(anthropicPool);
  const anthropicStats = anthropicPool!.stats();
  assert.equal(anthropicStats[0].available, false);
  assert.ok((anthropicStats[0].cooldownUntil ?? 0) > 5000);

  // OpenAI should still be healthy
  const openaiPool = router.keyPool("openai");
  assert.ok(openaiPool);
  assert.equal(openaiPool!.stats()[0].available, true);
});
