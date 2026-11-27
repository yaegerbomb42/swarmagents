import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  FANOUT_MCP_SERVER_NAME,
  FANOUT_MCP_SERVER_SOURCE,
  FANOUT_WORKERS_TOOL,
  MAX_FANOUT_WORKERS,
  MAX_WORKER_TURNS,
  isFanOutWorkersTool,
  parseFanOutArguments,
} from "./fanout-mcp";
import { executeFanOutWorkers } from "./fanout-executor";

test("isFanOutWorkersTool recognizes qualified and bare tool names", () => {
  assert.equal(isFanOutWorkersTool(`mcp__${FANOUT_MCP_SERVER_NAME}__${FANOUT_WORKERS_TOOL}`), true);
  assert.equal(isFanOutWorkersTool("fan_out_workers"), true);
  assert.equal(isFanOutWorkersTool("Bash"), false);
});

test("parseFanOutArguments clamps worker count to 5 and turn caps to 1..15", () => {
  assert.equal(parseFanOutArguments(null), null);
  assert.equal(parseFanOutArguments({ tasks: [{ prompt: "  " }] }), null);

  const parsed = parseFanOutArguments({
    maxConcurrency: 99,
    maxTurnsPerWorker: 100,
    tasks: Array.from({ length: 8 }, (_, i) => ({
      prompt: `Research topic ${i + 1}`,
      maxTurns: i === 0 ? 0 : 99,
    })),
  });
  assert.ok(parsed);
  assert.equal(parsed.tasks.length, MAX_FANOUT_WORKERS);
  assert.equal(parsed.maxConcurrency, MAX_FANOUT_WORKERS);
  assert.equal(parsed.maxTurnsPerWorker, MAX_WORKER_TURNS);
  assert.equal(parsed.tasks[0].maxTurns, 1);
  assert.equal(parsed.tasks[1].maxTurns, MAX_WORKER_TURNS);
});

test("executeFanOutWorkers enforces bounded concurrency, shared budget, and partial-failure resilience", async () => {
  let active = 0;
  let peak = 0;
  const args = parseFanOutArguments({
    maxConcurrency: 2,
    tasks: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "B" },
      { id: "c", prompt: "C" },
      { id: "d", prompt: "D" },
      { id: "e", prompt: "E" },
    ],
  });
  assert.ok(args);

  const res = await executeFanOutWorkers(args, {
    parentBudgetUsd: 0.06,
    runWorker: async (task) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      if (task.id === "b") throw new Error("boom");
      return { ok: true, summary: `done ${task.id}`, turns: 2, costUsd: 0.03 };
    },
  });

  assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed 2`);
  assert.equal(res.total, 5);
  assert.equal(res.budgetExhausted, true);
  assert.ok(res.succeeded >= 2);
  assert.equal(res.results.find((r) => r.id === "b")?.ok, false);
  assert.equal(res.results.find((r) => r.id === "b")?.error, "boom");
  assert.ok(res.results.some((r) => r.error?.includes("budget exhausted")));
});

test("FANOUT_MCP_SERVER_SOURCE handles initialize, tools/list, and tools/call rendezvous", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-fanout-"));
  const serverFile = path.join(dir, "fanout-server.mjs");
  const fanoutDir = path.join(dir, "fanout");
  fs.writeFileSync(serverFile, FANOUT_MCP_SERVER_SOURCE, "utf8");

  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, SWARM_FANOUT_DIR: fanoutDir, SWARM_FANOUT_TIMEOUT_MS: "10000" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const replies: Array<{ id: number; result?: unknown }> = [];
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });

  const writeMsg = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
  writeMsg({ jsonrpc: "2.0", id: 1, method: "initialize" });
  writeMsg({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  writeMsg({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "fan_out_workers", arguments: { tasks: [{ prompt: "audit x" }] } },
  });

  const deadline = Date.now() + 5000;
  let responded = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(fanoutDir) && !responded) {
      const pending = fs.readdirSync(fanoutDir).find((f) => f.endsWith(".pending.json"));
      if (pending) {
        const reqId = pending.replace(".pending.json", "");
        fs.writeFileSync(
          path.join(fanoutDir, `${reqId}.result.json`),
          JSON.stringify({ ok: true, total: 1, succeeded: 1, failed: 0, results: [{ id: "w1", ok: true, summary: "ok" }] }),
        );
        responded = true;
      }
    }
    if (replies.some((r) => r.id === 3)) break;
    await new Promise((r) => setTimeout(r, 30));
  }

  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });

  const listReply = replies.find((r) => r.id === 2)?.result as { tools?: Array<{ name: string }> } | undefined;
  assert.equal(listReply?.tools?.[0]?.name, "fan_out_workers");
  const callReply = replies.find((r) => r.id === 3)?.result as { content?: Array<{ text: string }> } | undefined;
  assert.ok(callReply?.content?.[0]?.text.includes('"succeeded":1'));
});
