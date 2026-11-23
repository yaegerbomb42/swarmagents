/**
 * Round-trip tests for the VM-side web-search MCP server
 * (lib/harness/web-search-mcp-source.ts): the server is spawned for real and
 * talks to a fake host route over loopback HTTP, mirroring
 * codebase-mcp.test.ts conventions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { webSearchMcpServerSource } from "./web-search-mcp-source";

interface Rpc {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

interface FakeHost {
  base: string;
  requests: Array<{ url: string; body: string }>;
  close: () => Promise<void>;
}

/** A loopback stand-in for /api/runtime/web/<runToken>/search. */
async function startFakeHost(
  handler: (req: { url: string; body: string }) => { status: number; body: unknown },
): Promise<FakeHost> {
  const requests: Array<{ url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const record = { url: req.url ?? "", body };
      requests.push(record);
      const out = handler(record);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Spawn the MCP server with the given env and answer the given requests. */
async function ask(requests: unknown[], env: Record<string, string>): Promise<Rpc[]> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-web-mcp-"));
  const serverPath = path.join(home, "web-search-server.mjs");
  fs.writeFileSync(serverPath, webSearchMcpServerSource(), "utf8");

  const child: ChildProcess = spawn("node", [serverPath], {
    env: { ...process.env, HOME: home, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const replies: Rpc[] = [];
  let buffer = "";
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        replies.push(JSON.parse(line) as Rpc);
      } catch {
        // ignore noise
      }
    }
  });

  for (const request of requests) {
    child.stdin?.write(`${JSON.stringify(request)}\n`);
  }
  // Poll for replies instead of a fixed sleep (cold node startup varies).
  const deadline = Date.now() + 8000;
  while (replies.length < requests.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  fs.rmSync(home, { recursive: true, force: true });
  return replies;
}

function payloadOf(reply: Rpc | undefined): any {
  return JSON.parse(reply?.result?.content?.[0]?.text ?? "{}");
}

test("the web-search MCP server lists its tool", async () => {
  const replies = await ask(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
    { SWARM_WEB_SEARCH_URL: "http://127.0.0.1:1/api/runtime/web/tok/search" },
  );
  const list = replies.find((reply) => reply.id === 2);
  const names = (list?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  assert.deepEqual(names, ["web_search"]);
});

test("web_search round-trips through the host route", async () => {
  const host = await startFakeHost(() => ({
    status: 200,
    body: { ok: true, results: [{ title: "Hit", url: "https://h.example", snippet: "snip" }] },
  }));
  try {
    const replies = await ask(
      [
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "node test runner", limit: 3 } },
        },
      ],
      { SWARM_WEB_SEARCH_URL: `${host.base}/api/runtime/web/tok-1/search` },
    );
    const reply = replies.find((item) => item.id === 3);
    const payload = payloadOf(reply);
    assert.equal(reply?.result?.isError, false);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.results, [{ title: "Hit", url: "https://h.example", snippet: "snip" }]);
    assert.equal(host.requests.length, 1);
    assert.equal(host.requests[0].url, "/api/runtime/web/tok-1/search");
    assert.deepEqual(JSON.parse(host.requests[0].body), { query: "node test runner", limit: 3 });
  } finally {
    await host.close();
  }
});

test("the host URL is derived from the LLM-proxy env when no explicit URL is set", async () => {
  const host = await startFakeHost(() => ({ status: 200, body: { ok: true, results: [] } }));
  try {
    const replies = await ask(
      [
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "derived" } },
        },
      ],
      {
        SWARM_WEB_SEARCH_URL: "",
        ANTHROPIC_BASE_URL: `${host.base}/api/runtime/llm/tok-2`,
        ANTHROPIC_AUTH_TOKEN: "tok-2",
        SWARM_APPROVAL_URL: "",
        SWARM_APPROVAL_TOKEN: "",
      },
    );
    const payload = payloadOf(replies.find((item) => item.id === 4));
    assert.equal(payload.ok, true);
    assert.equal(host.requests.length, 1);
    assert.equal(host.requests[0].url, "/api/runtime/web/tok-2/search");
  } finally {
    await host.close();
  }
});

test("a host error becomes a tool error, not a crash", async () => {
  const host = await startFakeHost(() => ({
    status: 503,
    body: { ok: false, error: "Web search is not configured for this account." },
  }));
  try {
    const replies = await ask(
      [
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "anything" } },
        },
      ],
      { SWARM_WEB_SEARCH_URL: `${host.base}/api/runtime/web/tok-3/search` },
    );
    const reply = replies.find((item) => item.id === 5);
    const payload = payloadOf(reply);
    assert.equal(reply?.result?.isError, true);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /not configured/);
  } finally {
    await host.close();
  }
});

test("with no host route env the tool reports unavailable instead of throwing", async () => {
  const replies = await ask(
    [
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "web_search", arguments: { query: "anything" } },
      },
    ],
    {
      SWARM_WEB_SEARCH_URL: "",
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      SWARM_APPROVAL_URL: "",
      SWARM_APPROVAL_TOKEN: "",
    },
  );
  const reply = replies.find((item) => item.id === 6);
  const payload = payloadOf(reply);
  assert.equal(reply?.result?.isError, true);
  assert.match(payload.error, /not available/);
});
