/**
 * ask_human_desktop plumbing tests (lib/harness/desktop-handoff-mcp.ts).
 *
 * These pin the tool-name matcher, the bounded argument parser and the VM
 * paths/filenames of the file-based rendezvous. The seeded MCP server source
 * itself is exercised by the runtime integration test, not here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DESKTOP_HANDOFF_DIR,
  DESKTOP_HANDOFF_MCP_SERVER_NAME,
  DESKTOP_HANDOFF_MCP_SERVER_PATH,
  DESKTOP_HANDOFF_MCP_SERVER_SOURCE,
  DESKTOP_HANDOFF_TOOL,
  handoffPaths,
  isDesktopHandoffTool,
  parseDesktopHandoffArguments,
} from "./desktop-handoff-mcp";

test("handoff: recognizes the namespaced and bare tool names", () => {
  assert.equal(isDesktopHandoffTool(`mcp__${DESKTOP_HANDOFF_MCP_SERVER_NAME}__${DESKTOP_HANDOFF_TOOL}`), true);
  assert.equal(isDesktopHandoffTool("mcp__other__ask_human_desktop"), true);
  assert.equal(isDesktopHandoffTool("ask_human_desktop"), true);
  assert.equal(isDesktopHandoffTool("ask_human_desktop_extra"), false);
  assert.equal(isDesktopHandoffTool("Bash"), false);
  assert.equal(isDesktopHandoffTool("mcp__desktop-handoff__ask_user"), false);
  // The ask_user matcher must not claim this tool, and vice versa.
  assert.equal(String(isDesktopHandoffTool("mcp__ask__ask_user")), "false");
});

test("handoff: parses reason and optional description", () => {
  assert.deepEqual(parseDesktopHandoffArguments({ reason: "CAPTCHA" }), {
    reason: "CAPTCHA",
    description: "",
  });
  assert.deepEqual(
    parseDesktopHandoffArguments({ reason: "2FA", description: "Enter the code" }),
    { reason: "2FA", description: "Enter the code" },
  );
});

test("handoff: trims and bounds reason and description", () => {
  const parsed = parseDesktopHandoffArguments({
    reason: "  drag the slider to unlock  ",
    description: "d".repeat(9000),
  });
  assert.ok(parsed);
  assert.equal(parsed.reason, "drag the slider to unlock");
  assert.equal(parsed.description.length, 4000);
});

test("handoff: rejects missing or blank reasons", () => {
  assert.equal(parseDesktopHandoffArguments(undefined), null);
  assert.equal(parseDesktopHandoffArguments(null), null);
  assert.equal(parseDesktopHandoffArguments("reason"), null);
  assert.equal(parseDesktopHandoffArguments({}), null);
  assert.equal(parseDesktopHandoffArguments({ reason: "   " }), null);
  assert.equal(parseDesktopHandoffArguments({ reason: 42 }), null);
});

test("handoff: rendezvous paths stay inside the VM handoffs dir", () => {
  const paths = handoffPaths("h_123");
  assert.equal(paths.pending, `${DESKTOP_HANDOFF_DIR}/h_123.pending.json`);
  assert.equal(paths.answer, `${DESKTOP_HANDOFF_DIR}/h_123.answer.json`);
  assert.ok(paths.pending.startsWith("/workspace/"));
  assert.ok(paths.answer.startsWith("/workspace/"));
});

test("handoff: the seeded server is an MCP stdio server with an ask_human_desktop tool", () => {
  assert.equal(DESKTOP_HANDOFF_MCP_SERVER_PATH, "/workspace/.swarm/desktop-handoff-server.mjs");
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("#!/usr/bin/env node"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("tools/list"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("tools/call"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("ask_human_desktop"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("SWARM_DESKTOP_HANDOFF_DIR"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("handoff_expired"));
  // The server must never touch the host: it only reads/writes under its dir.
  assert.equal(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("/host/"), false);
  // The resolution surfaced to the agent never echoes a credential: the only
  // user-derived data returned is the compact state summary.
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("summary"));
  // The wait must not freeze the event loop: no Atomics.wait, and the
  // in-flight request tracking that notifications/cancelled drives.
  assert.equal(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("Atomics.wait"), false);
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("async function callTool"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("async function handleMessage"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("inFlightRequests"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("notifications/cancelled"));
  assert.ok(DESKTOP_HANDOFF_MCP_SERVER_SOURCE.includes("handoff_cancelled"));
});

/** Spawn the seeded server in a temp dir; returns the client plumbing. */
function spawnHandoffServer(): {
  dir: string;
  handoffDir: string;
  child: ChildProcess;
  send: (msg: Record<string, unknown>) => void;
  waitForReply: (id: number, timeoutMs: number) => Promise<Record<string, unknown>>;
  hasReply: (id: number) => boolean;
  stderr: string[];
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-handoff-server-"));
  const serverFile = path.join(dir, "desktop-handoff-server.mjs");
  fs.writeFileSync(serverFile, DESKTOP_HANDOFF_MCP_SERVER_SOURCE, "utf8");
  const handoffDir = path.join(dir, "handoffs");
  fs.mkdirSync(handoffDir, { recursive: true });

  const child: ChildProcess = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      SWARM_DESKTOP_HANDOFF_DIR: handoffDir,
      SWARM_DESKTOP_HANDOFF_TIMEOUT_MS: "15000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const replies = new Map<number, Record<string, unknown>>();
  const waiters = new Map<number, (reply: Record<string, unknown>) => void>();
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (typeof msg.id === "number") {
            replies.set(msg.id, msg);
            waiters.get(msg.id)?.(msg);
            waiters.delete(msg.id);
          }
        } catch {
          // ignore malformed lines
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  const send = (msg: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(msg)}\n`);
  };
  const waitForReply = (id: number, timeoutMs: number): Promise<Record<string, unknown>> => {
    const existing = replies.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`timed out waiting for reply ${id}; stderr: ${stderr.join("")}`));
      }, timeoutMs);
      waiters.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  };
  return {
    dir,
    handoffDir,
    child,
    send,
    waitForReply,
    hasReply: (id: number) => replies.has(id),
    stderr,
    cleanup: () => {
      child.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startHandoff(server: ReturnType<typeof spawnHandoffServer>): Promise<string> {
  server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  const init = await server.waitForReply(1, 5000);
  assert.ok(init.result, "expected an initialize result");
  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ask_human_desktop", arguments: { reason: "CAPTCHA present", description: "Solve the captcha" } },
  });
  // Give the server a beat to write the pending file and enter its wait.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(server.hasReply(2), false, "the handoff must still be pending");
  const pending = fs.readdirSync(server.handoffDir).filter((name) => name.endsWith(".pending.json"));
  assert.equal(pending.length, 1, `expected one pending file, saw: ${pending.join(", ")}`);
  return pending[0]!.slice(0, -".pending.json".length);
}

test("handoff: the seeded server stays responsive to ping while waiting for a handoff", async () => {
  const server = spawnHandoffServer();
  try {
    const handoffId = await startHandoff(server);
    // The server must answer ping while the handoff is pending: with the
    // old Atomics.wait loop the event loop was blocked and ping queued
    // until the handoff resolved.
    const pingSentAt = Date.now();
    server.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    const ping = await server.waitForReply(3, 2000);
    assert.ok(ping.result !== undefined, "expected a ping result");
    assert.ok(Date.now() - pingSentAt < 2000, "ping must be answered promptly, not after the handoff");
    assert.equal(server.hasReply(2), false, "the handoff must still be pending after ping");

    // Resolve via the rendezvous file and expect the tool result.
    fs.writeFileSync(
      path.join(server.handoffDir, `${handoffId}.answer.json`),
      JSON.stringify({ status: "answered", summary: "Captcha solved, logged in." }),
      "utf8",
    );
    const answer = await server.waitForReply(2, 5000);
    const result = answer.result as { content?: Array<{ text?: string }> };
    assert.ok(JSON.stringify(result).includes("Captcha solved"), `expected the summary in the tool result: ${JSON.stringify(result)}`);
  } finally {
    server.cleanup();
  }
});

test("handoff: notifications/cancelled aborts a pending handoff promptly", async () => {
  const server = spawnHandoffServer();
  try {
    const handoffId = await startHandoff(server);
    const cancelSentAt = Date.now();
    server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "client cancelled" } });
    const reply = await server.waitForReply(2, 2000);
    assert.ok(Date.now() - cancelSentAt < 2000, "the cancelled handoff must resolve promptly, not after the TTL");
    assert.ok(JSON.stringify(reply).includes("handoff_cancelled"), `expected a handoff_cancelled result: ${JSON.stringify(reply)}`);
    // The pending and answer files are cleaned up on cancel.
    assert.equal(fs.existsSync(path.join(server.handoffDir, `${handoffId}.pending.json`)), false);
  } finally {
    server.cleanup();
  }
});
