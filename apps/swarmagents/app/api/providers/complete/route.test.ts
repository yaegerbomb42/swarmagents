import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";

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
