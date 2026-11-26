import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTOR_PROBE_SCRIPT,
  CONNECTOR_PROBE_SCRIPT_PATH,
  buildProbeTarget,
  probeConnectorHealth,
  type ConnectorProbeVm,
} from "./health-probe";

const SECRET = "super-secret-probe-token-12345";

function rpcResult(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function httpFetch(bodyFor: (method: string) => string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const payload = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    return jsonResponse(bodyFor(payload.method ?? ""));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface FakeVm extends ConnectorProbeVm {
  written: Array<{ userId: string; path: string; content: string }>;
  executed: Array<{ userId: string; cmd: string[]; stdin: string; timeoutMs?: number }>;
  stdout: string;
  fails: boolean;
}

function fakeVm(stdout = ""): FakeVm {
  const written: FakeVm["written"] = [];
  const executed: FakeVm["executed"] = [];
  return {
    written,
    executed,
    stdout,
    fails: false,
    async writeFile(userId, path, content) {
      written.push({ userId, path, content });
    },
    async exec(userId, cmd, opts) {
      executed.push({
        userId,
        cmd,
        stdin: String(opts?.stdin ?? ""),
        timeoutMs: opts?.timeoutMs,
      });
      if (this.fails) throw new Error("vm is down");
      opts?.onStdout?.(this.stdout);
      return { exitCode: 0 };
    },
  };
}

test("HTTP probe performs initialize + tools/list and keeps the secret server-side", async () => {
  const { fetchImpl, calls } = httpFetch((method) =>
    method === "initialize"
      ? rpcResult(1, { protocolVersion: "2024-11-05" })
      : rpcResult(2, {
          tools: [
            { name: "search_web", description: "Search the web" },
            { name: "read_page", description: "Read one page" },
          ],
        }),
  );

  const result = await probeConnectorHealth(
    {
      transport: "http",
      url: "https://mcp.example.test/v1/mcp",
      headers: { Authorization: `Bearer ${SECRET}` },
    },
    { fetchImpl, now: () => 100 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.latencyMs, 0);
  assert.deepEqual(result.tools, [
    { name: "search_web", description: "Search the web" },
    { name: "read_page", description: "Read one page" },
  ]);
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 2);
  const bodies = calls.map((call) => JSON.parse(String(call.init.body)) as { method: string });
  assert.deepEqual(
    bodies.map((body) => body.method),
    ["initialize", "tools/list"],
  );
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("SSE-framed JSON-RPC replies are parsed", async () => {
  const { fetchImpl } = httpFetch((method) =>
    method === "initialize"
      ? `event: message\ndata: ${rpcResult(1, { protocolVersion: "2024-11-05" })}\n\n`
      : `data: ${rpcResult(2, { tools: [{ name: "ping", description: "Ping" }] })}\n\n`,
  );
  const result = await probeConnectorHealth(
    { transport: "sse", url: "https://mcp.example.test/sse" },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.tools, [{ name: "ping", description: "Ping" }]);
});

test("unsafe endpoint URLs are rejected before any network call", async () => {
  const { fetchImpl, calls } = httpFetch(() => rpcResult(1, {}));
  const result = await probeConnectorHealth(
    { transport: "http", url: "http://169.254.169.254/latest/meta-data" },
    { fetchImpl },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /safety validation/i);
  assert.equal(calls.length, 0);

  const previous = process.env.SWARM_SERVER_MODE;
  process.env.SWARM_SERVER_MODE = "1";
  try {
    const privateResult = await probeConnectorHealth(
      { transport: "http", url: "http://127.0.0.1:3777/mcp" },
      { fetchImpl },
    );
    assert.equal(privateResult.ok, false);
    assert.equal(calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = previous;
  }
});

test("HTTP errors and tools/list failures return generic, redacted messages", async () => {
  const failing = (async () => jsonResponse(`failure leaked ${SECRET}`, 503)) as unknown as typeof fetch;
  const httpError = await probeConnectorHealth(
    { transport: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: SECRET } },
    { fetchImpl: failing },
  );
  assert.equal(httpError.ok, false);
  assert.equal(httpError.error, "Endpoint returned HTTP 503.");
  assert.equal(JSON.stringify(httpError).includes(SECRET), false);

  const { fetchImpl } = httpFetch((method) =>
    method === "initialize"
      ? rpcResult(1, {})
      : JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: SECRET } }),
  );
  const listError = await probeConnectorHealth(
    { transport: "http", url: "https://mcp.example.test/mcp" },
    { fetchImpl },
  );
  assert.equal(listError.ok, false);
  assert.equal(listError.error, "MCP tools/list failed.");
  assert.equal(JSON.stringify(listError).includes(SECRET), false);
});

test("a hanging endpoint is bounded by the timeout", async () => {
  const hanging = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const started = Date.now();
  const result = await probeConnectorHealth(
    { transport: "http", url: "https://mcp.example.test/mcp" },
    { fetchImpl: hanging, timeoutMs: 40 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out after 40 ms/i);
  assert.deepEqual(result.tools, []);
  assert.ok(Date.now() - started < 1_000, "probe returned promptly");
});

test("stdio probe runs the JSON-RPC client inside the VM with secrets on stdin only", async () => {
  // exec() captures the probe script's stdout: one JSON result line, not the
  // child MCP server's JSON-RPC frames.
  const vm = fakeVm(
    JSON.stringify({ ok: true, tools: [{ name: "local_tool", description: "Runs in VM" }] }) + "\n",
  );
  const result = await probeConnectorHealth(
    {
      transport: "stdio",
      command: "node",
      args: ["/workspace/.swarm/custom.mjs"],
      env: { API_KEY: SECRET },
    },
    { vm, userId: "alice", timeoutMs: 1_000 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.tools, [{ name: "local_tool", description: "Runs in VM" }]);
  assert.equal(vm.written.length, 1);
  assert.equal(vm.written[0].path, CONNECTOR_PROBE_SCRIPT_PATH);
  assert.equal(vm.written[0].userId, "alice");
  assert.match(CONNECTOR_PROBE_SCRIPT, /initialize/);
  assert.match(CONNECTOR_PROBE_SCRIPT, /tools\/list/);
  assert.deepEqual(vm.executed[0].cmd, ["node", CONNECTOR_PROBE_SCRIPT_PATH]);
  const config = JSON.parse(vm.executed[0].stdin) as { command: string; env: Record<string, string> };
  assert.equal(config.command, "node");
  assert.equal(config.env.API_KEY, SECRET);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("stdio probe redacts secrets echoed in an in-VM error and survives a dead VM", async () => {
  const vm = fakeVm(JSON.stringify({ ok: false, tools: [], error: `bad key ${SECRET}` }) + "\n");
  const result = await probeConnectorHealth(
    { transport: "stdio", command: "node", env: { API_KEY: SECRET } },
    { vm },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /REDACTED/);
  assert.equal(JSON.stringify(result).includes(SECRET), false);

  const dead = fakeVm();
  dead.fails = true;
  const deadResult = await probeConnectorHealth(
    { transport: "stdio", command: "node" },
    { vm: dead },
  );
  assert.equal(deadResult.ok, false);
  assert.equal(deadResult.error, "Virtual machine is unavailable.");
});

test("buildProbeTarget keeps only declared secrets and expands args as data", () => {
  const httpTarget = buildProbeTarget(
    {
      kind: "connector",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      requiredFields: [{ key: "Authorization", label: "Token" }],
    },
    { Authorization: `Bearer ${SECRET}`, EXTRA: "must-not-be-forwarded" },
  );
  assert.deepEqual(httpTarget, {
    transport: "http",
    url: "https://mcp.example.test/mcp",
    headers: { Authorization: `Bearer ${SECRET}` },
  });

  const stdioTarget = buildProbeTarget(
    {
      kind: "mcp",
      transport: "stdio",
      command: "node",
      args: ["server.mjs", "--token", "$API_KEY", "${OTHER}"],
      requiredFields: [
        { key: "API_KEY", label: "Key" },
        { key: "OTHER", label: "Other" },
      ],
    },
    { API_KEY: SECRET, OTHER: "second-value" },
  );
  assert.deepEqual(stdioTarget, {
    transport: "stdio",
    command: "node",
    args: ["server.mjs", "--token", SECRET, "second-value"],
    env: { API_KEY: SECRET, OTHER: "second-value" },
  });
});
