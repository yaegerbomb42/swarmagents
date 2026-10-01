// End-to-end test for the durable runtime control plane (lane F2/D2).
//
// Runs the real modules (store, tasks, ledger, artifacts, scheduler, budget) against a
// temporary SWARM_HOME. Only the LLM boundary is replaced: a fake AgentAdapter stands in
// for the agent core, so we exercise the genuine scheduler/queue/ledger code paths.
//
// Run:  node --experimental-strip-types tests/runtime.e2e.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Isolate all persistence before the store module is imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rt-"));
process.env.SWARM_HOME = home;

const rt = await import(path.join(root, "lib/runtime/index.ts"));
const { setAgentAdapter, scheduler, createTask, getTask, getLedger, listArtifacts, listTasks, updateTask } = rt;

let failures = 0;
const check = (name, cond, extra = "") => {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a condition, polling, up to a deadline.
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(40);
  }
}

// ---- Fake adapter: different behaviours keyed by a marker in the prompt ----

const quotaOnce = new Set();
const adapter = {
  async run(task, hooks) {
    hooks.onTurn({ inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 0.001, provider: "fake", model: "fake-1" });
    hooks.onTool("read_file", true);

    if (task.prompt.includes("QUOTA") && !quotaOnce.has(task.id)) {
      quotaOnce.add(task.id);
      hooks.onQuotaWait(300, "Rate limited; will retry");
      return { summary: "parked" };
    }

    if (task.prompt.includes("BIGOUT")) {
      const p = path.join(home, "big.txt");
      fs.writeFileSync(p, "x".repeat(5000));
      hooks.onTool("write_file", true);
      return { summary: "wrote a big file", outputs: [{ path: p, title: "big.txt" }], verified: true };
    }

    // Simulate extra usage to blow a token budget if asked.
    if (task.prompt.includes("BUDGET")) {
      for (let i = 0; i < 5; i++) hooks.onTurn({ inputTokens: 10_000, outputTokens: 0, cachedTokens: 0 });
    }

    return { summary: `done: ${task.title}`, verified: true };
  },
  stop() {},
  isRunning() {
    return false;
  },
};

setAgentAdapter(adapter);
scheduler().start();

console.log(`runtime e2e — SWARM_HOME=${home}\n`);

// ---- 1. Basic run reaches done, ledger + turn recorded ----
console.log("1. basic task runs to done");
const t1 = await createTask({ prompt: "say hello", title: "basic" });
scheduler().kick();
const done1 = await until(() => {
  const t = getTask(t1.id);
  return t && (t.status === "done" || t.status === "failed") ? t : null;
});
check("task reaches done", done1?.status === "done", done1?.status);
check("usage recorded", (done1?.usage.turns ?? 0) >= 1, `${done1?.usage.turns} turns`);
check("result summary kept", !!done1?.result?.summary);
const led1 = getLedger(t1.id);
check("ledger has a completed run", led1.runs.some((r) => r.status === "done"));
check("ledger has steps", led1.steps.length >= 2, `${led1.steps.length} steps`);

// ---- 2. Artifact registration ----
console.log("\n2. artifacts are captured");
const t2 = await createTask({ prompt: "BIGOUT please", title: "artifact" });
scheduler().kick();
await until(() => getTask(t2.id)?.status === "done");
const arts = listArtifacts(t2.id);
check("artifact registered", arts.length === 1, `${arts.length}`);
check("artifact points at file", !!arts[0]?.path && fs.existsSync(arts[0].path));
check("artifact inlined small text", typeof arts[0]?.text === "string" && arts[0].text.length === 5000);

// ---- 3. Quota wait parks then auto-resumes ----
console.log("\n3. quota wait parks the task, then it resumes");
const t3 = await createTask({ prompt: "QUOTA work", title: "quota" });
scheduler().kick();
const parked = await until(() => {
  const t = getTask(t3.id);
  return t && t.status === "waiting" ? t : null;
});
check("task parked on quota", parked?.status === "waiting", parked?.wait?.message);
check("park has resume time", typeof parked?.wait?.resumeAt === "number");
const resumed = await until(() => {
  const t = getTask(t3.id);
  return t && t.status === "done" ? t : null;
}, 10_000);
check("task auto-resumed to done", resumed?.status === "done", resumed?.status);
check("two attempts recorded", (resumed?.attempts ?? 0) >= 2, `${resumed?.attempts} attempts`);

// ---- 4. Budget enforcement pauses for approval ----
console.log("\n4. budget limit pauses and asks");
const t4 = await createTask({ prompt: "BUDGET blow", title: "budget", budget: { maxTokens: 20_000 } });
scheduler().kick();
const blocked = await until(() => {
  const t = getTask(t4.id);
  return t && (t.status === "blocked" || t.status === "done") ? t : null;
}, 8000);
check("task blocked on budget", blocked?.status === "blocked", `${blocked?.status} / ${blocked?.wait?.message}`);

// ---- 5. Crash recovery: a task left "running" is reconciled on restart ----
console.log("\n5. restart reconciles a stale running task");
const t5 = await createTask({ prompt: "plain", title: "stale" });
await updateTask(t5.id, (t) => {
  t.status = "running"; // simulate a crash mid-run
});
scheduler().stop();
scheduler().start(); // restart triggers reconcile()
const reconciled = await until(() => {
  const t = getTask(t5.id);
  return t && t.status !== "running" ? t : null;
}, 8000);
check("stale running task reconciled", reconciled && reconciled.status !== "running", reconciled?.status);

// ---- 6. Delete + session cleanup ----
console.log("\n6. delete removes the task");
const t6 = await createTask({ prompt: "delete me", title: "deletable" });
const before = listTasks().length;
await rt.deleteTask(t6.id, true);
check("task removed from board", listTasks().length === before - 1);

console.log(`\n${failures === 0 ? "RUNTIME E2E PASS" : `RUNTIME E2E FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);