import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("the in-VM server answers initialize, tools/list and tools/call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  const rpcDir = join(dir, "rpc");
  const script = join(dir, "memory-server.mjs");
  writeFileSync(script, MEMORY_MCP_SERVER_SOURCE, "utf8");

  const child = spawn(process.execPath, [script], {
    env: { ...process.env, SWARM_MEMORY_DIR: rpcDir, SWARM_MEMORY_POLL_MS: "20" },
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

  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_write", arguments: { fact: "the user prefers pnpm" } } });

    // The server writes the request envelope into the VM's RPC directory and
    // waits for the host's answer: play the host here.
    let request: { tool?: string; args?: { fact?: string } } | null = null;
    for (let i = 0; i < 100 && request === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const files = listRequests(rpcDir);
      if (files.length === 0) continue;
      const raw = JSON.parse(readFileSync(join(rpcDir, files[0]), "utf8")) as { tool?: string; args?: { fact?: string } };
      request = raw;
      const id = files[0].replace(/^req-/, "").replace(/\.json$/, "");
      writeFileSync(
        join(rpcDir, `res-${id}.json`),
        JSON.stringify({ ok: true, message: `stored ${raw.args?.fact ?? ""}` }),
        "utf8",
      );
    }

    assert.ok(request, "the in-VM server never asked the host");
    assert.equal(request.tool, "memory_write");
    assert.equal(request.args?.fact, "the user prefers pnpm");

    // Wait for the answers to come back on stdout.
    for (let i = 0; i < 100 && lines.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const answers = lines.map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
    const init = answers.find((answer) => answer.id === 1);
    assert.ok(init, "no initialize answer");
    const list = answers.find((answer) => answer.id === 2);
    const tools = (list?.result?.tools ?? []) as Array<{ name: string }>;
    assert.deepEqual(tools.map((tool) => tool.name), ["memory_write", "memory_search", "memory_forget"]);
    const call = answers.find((answer) => answer.id === 3);
    const content = (call?.result?.content ?? []) as Array<{ text: string }>;
    assert.match(content[0]?.text ?? "", /"ok":true/);
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-VM server scrubs secrets before the fact leaves the VM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-memory-mcp-"));
  const rpcDir = join(dir, "rpc");
  const script = join(dir, "memory-server.mjs");
  writeFileSync(script, MEMORY_MCP_SERVER_SOURCE, "utf8");

  const child = spawn(process.execPath, [script], {
    env: { ...process.env, SWARM_MEMORY_DIR: rpcDir, SWARM_MEMORY_POLL_MS: "20" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const secret = "sk-FAKE-VM-KEY-0123456789ABCDEF0123456789";
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_write", arguments: { fact: `the key is ${secret}` } },
      })}\n`,
    );

    let request: { args?: { fact?: string } } | null = null;
    for (let i = 0; i < 100 && request === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const files = listRequests(rpcDir);
      if (files.length === 0) continue;
      request = JSON.parse(readFileSync(join(rpcDir, files[0]), "utf8")) as { args?: { fact?: string } };
    }

    assert.ok(request, "the in-VM server never asked the host");
    assert.ok(!(request.args?.fact ?? "").includes(secret), "the secret left the VM");
    assert.match(request.args?.fact ?? "", /\[REDACTED\]/);
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
