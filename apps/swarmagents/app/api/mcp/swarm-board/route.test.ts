import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { configureStorePaths, getStoragePaths, loadStore } from "@/lib/board/store";
import { RuntimeManager, setRuntimeManagerForTesting } from "@/lib/runtime/manager";
import { FakeVmDriver } from "@/lib/vm/fake-driver";
import { VmManager, setVmManagerForTesting } from "@/lib/vm/manager";
import type { ExecOptions, ExecResult, VmHandle } from "@/lib/vm/types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-board-route-"));
}

function seed(dataFile: string): void {
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      tasks: [
        {
          id: "task_1",
          title: "Survive an I/O blip",
          description: "D",
          difficulty: "easy",
          constraints: [],
          status: "open",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      proposals: [],
      messages: [],
    }),
    "utf-8",
  );
}

function request(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

function rpc(method: string, params?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mcp/swarm-board", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, ...(params ? { params } : {}) }),
  });
}

test("GET returns the board when storage is healthy", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  seed(dataFile);
  configureStorePaths(dir, dataFile);
  try {
    const res = await GET(request("/api/mcp/swarm-board"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { counts?: { tasks?: number }; tasks?: unknown[] };
    assert.equal(body.counts?.tasks, 1);
    assert.equal(body.tasks?.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET returns a retryable 503 instead of an empty board when the file cannot be read", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  // A directory at the data-file path makes readFileSync fail with EISDIR,
  // which works under root too (no permission-bit skip needed).
  fs.mkdirSync(dataFile);
  configureStorePaths(dir, dataFile);
  try {
    const res = await GET(request("/api/mcp/swarm-board"));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "2");
    const body = (await res.json()) as {
      code?: string;
      retryable?: boolean;
      counts?: unknown;
      tasks?: unknown;
    };
    assert.equal(body.code, "BOARD_UNAVAILABLE");
    assert.equal(body.retryable, true);
    // Crucially: no empty task list that a worker could read as "no work".
    assert.equal(body.tasks, undefined);
    assert.equal(body.counts, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST poll_tasks returns a retryable error when the board is unavailable", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  fs.mkdirSync(dataFile);
  configureStorePaths(dir, dataFile);
  try {
    const res = await POST(rpc("tools/call", { name: "poll_tasks", arguments: { status: "open" } }));
    assert.equal(res.status, 503);
    const body = (await res.json()) as {
      error?: { code?: number; data?: { retryable?: boolean } };
      result?: unknown;
      id?: unknown;
    };
    assert.equal(body.error?.code, -32001);
    assert.equal(body.error?.data?.retryable, true);
    assert.equal(body.result, undefined);
    assert.equal(body.id, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST create_task does not fake success when the board is unavailable", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  fs.mkdirSync(dataFile);
  configureStorePaths(dir, dataFile);
  try {
    const res = await POST(
      rpc("tools/call", {
        name: "create_task",
        arguments: { title: "T", description: "D", difficulty: "easy" },
      }),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: { code?: number }; result?: unknown };
    assert.equal(body.error?.code, -32001);
    assert.equal(body.result, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST poll_tasks still works when storage is healthy", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  seed(dataFile);
  configureStorePaths(dir, dataFile);
  try {
    const res = await POST(rpc("tools/call", { name: "poll_tasks", arguments: { status: "open" } }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { count?: number };
    assert.equal(payload.count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET exposes per-agent stats computed from task state and rejections", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  seed(dataFile);
  const raw = JSON.parse(fs.readFileSync(dataFile, "utf-8")) as { tasks: Array<Record<string, unknown>> };
  raw.tasks.push(
    {
      id: "task_2",
      title: "In review",
      description: "D",
      difficulty: "easy",
      constraints: [],
      status: "in_review",
      claimedBy: "Worker-1",
      rejections: ["Worker-1"],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "task_3",
      title: "Claimed again",
      description: "D",
      difficulty: "easy",
      constraints: [],
      status: "claimed",
      claimedBy: "Worker-1",
      createdAt: 1,
      updatedAt: Date.now(),
    },
  );
  fs.writeFileSync(dataFile, JSON.stringify(raw), "utf-8");
  configureStorePaths(dir, dataFile);
  try {
    const res = await GET(request("/api/mcp/swarm-board"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      agents?: Record<string, { claimed?: number; inReview?: number; completed?: number; rejected?: number }>;
    };
    assert.deepEqual(body.agents?.["Worker-1"], { claimed: 1, inReview: 1, completed: 0, rejected: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST with a JSON null body is an Invalid Request (-32600), not a 500", async () => {
  const res = await POST(
    new NextRequest("http://localhost/api/mcp/swarm-board", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { error?: { code?: number; message?: string } };
  assert.equal(body.error?.code, -32600);
  assert.match(body.error?.message ?? "", /Invalid Request/);
});

test("GET sets Cache-Control: no-store so task counts are not cached by proxies", async () => {
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  seed(dataFile);
  configureStorePaths(dir, dataFile);
  try {
    const res = await GET(request("/api/mcp/swarm-board"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST tools/call with array params returns -32602 Invalid params", async () => {
  const res = await POST(rpc("tools/call", [{ name: "poll_tasks", arguments: { status: "open" } }]));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { error?: { code?: number }; result?: unknown };
  assert.equal(body.error?.code, -32602);
  assert.equal(body.result, undefined);
});

test("POST tools/call with primitive params returns -32602 Invalid params", async () => {
  const res = await POST(rpc("tools/call", "not-an-object"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { error?: { code?: number }; result?: unknown };
  assert.equal(body.error?.code, -32602);
  assert.equal(body.result, undefined);
});

test("POST tools/call with an invalid id type returns -32602 Invalid params", async () => {
  const res = await POST(
    new NextRequest("http://localhost/api/mcp/swarm-board", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: { bad: true },
        method: "tools/call",
        params: { name: "poll_tasks", arguments: { status: "open" } },
      }),
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { error?: { code?: number }; result?: unknown };
  assert.equal(body.error?.code, -32602);
  assert.equal(body.result, undefined);
});


function rawRpc(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mcp/swarm-board", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("RPC distinguishes invalid envelopes, invalid tool params, and unknown methods", async () => {
  const cases: Array<[body: unknown, code: number, id: unknown]> = [
    [{ jsonrpc: "2.0", id: 0 }, -32600, 0],
    [{ jsonrpc: "2.0", id: "client", method: 1 }, -32600, "client"],
    [{ jsonrpc: "2.0", id: { bad: true }, method: "ping" }, -32600, null],
    [{ jsonrpc: "1.0", id: [7], method: "ping" }, -32600, null],
    [{ jsonrpc: "2.0", id: "bad-params", method: "ping", params: null }, -32602, "bad-params"],
    [{ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} }, -32602, 4],
    [{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "poll_tasks", arguments: [] } }, -32602, 5],
    [{ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "poll_tasks", arguments: false } }, -32602, 6],
    [{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "poll_tasks", arguments: null } }, -32602, 7],
    [{ jsonrpc: "2.0", id: 8, method: "missing" }, -32601, 8],
  ];
  for (const [input, code, id] of cases) {
    const res = await POST(rawRpc(input));
    const body = await res.json();
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, code, JSON.stringify(input));
    assert.equal(body.id, id);
    assert.equal("result" in body, false);
  }
});

test("RPC notifications return no body and explicit null remains a request id", async () => {
  const notification = await POST(rawRpc({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  assert.equal(notification.headers.get("cache-control"), "no-store");

  const pingNotification = await POST(rawRpc({ jsonrpc: "2.0", method: "ping" }));
  assert.equal(pingNotification.status, 202);
  assert.equal(await pingNotification.text(), "");

  // Non-allowlisted notification method without id returns -32600 Invalid Request
  const disallowedNotification = await POST(rawRpc({ jsonrpc: "2.0", method: "tools/call", params: { name: "poll_tasks" } }));
  assert.equal(disallowedNotification.status, 200);
  const disallowedBody = await disallowedNotification.json();
  assert.equal(disallowedBody.error.code, -32600);

  const reply = await POST(rawRpc({ jsonrpc: "2.0", method: "ping", id: null }));
  assert.deepEqual(await reply.json(), { jsonrpc: "2.0", id: null, result: {} });
});

test("RPC body limit measures bytes, not character count", async () => {
  const res = await POST(rawRpc({ jsonrpc: "2.0", method: "ping", id: 7, params: { text: "é".repeat(140_000) } }));
  const body = await res.json();
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /body too large/);
});

test("workers see the same lease deadline in GET/poll and can reclaim it exactly once", async (t) => {
  const { STORAGE_DIR, DATA_FILE } = getStoragePaths();
  const ttl = process.env.SWARM_BOARD_CLAIM_TTL_MS;
  process.env.SWARM_BOARD_CLAIM_TTL_MS = "1000";
  const dir = tmpDir();
  const dataFile = path.join(dir, "swarm_board.json");
  t.after(() => {
    if (ttl === undefined) delete process.env.SWARM_BOARD_CLAIM_TTL_MS;
    else process.env.SWARM_BOARD_CLAIM_TTL_MS = ttl;
    configureStorePaths(STORAGE_DIR, DATA_FILE);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  seed(dataFile);
  configureStorePaths(dir, dataFile);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const tool = (name: string, args: Record<string, unknown>) => POST(rpc("tools/call", { name, arguments: args }));
  const claim = (agentName: string) => tool("claim_task", { taskId: "task_1", agentName });
  const expiredSubmit = () => tool("submit_task_work", {
    taskId: "task_1", agentName: "old-worker", gitBranch: "feat/late", summary: "Late work",
  });
  assert.ok((await (await claim("old-worker")).json()).result);
  now = 1999;
  assert.equal((await (await claim("other-worker")).json()).error.code, -32602);
  now = 2000;
  const open = await (await GET(request("/api/mcp/swarm-board?status=open"))).json();
  assert.equal(open.counts.open, 1);
  assert.equal(open.counts.claimed, 0);
  const reopened = open.tasks[0];
  assert.equal(reopened.status, "open");
  assert.equal(reopened.claimedBy, undefined);
  const expiryEvent = { from: "claimed", to: "open", actor: "swarm-board", at: 2000 };
  assert.deepEqual(reopened.history.at(-1), expiryEvent);
  const polled = await (await tool("poll_tasks", {})).json();
  assert.deepEqual(JSON.parse(polled.result.content[0].text).tasks[0].history, reopened.history);
  assert.equal(loadStore().tasks[0].status, "claimed", "a read-only poll does not write storage");
  assert.match((await (await expiredSubmit()).json()).error.message, /claim expired/i);

  now = 2500;
  const competing = await Promise.all([claim("worker-a"), claim("worker-b")]);
  const results = await Promise.all(competing.map((response) => response.json()));
  assert.equal(results.filter((body) => body.result).length, 1);
  assert.equal(results.filter((body) => body.error?.code === -32602).length, 1);
  const [saved] = loadStore().tasks;
  assert.deepEqual(saved.history?.slice(1), [expiryEvent, { from: "open", to: "claimed", actor: saved.claimedBy, at: 2500 }]);
  assert.match((await (await expiredSubmit()).json()).error.message, /only the claiming agent/);
});

class RouteVmDriver extends FakeVmDriver {
  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "scrot") {
      const target = cmd[cmd.length - 1];
      await this.writeFile(handle, target, `frame-${handle.userId}`);
      return { exitCode: 0 };
    }
    if (cmd[0] === "bash" && cmd[1] === "-lc" && cmd[2] === "pwd-echo") {
      opts?.onStdout?.(`out:${handle.userId}`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

function userRpc(method: string, params: unknown, user: string | null): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest("http://localhost/api/mcp/swarm-board", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test("swarm-board MCP advertises and executes per-user VM tools with auth and isolation", async (t) => {
  const driver = new RouteVmDriver();
  const vm = new VmManager({ customDriver: driver });
  const runtime = new RuntimeManager({ router: null, vm });
  setVmManagerForTesting(vm);
  setRuntimeManagerForTesting(runtime);
  const prevSecret = process.env.SWARM_SESSION_SECRET;
  const prevServerMode = process.env.SWARM_SERVER_MODE;
  t.after(() => {
    setVmManagerForTesting(null);
    setRuntimeManagerForTesting(null);
    if (prevSecret === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = prevSecret;
    if (prevServerMode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = prevServerMode;
  });

  // 1. tools/list advertises all 6 VM tools alongside board tools
  const listRes = await POST(rpc("tools/list", {}));
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  const toolNames = (listBody.result.tools as Array<{ name: string }>).map((entry) => entry.name);
  for (const name of [
    "vm_exec",
    "vm_read_output",
    "vm_read_file",
    "vm_write_file",
    "vm_list_workspace",
    "vm_screenshot",
  ]) {
    assert.ok(toolNames.includes(name), `tools/list missing ${name}`);
  }

  // 2. serverMode() refuses unauthenticated VM tool calls with 401 + no-store
  process.env.SWARM_SESSION_SECRET = "route-test-secret-01234567890123456789";
  process.env.SWARM_SERVER_MODE = "1";
  const unauth = await POST(
    userRpc("tools/call", { name: "vm_list_workspace", arguments: {} }, null),
  );
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get("cache-control"), "no-store");

  // 3. Invalid arguments return JSON-RPC -32602
  const invalid = await POST(
    userRpc("tools/call", { name: "vm_read_file", arguments: {} }, "alice"),
  );
  assert.equal((await invalid.json()).error.code, -32602);

  // 4. Write, list, read, exec, read_output, screenshot scoped to Alice and hidden from Bob
  const writeRes = await (
    await POST(
      userRpc(
        "tools/call",
        { name: "vm_write_file", arguments: { path: "app.txt", content: "alice-data" } },
        "alice",
      ),
    )
  ).json();
  assert.equal(writeRes.result.isError, false);

  const bobRead = await (
    await POST(
      userRpc("tools/call", { name: "vm_read_file", arguments: { path: "/workspace/app.txt" } }, "bob"),
    )
  ).json();
  assert.equal(bobRead.result.isError, true);

  const listAlice = await (
    await POST(userRpc("tools/call", { name: "vm_list_workspace", arguments: {} }, "alice"))
  ).json();
  assert.equal(listAlice.result.isError, false);
  const parsedList = JSON.parse(listAlice.result.content[0].text);
  assert.equal(parsedList.entries[0].name, "app.txt");

  const execAlice = await (
    await POST(
      userRpc("tools/call", { name: "vm_exec", arguments: { cmd: "pwd-echo", waitMs: 2000 } }, "alice"),
    )
  ).json();
  assert.equal(execAlice.result.isError, false);
  const execData = JSON.parse(execAlice.result.content[0].text);
  assert.equal(execData.stdout, "out:alice");

  const bobReadRun = await (
    await POST(
      userRpc("tools/call", { name: "vm_read_output", arguments: { runId: execData.runId } }, "bob"),
    )
  ).json();
  assert.equal(bobReadRun.result.isError, true);
  assert.equal(JSON.parse(bobReadRun.result.content[0].text).error, "scope_denied");

  const shotAlice = await (
    await POST(userRpc("tools/call", { name: "vm_screenshot", arguments: {} }, "alice"))
  ).json();
  assert.equal(shotAlice.result.isError, false);
  assert.equal(shotAlice.result.content[1].type, "image");
  assert.equal(shotAlice.result.content[1].mimeType, "image/png");
  assert.equal(
    Buffer.from(shotAlice.result.content[1].data, "base64").toString("utf8"),
    "frame-alice",
  );
});

