import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { resetBuckets } from "../../../../lib/rate-limit";

test.beforeEach(() => {
  resetBuckets();
});

const antKey = "sk-test-ant-proxy-alpha";
const oaiKey = "sk-test-oai-proxy-beta";

process.env.SWARM_KEYS_ANTHROPIC = antKey;
process.env.SWARM_KEYS_OPENAI = oaiKey;

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...init.headers },
    },
  );
}

function anthropicOk(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 3, output_tokens: 4 },
    model: "claude-sonnet-4-5",
  };
}

function openaiOk(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 6 },
    model: "gpt-4.1",
  };
}

const userMessage = { role: "user" as const, content: "hello" };

async function postBody(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/providers/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-swarm-user": "local",
      },
      body: JSON.stringify(body),
    }),
  );
}

test("requires a signed-in caller (x-swarm-user)", async () => {
  globalThis.fetch = async () => jsonResponse(anthropicOk("x"));
  const res = await POST(
    new NextRequest("http://localhost/api/providers/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [userMessage] }),
    }),
  );
  assert.equal(res.status, 401);
});

test("validates input: missing messages -> 400", async () => {
  const res = await postBody({});
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /messages/);
});

test("validates input: empty messages -> 400", async () => {
  const res = await postBody({ messages: [] });
  assert.equal(res.status, 400);
});

test("validates input: invalid tier -> 400", async () => {
  const res = await postBody({ messages: [userMessage], tier: "ultra" });
  assert.equal(res.status, 400);
});

test("validates input: bad maxTokens -> 400", async () => {
  const res = await postBody({ messages: [userMessage], maxTokens: 0 });
  assert.equal(res.status, 400);
  const res2 = await postBody({ messages: [userMessage], maxTokens: 99999 });
  assert.equal(res2.status, 400);
});

test("validates input: non-string message content -> 400", async () => {
  const res = await postBody({ messages: [{ role: "user", content: 123 }] });
  assert.equal(res.status, 400);
});

test("validates input: bad message role -> 400", async () => {
  const res = await postBody({ messages: [{ role: "system", content: "x" }] });
  assert.equal(res.status, 400);
});

test("happy path: completes via ranked server-held key, key never in body", async () => {
  globalThis.fetch = ((async (_input: unknown, _init?: unknown) => {
    return jsonResponse(anthropicOk("hello back"));
  }) as unknown as typeof globalThis.fetch);
  const res = await postBody({ messages: [userMessage], tier: "balanced" });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.text, "hello back");
  assert.equal(json.provider, "anthropic");
  assert.equal(json.model, "claude-sonnet-4-5");
  assert.equal(json.usage.inputTokens, 3);
  assert.equal(json.usage.outputTokens, 4);
  assert.equal(typeof json.latencyMs, "number");
  const serialized = JSON.stringify(json);
  assert.equal(serialized.includes(antKey), false);
  assert.equal(serialized.includes(oaiKey), false);
});

test("fails over to the next ranked provider on 500", async () => {
  const calls: string[] = [];
  globalThis.fetch = ((async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    if (url.includes("anthropic")) {
      return jsonResponse({ error: { message: "upstream boom" } }, { status: 500 });
    }
    return jsonResponse(openaiOk("fallback answer"));
  }) as unknown as typeof globalThis.fetch);
  const res = await postBody({ messages: [userMessage] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.provider, "openai");
  assert.equal(json.text, "fallback answer");
  assert.equal(calls.length, 2, "expected one call per provider");
});

test("redacts keys when all providers fail -> 502, no key in body", async () => {
  globalThis.fetch = ((async (_input: unknown) => {
    return jsonResponse(
      { error: { message: `bad credential ${antKey}` } },
      { status: 401 },
    );
  }) as unknown as typeof globalThis.fetch);
  const res = await postBody({ messages: [userMessage] });
  assert.equal(res.status, 502);
  const json = await res.json();
  const serialized = JSON.stringify(json);
  assert.equal(serialized.includes(antKey), false);
  assert.equal(serialized.includes(oaiKey), false);
  assert.match(String(json.error), /all providers failed|redacted/i);
});

test("validates input: non-string system -> 400", async () => {
  const res = await postBody({ messages: [userMessage], system: 42 });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /system must be a string/);
  assert.equal((res.headers.get("cache-control") ?? "").toLowerCase(), "no-store");
});

test("validates input: non-string model -> 400", async () => {
  const res = await postBody({ messages: [userMessage], model: 42 });
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /model must be a non-empty string/);
});

test("validates input: empty or whitespace model -> 400", async () => {
  const empty = await postBody({ messages: [userMessage], model: "" });
  assert.equal(empty.status, 400);
  const blank = await postBody({ messages: [userMessage], model: "   " });
  assert.equal(blank.status, 400);
});

test("a pre-aborted request returns 499 and is uncacheable", async () => {
  globalThis.fetch = ((async () => jsonResponse(anthropicOk("never"))) as unknown as typeof fetch);
  const controller = new AbortController();
  controller.abort();
  const res = await POST(
    new NextRequest("http://localhost/api/providers/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-swarm-user": "local",
      },
      body: JSON.stringify({ messages: [userMessage] }),
      signal: controller.signal,
    }),
  );
  assert.equal(res.status, 499);
  assert.equal((res.headers.get("cache-control") ?? "").toLowerCase(), "no-store");
});

test("per-user completion rate limit trips at 60/min with 429, Retry-After and no-store", async () => {
  // Each invalid body still consumes a token: the check runs before validation.
  for (let i = 0; i < 60; i++) {
    const res = await postBody({});
    assert.equal(res.status, 400, `request ${i + 1} should fail validation, not rate-limit`);
  }
  const limited = await postBody({ messages: [userMessage] });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after") ?? "0") > 0, "expected a Retry-After");
  assert.equal((limited.headers.get("cache-control") ?? "").toLowerCase(), "no-store");

  // The budget is per user: another account is unaffected.
  const other = await POST(
    new NextRequest("http://localhost/api/providers/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-swarm-user": "alice",
      },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(other.status, 400);
});

test("every completion response carries Cache-Control: no-store", async () => {
  const signedOut = await POST(
    new NextRequest("http://localhost/api/providers/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [userMessage] }),
    }),
  );
  assert.equal(signedOut.status, 401);
  assert.equal((signedOut.headers.get("cache-control") ?? "").toLowerCase(), "no-store");

  const tooLarge = await postBody({ messages: [{ role: "user", content: "x".repeat(300_000) }] });
  assert.equal(tooLarge.status, 413);
  assert.equal((tooLarge.headers.get("cache-control") ?? "").toLowerCase(), "no-store");

  globalThis.fetch = ((async () => jsonResponse(anthropicOk("hello back"))) as unknown as typeof fetch);
  const ok = await postBody({ messages: [userMessage], tier: "balanced" });
  assert.equal(ok.status, 200);
  assert.equal((ok.headers.get("cache-control") ?? "").toLowerCase(), "no-store");
});
