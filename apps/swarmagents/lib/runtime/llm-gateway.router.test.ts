/**
 * LLM gateway <-> SwarmRouter integration (lib/runtime/llm-routing.ts):
 * route.* telemetry, free-first, paid opt-out, stickiness and failover,
 * key rotation, Retry-After cooldowns, output-quality demotion, restart
 * recovery from the per-user state file, and the rank-order fallback when the
 * router is off or throws. Stubbed fetch only — no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardLlmNonStreaming, forwardLlmStreaming, llmRouterEnabled } from "./llm-gateway";
import { FileRouterStore, resetLlmRoutingForTests, routerQuotaCooldowns, routerStateFilePath } from "./llm-routing";
import { SwarmRouter, type Clock, type RouterSnapshot } from "../router";
import { configureProviderStorePaths } from "../providers/store";
import { writeUserSettings } from "../providers/settings";
import type { ProviderConfig } from "../providers/types";
import type { TelemetryBus } from "../telemetry";

class FakeClock implements Clock {
  t = Date.parse("2026-11-12T10:00:00.000Z");
  now() {
    return this.t;
  }
  random() {
    return 0.5;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

let seq = 0;
let tempDir = "";
let clock = new FakeClock();

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-gw-router-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  clock = new FakeClock();
  resetLlmRoutingForTests(new SwarmRouter({ clock, store: new FileRouterStore() }));
});

test.afterEach(() => {
  resetLlmRoutingForTests();
  delete process.env.SWARM_LLM_ROUTER;
  rmSync(tempDir, { recursive: true, force: true });
});

function owner(): string {
  return `user-gw-router-${++seq}`;
}

function key(): string {
  return `sk-router-test-${++seq}-secret`;
}

const REQ = {
  model: "claude-x",
  max_tokens: 64,
  messages: [{ role: "user", content: "very private prompt text" }],
};

const OK = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 1 },
};

function provider(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: "openai",
    baseUrl: `https://${id}.example/v1`,
    models: { balanced: `${id}-model` },
    keys: [key()],
    rank: 0,
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Responder = (init: RequestInit) => Response;

function stubFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: Array<{ host: string; auth: string }> = [];
  const counters = new Map<string, number>();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const host = url.hostname.replace(/\.example$/, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ host, auth: headers.authorization ?? headers["x-api-key"] ?? "" });
    const route = routes[host];
    if (!route) return json({ error: { message: "unexpected" } }, 404);
    const n = counters.get(host) ?? 0;
    counters.set(host, n + 1);
    const responder = Array.isArray(route) ? route[Math.min(n, route.length - 1)]! : route;
    return responder(init ?? {});
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function memoryBus() {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    bus: { publish: (_runId: string, e: { type: string; data?: unknown }) => events.push({ type: e.type, data: e.data as Record<string, unknown> }) } as unknown as TelemetryBus,
    events,
    of(type: string) {
      return events.filter((e) => e.type === type).map((e) => e.data);
    },
  };
}

test("route.decision explains the pick and never carries keys or prompts", async () => {
  const u = owner();
  const paid = provider("paid", { rank: 0 });
  const free = provider("free", { rank: 1, isFree: true });
  const t = memoryBus();
  const { fetchImpl, calls } = stubFetch({ free: () => json(OK), paid: () => json(OK) });
  const result = await forwardLlmNonStreaming({ owner: u, providers: [paid, free], body: REQ, fetchImpl, runId: "r1", bus: t.bus });
  // Free-first (default "Prefer free providers" on) beats the paid rank-0 provider.
  assert.equal(result.attempts[0]!.provider, "free");
  assert.deepEqual(calls.map((c) => c.host), ["free"]);
  const [decision] = t.of("route.decision") as Array<{
    chosen: { provider: string; isPaid: boolean };
    candidates: Array<{ provider: string; eligible: boolean; reasons: string[] }>;
  }>;
  assert.equal(decision!.chosen.provider, "free");
  assert.equal(decision!.chosen.isPaid, false);
  assert.deepEqual(decision!.candidates.find((c) => c.provider === "paid")!.reasons, ["free_tier_available"]);
  const serialized = JSON.stringify(t.events) + readFileSync(routerStateFilePath(u), "utf-8");
  for (const secret of [...paid.keys!, ...free.keys!]) assert.ok(!serialized.includes(secret), "key leaked");
  assert.ok(!serialized.includes("very private prompt"), "prompt leaked");
});

test("preferFreeProviders off ranks by the user's order; allowPaidProviders false never uses paid", async () => {
  const u = owner();
  const paid = provider("paid", { rank: 0 });
  const free = provider("free", { rank: 1, isFree: true });
  const { fetchImpl, calls } = stubFetch({ free: () => json(OK), paid: () => json(OK) });
  writeUserSettings(u, { preferFreeProviders: false });
  await forwardLlmNonStreaming({ owner: u, providers: [paid, free], body: REQ, fetchImpl });
  assert.deepEqual(calls.map((c) => c.host), ["paid"]);

  writeUserSettings(u, { preferFreeProviders: true, allowPaidProviders: false });
  const freeDown = stubFetch({ free: () => json({}, 503), paid: () => json(OK) });
  await assert.rejects(
    forwardLlmNonStreaming({ owner: u, providers: [paid, free], body: REQ, fetchImpl: freeDown.fetchImpl }),
    (err: { status: number }) => err.status === 502,
  );
  assert.deepEqual(freeDown.calls.map((c) => c.host), ["free"], "paid provider must never be called");
});

test("a run stays on its provider (sticky) and a failure fails over with route.failover", async () => {
  const u = owner();
  const a = provider("a", { rank: 0 });
  const b = provider("b", { rank: 1 });
  const { fetchImpl } = stubFetch({ a: [() => json(OK), () => json({}, 503)], b: () => json(OK) });
  const t = memoryBus();
  await forwardLlmNonStreaming({ owner: u, providers: [a, b], body: REQ, fetchImpl, runId: "run-s", bus: t.bus });
  // The user now prefers b, but the run keeps a for prompt-cache reuse.
  const reordered = [{ ...a, rank: 1 }, { ...b, rank: 0 }];
  const second = await forwardLlmNonStreaming({ owner: u, providers: reordered, body: REQ, fetchImpl, runId: "run-s", bus: t.bus });
  // a answered 503 on the second call: failover to b within the same request.
  assert.deepEqual(second.attempts.map((x) => `${x.provider}:${x.ok}`), ["a:false", "b:true"]);
  const decisions = t.of("route.decision") as Array<{ chosen: { provider: string; sticky: boolean } }>;
  assert.equal(decisions[1]!.chosen.provider, "a");
  assert.equal(decisions[1]!.chosen.sticky, true);
  const failovers = t.of("route.failover") as Array<{ from: { provider: string }; to: { provider: string }; reason: string }>;
  assert.equal(failovers.length, 1);
  assert.equal(failovers[0]!.from.provider, "a");
  assert.equal(failovers[0]!.to.provider, "b");
  assert.match(failovers[0]!.reason, /already_failed_this_request/);
});

test("429 rotates to the provider's next key, honors Retry-After, then recovers", async () => {
  const u = owner();
  const k1 = key();
  const k2 = key();
  const multi = provider("multi", { keys: [k1, k2] });
  const { fetchImpl, calls } = stubFetch({
    multi: (init) => {
      const auth = (init.headers as Record<string, string>).authorization;
      return auth === `Bearer ${k1}` && clock.now() < Date.parse("2026-11-12T10:00:30.000Z")
        ? json({}, 429, { "retry-after": "30" })
        : json(OK);
    },
  });
  // Key 1 ("key-1#…") wins the tie between two equally healthy keys.
  const first = await forwardLlmNonStreaming({ owner: u, providers: [multi], body: REQ, fetchImpl });
  assert.deepEqual(first.attempts.map((x) => x.ok), [false, true]);
  assert.deepEqual(calls.map((c) => c.auth), [`Bearer ${k1}`, `Bearer ${k2}`]);
  // During the 30s cooldown key 1 is not contacted.
  clock.advance(10_000);
  await forwardLlmNonStreaming({ owner: u, providers: [multi], body: REQ, fetchImpl });
  assert.equal(calls.at(-1)!.auth, `Bearer ${k2}`);
  assert.equal(calls.length, 3);
  // After Retry-After elapses key 1 is back (it wins the tie again).
  clock.advance(25_000);
  const recovered = await forwardLlmNonStreaming({ owner: u, providers: [multi], body: REQ, fetchImpl });
  assert.equal(recovered.attempts.length, 1);
  assert.equal(calls.at(-1)!.auth, `Bearer ${k1}`);
});

test("empty 200 responses emit route.demoted but still reach the agent", async () => {
  const u = owner();
  const empty = { ...OK, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] };
  const { fetchImpl, calls } = stubFetch({ a: () => json(empty), b: () => json(OK) });
  const t = memoryBus();
  const providers = [provider("a"), provider("b", { rank: 1 })];
  const result = await forwardLlmNonStreaming({ owner: u, providers, body: REQ, fetchImpl, runId: "run-q", bus: t.bus });
  assert.equal(result.attempts[0]!.ok, true);
  const demoted = t.of("route.demoted");
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0]!.provider, "a");
  assert.match(String(demoted[0]!.reason), /empty_output/);
  // The next request (another run, so no stickiness) prefers the healthy
  // provider even though "a" ranks first.
  const next = await forwardLlmNonStreaming({ owner: u, providers, body: REQ, fetchImpl, runId: "run-q2" });
  assert.equal(next.attempts[0]!.provider, "b");
  assert.deepEqual(calls.map((c) => c.host), ["a", "b"]);
});

test("streaming: repairs invalid tool JSON in the relay and still observes usage", async () => {
  const u = owner();
  const sse = (chunks: unknown[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          for (const chunk of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const broken = [
    { id: "c1", model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "t1", function: { name: "edit", arguments: '{"path": "a.ts", bro' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
  ];
  const { fetchImpl } = stubFetch({ a: () => sse(broken) });
  const t = memoryBus();
  let out = "";
  for await (const bytes of forwardLlmStreaming({ owner: u, providers: [provider("a")], body: { ...REQ, stream: true }, fetchImpl, runId: "run-st", bus: t.bus })) {
    out += new TextDecoder().decode(bytes);
  }
  // The bridge repairs the unusable fragment instead of relaying broken JSON,
  // so the client receives a parseable tool input and the provider is not
  // demoted for a problem the gateway already fixed.
  assert.match(out, /input_json_delta/);
  assert.match(out, /"partial_json":"\{\}"/);
  const demoted = t.of("route.demoted");
  assert.equal(demoted.length, 0);
  const call = t.of("llm.call")[0]!;
  assert.equal(call.inputTokens, 9);
  assert.equal(call.outputTokens, 4);
});

test("router state survives a restart: a 401'd key stays disabled; 402 shows as a quota cooldown", async () => {
  const u = owner();
  const a = provider("a");
  const b = provider("b", { rank: 1 });
  const { fetchImpl, calls } = stubFetch({ a: () => json({}, 401), b: [() => json({}, 402), () => json(OK)] });
  await assert.rejects(forwardLlmNonStreaming({ owner: u, providers: [a, b], body: REQ, fetchImpl }));
  assert.deepEqual(routerQuotaCooldowns(u, {}, clock.now()), { b: clock.now() + 15 * 60_000 });

  // "Restart": a brand-new router restores this user's state from disk.
  resetLlmRoutingForTests(new SwarmRouter({ clock, store: new FileRouterStore() }));
  await assert.rejects(forwardLlmNonStreaming({ owner: u, providers: [a, b], body: REQ, fetchImpl }));
  assert.equal(calls.length, 2, "neither the 401 key nor the 402 key is contacted after restart");
  clock.advance(15 * 60_000);
  const recovered = await forwardLlmNonStreaming({ owner: u, providers: [a, b], body: REQ, fetchImpl });
  assert.equal(recovered.attempts[0]!.provider, "b");
});

test("falls back to rank order when the router throws, and SWARM_LLM_ROUTER=off disables it", async () => {
  const u = owner();
  const broken = new SwarmRouter({ clock });
  broken.routeAndAcquire = async () => {
    throw new Error("boom");
  };
  resetLlmRoutingForTests(broken);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { fetchImpl } = stubFetch({ a: () => json(OK) });
    const t = memoryBus();
    const result = await forwardLlmNonStreaming({ owner: u, providers: [provider("a")], body: REQ, fetchImpl, runId: "r", bus: t.bus });
    assert.equal(result.attempts[0]!.ok, true);
    assert.equal(t.of("route.decision").length, 0);
  } finally {
    console.warn = warn;
  }

  process.env.SWARM_LLM_ROUTER = "off";
  assert.equal(llmRouterEnabled(), false);
  const { fetchImpl } = stubFetch({ a: () => json(OK) });
  const t = memoryBus();
  await forwardLlmNonStreaming({ owner: owner(), providers: [provider("a")], body: REQ, fetchImpl, runId: "r", bus: t.bus });
  assert.deepEqual(t.events.map((e) => e.type), ["llm.call"]);
});

test("a 400 from the provider is the request's fault: no cooldown, no failover", async () => {
  const u = owner();
  const a = provider("a");
  const { fetchImpl, calls } = stubFetch({ a: [() => json({}, 400), () => json(OK)] });
  await assert.rejects(forwardLlmNonStreaming({ owner: u, providers: [a], body: REQ, fetchImpl }));
  const ok = await forwardLlmNonStreaming({ owner: u, providers: [a], body: REQ, fetchImpl });
  assert.equal(ok.attempts[0]!.ok, true);
  assert.equal(calls.length, 2);
});

test("router state saves use unique temp names under same-millisecond concurrency", async () => {
  const u = owner();
  const store = new FileRouterStore();
  const snapshot: RouterSnapshot = {
    version: 1,
    savedAt: Date.now(),
    keys: {},
    keyModels: {},
    modelHealth: {},
    userUsage: {},
  };
  // Capture the temp paths the atomic write actually uses.
  const tmpNames: string[] = [];
  const realWriteFileSync = fs.writeFileSync;
  (fs as unknown as Record<string, unknown>).writeFileSync = (file: unknown, ...args: unknown[]) => {
    tmpNames.push(String(file));
    return (realWriteFileSync as (...a: unknown[]) => unknown)(file, ...args);
  };
  try {
    // Two saves back to back (very likely the same millisecond): with only
    // pid+ms in the name they would collide on one temp file.
    await store.saveUserSnapshot(u, snapshot);
    await store.saveUserSnapshot(u, snapshot);
    assert.equal(tmpNames.length, 2);
    assert.notEqual(tmpNames[0], tmpNames[1]);
    for (const tmp of tmpNames) {
      assert.match(tmp, /\.tmp\.\d+\.\d+\.[0-9a-f-]{36}$/, `temp name must end in a UUID: ${tmp}`);
    }
    assert.deepEqual(store.loadUserSnapshotSync(u), snapshot);
  } finally {
    (fs as unknown as Record<string, unknown>).writeFileSync = realWriteFileSync;
  }
});
