import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_MCP_SERVER_NAME,
  MEMORY_MCP_SERVER_PATH,
  MEMORY_MCP_SERVER_SOURCE,
  isMemoryTool,
  memoryMcpServerEntry,
} from "./memory-mcp";
import { roleAllowedTools, roleMcpConfigJson, roleSeedFiles } from "./role-mcp";
import { BUILTIN_ROLES } from "../roles";
import type { RolePhase } from "./types";

/** The request envelopes the in-VM server wrote (the directory may not exist yet). */
function listRequests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("req-"));
}

test("the memory server is wired into the run's MCP config", () => {
  const phase: RolePhase = {
    roleId: "main-agent",
    roleName: "Main Agent",
    allowedTools: ["Read"],
    mcpConfigPath: "/workspace/.swarm/mcp.json",
  };
  const config = JSON.parse(
    roleMcpConfigJson(phase, { allowedRoleIds: new Set(["main-agent"]) }),
  ) as { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
  const memory = config.mcpServers[MEMORY_MCP_SERVER_NAME];
  assert.ok(memory, "the memory MCP server is missing from the run config");
  assert.equal(memory.type, "stdio");
  assert.equal(memory.command, "node");
  assert.deepEqual(memory.args, [MEMORY_MCP_SERVER_PATH]);
});

test("the memory tools are always allowed", () => {
  const role = BUILTIN_ROLES[0];
  const tools = roleAllowedTools(role);
  assert.ok(tools.includes("mcp__memory__*"), "the memory tools are not allowed for the agent");
});

test("the memory server script is seeded into the VM", () => {
  const files = roleSeedFiles(BUILTIN_ROLES, new Set(["main-agent"]));
  const server = files.find((file) => file.path === MEMORY_MCP_SERVER_PATH);
  assert.ok(server, "the memory server script is not seeded");
  assert.match(server.content, /memory_write/);
  assert.match(server.content, /memory_search/);
  assert.match(server.content, /memory_forget/);
});

test("the memory tool names are recognized", () => {
  assert.equal(isMemoryTool("memory_write"), true);
  assert.equal(isMemoryTool("mcp__memory__memory_search"), true);
  assert.equal(isMemoryTool("Bash"), false);
});

test("the MCP server entry carries the RPC directory", () => {
  const entry = memoryMcpServerEntry({ dir: "/tmp/swarm-memory" }) as {
    env: Record<string, string>;
  };
  assert.equal(entry.env.SWARM_MEMORY_DIR, "/tmp/swarm-memory");
});

interface MemoryServer {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  send: (message: unknown) => void;
}

const POLL_MS = 20;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spawn the generated server with a collecting stdout and a JSON-lines send helper. */
function startServer(dir: string, rpcDir = join(dir, "rpc"), env: Record<string, string> = {}): MemoryServer {
  const script = join(dir, "memory-server.mjs");
  writeFileSync(script, MEMORY_MCP_SERVER_SOURCE, "utf8");
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, SWARM_MEMORY_DIR: rpcDir, SWARM_MEMORY_POLL_MS: String(POLL_MS), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) lines.push(line);
      newline = buffer.indexOf("\n");
    }
  });
  return { child, lines, send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`) };
}

async function waitForRequest(rpcDir: string): Promise<{ raw: Record<string, unknown>; id: string } | null> {
  for (let i = 0; i < 100; i++) {
    await wait(POLL_MS);
    const files = listRequests(rpcDir);
    if (!files.length) continue;
    const raw = JSON.parse(readFileSync(join(rpcDir, files[0]), "utf8")) as Record<string, unknown>;
    return { raw, id: files[0].replace(/^req-/, "").replace(/\.json$/, "") };
  }
  return null;
}

function answer(rpcDir: string, id: string, payload: unknown): void {
  writeFileSync(join(rpcDir, `res-${id}.json`), JSON.stringify(payload), "utf8");
}

async function waitForLines(lines: string[], count: number): Promise<void> {
  for (let i = 0; i < 100 && lines.length < count; i++) await wait(POLL_MS);
}

test("the in-VM server answers initialize, tools/list and tools/call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  const rpcDir = join(dir, "rpc");
  const server = startServer(dir, rpcDir);
  try {
    server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    server.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_write", arguments: { fact: "the user prefers pnpm" } },
    });

    // The server writes one request envelope and waits for the host's answer.
    const request = await waitForRequest(rpcDir);
    assert.ok(request, "the in-VM server never asked the host");
    assert.equal(request.raw.tool, "memory_write");
    assert.deepEqual(request.raw.args, { fact: "the user prefers pnpm" });
    answer(rpcDir, request.id, { ok: true, message: "stored the user prefers pnpm" });

    await waitForLines(server.lines, 3);
    const answers = server.lines.map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
    assert.ok(answers.find((answer) => answer.id === 1), "no initialize answer");
    const list = answers.find((answer) => answer.id === 2);
    const tools = (list?.result?.tools ?? []) as Array<{ name: string }>;
    assert.deepEqual(tools.map((tool) => tool.name), ["memory_write", "memory_search", "memory_forget"]);
    const call = answers.find((answer) => answer.id === 3);
    const content = (call?.result?.content ?? []) as Array<{ text: string }>;
    assert.match(content[0]?.text ?? "", /"ok":true/);
  } finally {
    server.child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-VM server scrubs secrets before the fact leaves the VM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  const rpcDir = join(dir, "rpc");
  const server = startServer(dir, rpcDir);
  const secret = "sk-test-0123456789abcdefghij";
  try {
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_write", arguments: { fact: `the key is ${secret}` } },
    });
    const request = await waitForRequest(rpcDir);
    assert.ok(request, "the in-VM server never asked the host");
    const args = request.raw.args as { fact?: string } | undefined;
    assert.ok(!(args?.fact ?? "").includes(secret), "the secret left the VM");
    assert.match(args?.fact ?? "", /\[REDACTED\]/);
  } finally {
    server.child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-VM server scrubs secrets nested inside objects and arrays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  const rpcDir = join(dir, "rpc");
  const server = startServer(dir, rpcDir);
  const secret = "sk-nested-0123456789abcdef";
  try {
    server.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_write",
        arguments: { fact: "outer", meta: { nested: { key: secret } }, list: [{ token: secret }] },
      },
    });
    const request = await waitForRequest(rpcDir);
    assert.ok(request, "the in-VM server never asked the host");
    const args = request.raw.args as
      | { meta?: { nested?: { key?: string } }; list?: Array<{ token?: string }> }
      | undefined;
    assert.equal(args?.meta?.nested?.key, "[REDACTED]");
    assert.equal(args?.list?.[0]?.token, "[REDACTED]");
  } finally {
    server.child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-VM server answers a request whose id is null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  const server = startServer(dir);
  try {
    server.send({ jsonrpc: "2.0", id: null, method: "tools/list" });
    await waitForLines(server.lines, 1);
    assert.equal(server.lines.length, 1, "a null id must still receive a response");
    const answer = JSON.parse(server.lines[0]) as { id: null; result?: { tools?: unknown[] } };
    assert.equal(answer.id, null);
    assert.ok(Array.isArray(answer.result?.tools));
  } finally {
    server.child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-VM server exits cleanly when stdin closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  const server = startServer(dir);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    server.child.on("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    server.child.stdin.end();
    const result = await Promise.race([
      exit,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    assert.ok(result, "the server did not exit after stdin EOF");
    assert.equal(result.code, 0);
  } finally {
    server.child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-VM server scrubs nested secrets in arrays and objects with cycle protection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-scrub-"));
  const rpcDir = join(dir, "rpc");
  const script = join(dir, "memory-server.mjs");
  writeFileSync(script, MEMORY_MCP_SERVER_SOURCE, "utf8");

  const child = spawn(process.execPath, [script], {
    env: { ...process.env, SWARM_MEMORY_DIR: rpcDir, SWARM_MEMORY_POLL_MS: "20" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const plantedKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  const lines: string[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) lines.push(line);
      newline = buffer.indexOf("\n");
    }
  });

  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_write",
        arguments: {
          fact: "Harmless top-level fact",
          nested: {
            config: {
              token: plantedKey,
              list: ["harmless", plantedKey],
            },
          },
        },
      },
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && listRequests(rpcDir).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [req] = listRequests(rpcDir);
    assert.ok(req, "expected a request to be written");
    const raw = readFileSync(join(rpcDir, req), "utf8");
    assert.doesNotMatch(raw, /sk-ant-api03/);
    assert.match(raw, /\[REDACTED\]/);
    const parsed = JSON.parse(raw) as { args: { nested: { config: { token: string; list: string[] } } } };
    assert.equal(parsed.args.nested.config.token, "[REDACTED]");
    assert.deepEqual(parsed.args.nested.config.list, ["harmless", "[REDACTED]"]);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic request file creation writes via .tmp before rename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-atomic-"));
  const rpcDir = join(dir, "rpc");
  const script = join(dir, "memory-server.mjs");
  writeFileSync(script, MEMORY_MCP_SERVER_SOURCE, "utf8");

  const child = spawn(process.execPath, [script], {
    env: { ...process.env, SWARM_MEMORY_DIR: rpcDir, SWARM_MEMORY_POLL_MS: "20" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_write", arguments: { fact: "testing atomic write" } },
      })}\n`,
    );

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && listRequests(rpcDir).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const files = readdirSync(rpcDir);
    const reqFiles = files.filter((f) => f.startsWith("req-") && f.endsWith(".json"));
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    assert.equal(reqFiles.length, 1);
    assert.equal(tmpFiles.length, 0, "temporary file must be renamed into final request file");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid env timeout and poll values fall back safely without spin loop or immediate timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-env-"));
  const rpcDir = join(dir, "rpc");
  const script = join(dir, "memory-server.mjs");
  writeFileSync(script, MEMORY_MCP_SERVER_SOURCE, "utf8");

  // Pass NaN / negative / zero values in environment
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      SWARM_MEMORY_DIR: rpcDir,
      SWARM_MEMORY_TIMEOUT_MS: "not-a-number",
      SWARM_MEMORY_POLL_MS: "-5",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines: string[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) lines.push(line);
      newline = buffer.indexOf("\n");
    }
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "preferences" } },
      })}\n`,
    );

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && listRequests(rpcDir).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [req] = listRequests(rpcDir);
    assert.ok(req, "expected request file to be written even with invalid env numbers");

    // Respond from host side
    const id = req.replace(/^req-/, "").replace(/\.json$/, "");
    writeFileSync(join(rpcDir, `res-${id}.json`), JSON.stringify({ ok: true, memories: [] }), "utf8");

    const answerDeadline = Date.now() + 2000;
    while (Date.now() < answerDeadline && lines.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(lines.length > 0, "server should successfully read host response without crashing");
    const parsed = JSON.parse(lines[0]) as { id: number; result: { content: Array<{ text: string }> } };
    assert.equal(parsed.id, 1);
    assert.ok(parsed.result.content[0].text.includes('"ok":true'));
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
