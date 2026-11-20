/**
 * ask_user plumbing tests (lib/harness/ask-mcp.ts).
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
  ASK_MCP_SERVER_NAME,
  ASK_MCP_SERVER_PATH,
  ASK_MCP_SERVER_SOURCE,
  ASK_QUESTIONS_DIR,
  ASK_USER_TOOL,
  isAskUserTool,
  parseAskUserArguments,
  questionPaths,
} from "./ask-mcp";

test("ask: recognizes the namespaced and bare tool names", () => {
  assert.equal(isAskUserTool(`mcp__${ASK_MCP_SERVER_NAME}__${ASK_USER_TOOL}`), true);
  assert.equal(isAskUserTool("mcp__other__ask_user"), true);
  assert.equal(isAskUserTool("ask_user"), true);
  assert.equal(isAskUserTool("mcp__ask__ask_user_extra"), false);
  assert.equal(isAskUserTool("Bash"), false);
  assert.equal(isAskUserTool("mcp__ask__list_questions"), false);
});

test("ask: parses question, options and free-text default", () => {
  assert.deepEqual(parseAskUserArguments({ question: "Which colour?" }), {
    question: "Which colour?",
    options: [],
    allowFreeText: true,
  });
  assert.deepEqual(parseAskUserArguments({ question: "Pick", options: ["red", "blue"], allow_free_text: false }), {
    question: "Pick",
    options: ["red", "blue"],
    allowFreeText: false,
  });
});

test("ask: trims, bounds and filters options", () => {
  const parsed = parseAskUserArguments({
    question: "  Pick one  ",
    options: ["  a  ", "", 7, "b", "c", "d", "e", "f", "g", "h", "i"],
  });
  assert.ok(parsed);
  assert.equal(parsed.question, "Pick one");
  assert.deepEqual(parsed.options, ["a", "b", "c", "d", "e", "f", "g", "h"]);
});

test("ask: rejects missing or blank questions", () => {
  assert.equal(parseAskUserArguments(undefined), null);
  assert.equal(parseAskUserArguments(null), null);
  assert.equal(parseAskUserArguments("question"), null);
  assert.equal(parseAskUserArguments({}), null);
  assert.equal(parseAskUserArguments({ question: "   " }), null);
  assert.equal(parseAskUserArguments({ question: 42 }), null);
});

test("ask: bounds the question and each option", () => {
  const parsed = parseAskUserArguments({ question: "x".repeat(9000), options: ["y".repeat(500)] });
  assert.ok(parsed);
  assert.equal(parsed.question.length, 4000);
  assert.equal(parsed.options[0].length, 200);
});

test("ask: rendezvous paths stay inside the VM questions dir", () => {
  const paths = questionPaths("q_123");
  assert.equal(paths.pending, `${ASK_QUESTIONS_DIR}/q_123.pending.json`);
  assert.equal(paths.answer, `${ASK_QUESTIONS_DIR}/q_123.answer.json`);
  assert.ok(paths.pending.startsWith("/workspace/"));
  assert.ok(paths.answer.startsWith("/workspace/"));
});

test("ask: the seeded server is an MCP stdio server with an ask_user tool", () => {
  assert.equal(ASK_MCP_SERVER_PATH, "/workspace/.swarm/ask-server.mjs");
  assert.ok(ASK_MCP_SERVER_SOURCE.includes("#!/usr/bin/env node"));
  assert.ok(ASK_MCP_SERVER_SOURCE.includes("tools/list"));
  assert.ok(ASK_MCP_SERVER_SOURCE.includes("tools/call"));
  assert.ok(ASK_MCP_SERVER_SOURCE.includes("ask_user"));
  assert.ok(ASK_MCP_SERVER_SOURCE.includes("SWARM_ASK_DIR"));
  // The server must never touch the host: it only reads/writes under its dir.
  assert.equal(ASK_MCP_SERVER_SOURCE.includes("/host/"), false);
  assert.ok(ASK_MCP_SERVER_SOURCE.includes("question_expired"));
});

test("ask: the seeded server stays responsive to ping while waiting for an answer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-ask-server-"));
  const serverFile = path.join(dir, "ask-server.mjs");
  fs.writeFileSync(serverFile, ASK_MCP_SERVER_SOURCE, "utf8");
  const askDir = path.join(dir, "questions");
  fs.mkdirSync(askDir, { recursive: true });

  const child: ChildProcess = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      SWARM_ASK_DIR: askDir,
      SWARM_ASK_TIMEOUT_MS: "15000",
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

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const init = await waitForReply(1, 5000);
    assert.ok(init.result, "expected an initialize result");

    // Start a question and do NOT answer it yet.
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "Which option?", options: ["option A", "option B"] } },
    });
    // Give the server a beat to write the pending file and enter its wait.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(replies.has(2), false, "the question must still be pending");

    // The server must answer ping while the question is pending: with the
    // old Atomics.wait loop the event loop was blocked and ping queued
    // until the question resolved.
    const pingSentAt = Date.now();
    send({ jsonrpc: "2.0", id: 3, method: "ping" });
    const ping = await waitForReply(3, 2000);
    assert.ok(ping.result !== undefined, "expected a ping result");
    assert.ok(Date.now() - pingSentAt < 2000, "ping must be answered promptly, not after the question");
    assert.equal(replies.has(2), false, "the question must still be pending after ping");

    // Now answer via the rendezvous file and expect the tool result.
    const pending = fs.readdirSync(askDir).filter((name) => name.endsWith(".pending.json"));
    assert.equal(pending.length, 1, `expected one pending file, saw: ${pending.join(", ")}`);
    const questionId = pending[0]!.slice(0, -".pending.json".length);
    fs.writeFileSync(
      path.join(askDir, `${questionId}.answer.json`),
      JSON.stringify({ status: "answered", answer: "option A" }),
      "utf8",
    );
    const answer = await waitForReply(2, 5000);
    const result = answer.result as { content?: Array<{ text?: string }> };
    assert.ok(JSON.stringify(result).includes("option A"), `expected the answer in the tool result: ${JSON.stringify(result)}`);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
