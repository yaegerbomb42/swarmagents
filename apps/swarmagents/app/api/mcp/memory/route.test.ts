import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { USER_HEADER } from "../../../../lib/auth";
import { configureProviderStorePaths } from "../../../../lib/providers/store";
import { POST } from "./route";

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";
let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

function rpc(body: unknown, user = ALICE): NextRequest {
  return new NextRequest("http://localhost/api/mcp/memory", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", [USER_HEADER]: user }),
    body: JSON.stringify(body),
  });
}

async function callTool(name: string, args: unknown, user = ALICE): Promise<Record<string, unknown>> {
  const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, user));
  const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError: boolean } };
  const text = body.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

test("tools/list advertises the three memory tools", async () => {
  const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(
    body.result.tools.map((tool) => tool.name),
    ["memory_write", "memory_search", "memory_forget"],
  );
});

test("initialize and ping answer", async () => {
  const init = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }));
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(initBody.result.serverInfo.name, "swarm-memory");

  const ping = await POST(rpc({ jsonrpc: "2.0", id: 2, method: "ping" }));
  assert.equal(ping.status, 200);
});

test("memory_write, memory_search and memory_forget work over MCP", async () => {
  const written = await callTool("memory_write", { fact: "the user prefers pnpm", tags: ["preference"] });
  assert.equal(written.ok, true);
  const id = (written.fact as { id: string }).id;

  const found = await callTool("memory_search", { query: "pnpm" });
  assert.equal(found.ok, true);
  assert.equal((found.memories as unknown[]).length, 1);

  const forgotten = await callTool("memory_forget", { id });
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.forgotten, 1);
});

test("the MCP tools are scoped to the calling account", async () => {
  const written = await callTool("memory_write", { fact: "alice's note" });
  const id = (written.fact as { id: string }).id;

  const bobSearch = await callTool("memory_search", { query: "alice" }, BOB);
  assert.equal(bobSearch.ok, true);
  assert.equal((bobSearch.memories as unknown[]).length, 0);

  const bobForget = await callTool("memory_forget", { id }, BOB);
  assert.equal(bobForget.ok, false);
  assert.equal(bobForget.error, "not_found");
});

test("an unknown tool is rejected", async () => {
  const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_nope" } }));
  const body = (await res.json()) as { result?: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(body.result?.isError, true);
});

test("a malformed request is rejected", async () => {
  const res = await POST(rpc({ jsonrpc: "1.0", id: 1, method: "tools/list" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { error: { code: number } };
  assert.equal(body.error.code, -32600);
});
