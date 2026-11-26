import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { addInstalledItem, configureLibraryStoreDir } from "../../../../lib/library/user-store";
import { configureProviderStorePaths } from "../../../../lib/providers/store";
import { setVmManagerForTesting, type VmManager } from "../../../../lib/vm/manager";
import { POST } from "./route";

// Private owner: rate-limit buckets are module-global and shared across all
// test files in one `tsx --test` process, so never reset them here.
const OWNER = `probe-route-${process.pid}-${Date.now()}`;
const SECRET = "ghp_supersecretconnectorprobe12345";
let tmpDir = "";
let prevHome: string | undefined;
let prevKeysSecret: string | undefined;
let prevSessionSecret: string | undefined;
let prevServerMode: string | undefined;
let prevFetch: typeof fetch;

function req(body: unknown = { connectorId: "custom-http-1" }, user: string | null = OWNER) {
  const headers = new Headers({ "content-type": "application/json" });
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest("http://localhost/api/connectors/probe", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function httpFetch(bodyFor: (method: string) => string, status = 200) {
  const headers: Record<string, string>[] = [];
  prevFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const payload = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    return new Response(bodyFor(payload.method ?? ""), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return headers;
}

function rpc(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function restoreFetch() {
  globalThis.fetch = prevFetch;
}

interface FakeVm {
  written: string[];
  stdin: string;
  stdout: string;
}

function installFakeVm(stdout: string): FakeVm {
  const fake: FakeVm = { written: [], stdin: "", stdout };
  setVmManagerForTesting({
    async writeFile(_userId: string, _path: string, content: string) {
      fake.written.push(content);
    },
    async exec(_userId: string, _cmd: string[], opts?: { stdin?: string | Buffer; onStdout?: (chunk: string) => void }) {
      fake.stdin = String(opts?.stdin ?? "");
      opts?.onStdout?.(fake.stdout);
      return { exitCode: 0 };
    },
  } as unknown as VmManager);
  return fake;
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-probe-"));
  prevHome = process.env.SWARM_HOME;
  prevKeysSecret = process.env.SWARM_KEYS_SECRET;
  prevSessionSecret = process.env.SWARM_SESSION_SECRET;
  prevServerMode = process.env.SWARM_SERVER_MODE;
  process.env.SWARM_HOME = tmpDir;
  process.env.SWARM_KEYS_SECRET = "k".repeat(40);
  process.env.SWARM_SESSION_SECRET = "s".repeat(40);
  delete process.env.SWARM_SERVER_MODE;
  configureProviderStorePaths(path.join(tmpDir, "providers.json"));
  configureLibraryStoreDir(tmpDir);
  setVmManagerForTesting(null);
});

test.afterEach(() => {
  setVmManagerForTesting(null);
  configureProviderStorePaths("");
  configureLibraryStoreDir(undefined);
  if (prevHome === undefined) delete process.env.SWARM_HOME;
  else process.env.SWARM_HOME = prevHome;
  if (prevKeysSecret === undefined) delete process.env.SWARM_KEYS_SECRET;
  else process.env.SWARM_KEYS_SECRET = prevKeysSecret;
  if (prevSessionSecret === undefined) delete process.env.SWARM_SESSION_SECRET;
  else process.env.SWARM_SESSION_SECRET = prevSessionSecret;
  if (prevServerMode === undefined) delete process.env.SWARM_SERVER_MODE;
  else process.env.SWARM_SERVER_MODE = prevServerMode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("probe requires auth and sends Cache-Control: no-store on every branch", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  const unauth = await POST(req({}, null));
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get("cache-control"), "no-store");

  const invalid = await POST(req({ connectorId: "  " }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("cache-control"), "no-store");

  const missing = await POST(req({ connectorId: "not-installed" }));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("custom agent-authored HTTP MCP is probed with server-side secrets only", async () => {
  addInstalledItem(OWNER, {
    id: "custom-http-1",
    kind: "mcp",
    name: "Probe MCP",
    description: "test",
    origin: "agent",
    payload: {
      kind: "mcp",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      requiredFields: [{ key: "Authorization", label: "Token" }],
    },
    secrets: { Authorization: `Bearer ${SECRET}` },
  });
  const seen = httpFetch((method) =>
    method === "initialize"
      ? rpc(1, { protocolVersion: "2024-11-05" })
      : rpc(2, { tools: [{ name: "search", description: "Search things" }] }),
  );
  try {
    const res = await POST(req());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    const body = JSON.parse(text) as {
      probe: { ok: boolean; latencyMs: number; tools: Array<{ name: string; description: string }> };
    };
    assert.equal(body.probe.ok, true);
    assert.equal(typeof body.probe.latencyMs, "number");
    assert.deepEqual(body.probe.tools, [{ name: "search", description: "Search things" }]);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].Authorization, `Bearer ${SECRET}`);
    assert.equal(text.includes(SECRET), false);
  } finally {
    restoreFetch();
  }
});

test("upstream errors never echo secret material", async () => {
  addInstalledItem(OWNER, {
    id: "custom-http-1",
    kind: "mcp",
    name: "Leaky MCP",
    description: "test",
    payload: {
      kind: "mcp",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      requiredFields: [{ key: "Authorization", label: "Token" }],
    },
    secrets: { Authorization: SECRET },
  });
  httpFetch(() => `failure with ${SECRET}`, 503);
  try {
    const res = await POST(req());
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(text.includes(SECRET), false);
    assert.match(text, /HTTP 503/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    restoreFetch();
  }
});

test("catalog connector IDs resolve to the installed library item for that account only", async () => {
  addInstalledItem(OWNER, {
    id: "connector-exa",
    kind: "connector",
    name: "Exa",
    description: "test",
    payload: {
      kind: "connector",
      transport: "http",
      url: "https://mcp.example.test/exa",
      requiredFields: [],
    },
  });
  httpFetch((method) =>
    method === "initialize" ? rpc(1, {}) : rpc(2, { tools: [{ name: "exa_search" }] }),
  );
  try {
    const alice = await POST(req({ connectorId: "exa" }));
    assert.equal(alice.status, 200);
    const body = (await alice.json()) as { probe: { ok: boolean; tools: Array<{ name: string }> } };
    assert.equal(body.probe.ok, true);
    assert.deepEqual(body.probe.tools, [{ name: "exa_search", description: "" }]);

    const bob = await POST(req({ connectorId: "exa" }, `${OWNER}-other`));
    assert.equal(bob.status, 404);
  } finally {
    restoreFetch();
  }
});

test("custom stdio MCP is probed inside the VM without leaking env secrets", async () => {
  addInstalledItem(OWNER, {
    id: "custom-stdio-1",
    kind: "mcp",
    name: "Local MCP",
    description: "test",
    origin: "agent",
    payload: {
      kind: "mcp",
      transport: "stdio",
      command: "node",
      args: ["/workspace/.swarm/custom.mjs"],
      requiredFields: [{ key: "API_KEY", label: "Key" }],
    },
    secrets: { API_KEY: SECRET },
  });
  const vm = installFakeVm(
    JSON.stringify({ ok: true, tools: [{ name: "local_tool", description: "From the VM" }] }) + "\n",
  );
  const res = await POST(req({ connectorId: "custom-stdio-1" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { probe: { ok: boolean; tools: Array<{ name: string }> } };
  assert.equal(body.probe.ok, true);
  assert.deepEqual(body.probe.tools, [{ name: "local_tool", description: "From the VM" }]);
  assert.equal(vm.written.length, 1);
  const config = JSON.parse(vm.stdin) as { command: string; env: Record<string, string> };
  assert.equal(config.env.API_KEY, SECRET);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
});

test("rate limits repeated probes", async () => {
  const limitedOwner = `${OWNER}-limit`;
  for (let i = 0; i < 30; i += 1) {
    const res = await POST(req({ connectorId: "not-installed" }, limitedOwner));
    assert.equal(res.status, 404);
  }
  const limited = await POST(req({ connectorId: "not-installed" }, limitedOwner));
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal(limited.headers.get("cache-control"), "no-store");
});
