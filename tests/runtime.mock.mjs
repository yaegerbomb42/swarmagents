#!/usr/bin/env node
// Runtime control-plane integration test against the scripted mock LLM.
//
// Proves the durable runtime drives a REAL agent session end to end: create a task through
// the runtime API, let the scheduler run it against tests/mock-llm.mjs, and assert the task
// finishes with genuine turns, tool calls and a summary in its ledger.
//
//   npm run test:runtime:mock
// Env: RUNTIME_PORT, MOCK_PORT override ports; SWARM_AGENT_E2E=1 to reuse a server.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.RUNTIME_PORT || 3782);
const MOCK_PORT = Number(process.env.MOCK_PORT || 37902);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rt-mock-home-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rt-mock-work-"));
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

function start(cmd, argv, env, logFile) {
  const out = fs.openSync(logFile, "w");
  const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
  children.push(p);
  return p;
}
function cleanup() {
  for (const p of children) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

async function waitFor(url, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`${what} did not come up at ${url} within ${ms / 1000}s`);
}

async function api(method, p, body) {
  const r = await fetch(`${BASE}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json, text };
}

async function until(fn, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(500);
  }
}

console.log(`runtime ↔ agent mock integration\n  SWARM_HOME=${HOME}\n  server=${BASE}\n  mock=${MOCK}\n`);

// 1. mock LLM
start(process.execPath, [path.join(ROOT, "tests/mock-llm.mjs"), String(MOCK_PORT)], { MOCK_WORKDIR: WORK }, "/tmp/rt-mock-llm.log");
await waitFor(`${MOCK}/v1/models`, 15_000, "mock llm");

// 2. built server (production, closest to deploy)
start(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(PORT)], {
  NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || ".next-atlas",
  SWARM_HOME: HOME,
  HOME,
}, "/tmp/rt-mock-server.log");
await waitFor(`${BASE}/api/sessions`, 30_000, "next server");

// 3. configure the mock as the only provider
const conn = await api("POST", "/api/connections", { type: "llm", preset: "custom", label: "Mock", baseUrl: `${MOCK}/v1`, apiKey: "runtime-mock-key", model: "mock" });
check("provider configured", conn.status === 200, `status ${conn.status}`);

// 4. task A: a real tool-using run
console.log("\n1. runtime task runs a real agent turn with tools");
const a = await api("POST", "/api/runtime/tasks", { prompt: "[mock:tools] run the tool script", title: "mock tools" });
check("task created", !!a.json.task?.id, a.json?.error);
const taskA = await until(async () => {
  const t = await api("GET", `/api/runtime/tasks/${a.json.task.id}`);
  return ["done", "failed", "blocked"].includes(t.json.task?.status) ? t.json : null;
});
check("task reached a terminal state", ["done", "failed"].includes(taskA?.task?.status), taskA?.task?.status + " / " + taskA?.task?.result?.summary);
check("task actually ran turns", (taskA?.task?.usage?.turns ?? 0) >= 1, `${taskA?.task?.usage?.turns} turns`);
check("task recorded tool calls", (taskA?.task?.usage?.toolCalls ?? 0) >= 1, `${taskA?.task?.usage?.toolCalls} tools`);
check("ledger has a completed run", taskA?.ledger?.runs?.some((r) => r.status === "done"));
check("ledger has tool steps", taskA?.ledger?.steps?.some((s) => s.kind === "tool"), `${taskA?.ledger?.steps?.length} steps`);
check("summary is a real answer, not an error", !/no (llm )?provider/i.test(taskA?.task?.result?.summary ?? ""), (taskA?.task?.result?.summary ?? "").slice(0, 80));

// 5. task B: a real rate-limit / quota wait through the router, without losing work
console.log("\n2. runtime task absorbs a real quota/ratelimit wait without re-running");
const b = await api("POST", "/api/runtime/tasks", { prompt: "[mock:ratelimit] go", title: "mock ratelimit" });
const taskB = await until(async () => {
  const t = await api("GET", `/api/runtime/tasks/${b.json.task.id}`);
  return ["done", "failed"].includes(t.json.task?.status) ? t.json : null;
}, 150_000);
check("ratelimited task finished", ["done", "failed"].includes(taskB?.task?.status), taskB?.task?.status);
check("quota wait kept the work (finished, attempt recorded)", (taskB?.task?.attempts ?? 0) >= 1, `${taskB?.task?.attempts} attempts`);

// 6. task C: a destructive action parks the task for approval, then Approve releases it
console.log("\n3. destructive action blocks for approval, then Approve resumes it");
const c = await api("POST", "/api/runtime/tasks", { prompt: "[mock:risky] clean up", title: "mock risky" });
const blockedC = await until(async () => {
  const t = await api("GET", `/api/runtime/tasks/${c.json.task.id}`);
  return t.json.task?.status === "blocked" ? t.json : null;
}, 60_000);
check("destructive action blocked the task", blockedC?.task?.status === "blocked", blockedC?.task?.status);
check("wait is an approval with a bound token", blockedC?.task?.wait?.kind === "approval" && !!blockedC?.task?.wait?.token, blockedC?.task?.wait?.message?.slice(0, 80));
const approved = await api("POST", `/api/runtime/tasks/${c.json.task.id}`, { action: "approve" });
check("approve accepted", approved.status === 200, `status ${approved.status}`);
const doneC = await until(async () => {
  const t = await api("GET", `/api/runtime/tasks/${c.json.task.id}`);
  return ["done", "failed", "blocked"].includes(t.json.task?.status) ? t.json : null;
}, 60_000);
check("approved task finished without blocking again", doneC?.task?.status === "done", `${doneC?.task?.status} / ${doneC?.task?.result?.summary}`);
check("ledger recorded the approval decision", doneC?.ledger?.steps?.some((s) => /approv/i.test(s.label ?? "")), "approval step");

console.log(`\n${failures === 0 ? "RUNTIME MOCK INTEGRATION PASS" : `RUNTIME MOCK INTEGRATION FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);