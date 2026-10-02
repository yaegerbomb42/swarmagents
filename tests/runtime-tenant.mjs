// Per-account isolation for the runtime control plane (lane F) in server mode.
//
// The durable runtime (tasks, ledger, artifacts, approvals, denials, settings) must be
// per-user: on a server no account may see, stop, or approve another account's tasks. This
// test runs two fake accounts against a temporary SWARM_HOME in server mode and drives the
// real store/scheduler modules. Only the LLM boundary (the agent adapter) is faked.
//
// Run:  npx tsx tests/runtime-tenant.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-rt-tenant-"));
process.env.SWARM_HOME = home;
process.env.SWARM_MODE = "server";

const store = await import("../lib/store.ts");
const rtStore = await import("../lib/runtime/store.ts");
const flushWrites = rtStore.flushWrites;
const rt = await import("../lib/runtime/index.ts");

/**
 * Build a session by hand for each account. store.createSession() needs the per-user OS sandbox on
 * a server, which this unit test does not run (same approach as tests/tenant-storage.mjs). We are
 * testing the runtime control plane's storage/scheduler isolation, not sandboxing.
 */
function makeSession(title) {
  const m = { id: store.newId(), title, createdAt: Date.now(), updatedAt: Date.now(), cwd: "/tmp" };
  fs.mkdirSync(store.sessionDir(m.id), { recursive: true });
  store.saveMeta(m);
  store.saveEvents(m.id, []);
  return m.id;
}

const { setAgentAdapter, scheduler, createTask, getTask, listTasks, grantApproval, takeApproval, recordDenial, isDenied, runtimeDir, loadRuntimeSettings, saveRuntimeSettings, subscribeRuntime } = rt;
const { runAs, allUserIds } = store;

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
let pass = 0;
const t = (name, fn) => {
  const r = fn();
  return r instanceof Promise ? r.then(() => (pass++, console.log("  ok", name))) : (pass++, console.log("  ok", name));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(30);
  }
}

// A fake adapter that just finishes a task, recording which user's home it ran under.
let seenDirs = [];
setAgentAdapter({
  async run(task) {
    seenDirs.push(runtimeDir());
    return { summary: `done: ${task.prompt}`, verified: true };
  },
  stop() {},
  isRunning() {
    return false;
  },
});

try {
  // ---- Isolation of the task board ----
  let aTaskId = "";
  await t("account A can create a task; account B cannot see it", async () => {
    aTaskId = (await runAs(A, () => createTask({ prompt: "A's secret task", sessionId: makeSession("A chat") }))).id;
    const aTasks = runAs(A, () => listTasks());
    const bTasks = runAs(B, () => listTasks());
    assert.equal(aTasks.length, 1);
    assert.equal(bTasks.length, 0, "B must not see A's tasks");
  });

  await t("tasks live under each account's own home", () => {
    assert.ok(fs.existsSync(path.join(home, "users", A, "runtime", "tasks.json")));
    assert.ok(!fs.existsSync(path.join(home, "runtime", "tasks.json")), "no shared/global runtime dir");
  });

  await t("getting another account's task by id returns nothing", () => {
    assert.equal(runAs(B, () => getTask(aTaskId)), undefined);
    assert.ok(runAs(A, () => getTask(aTaskId)));
  });

  // ---- Isolation of approvals and denials ----
  await t("an approval granted by A is invisible to B and not consumable by B", async () => {
    await runAs(A, () => grantApproval({ taskId: aTaskId, hash: "h-rm", tool: "bash", label: "rm -rf x", grantedAt: Date.now() }));
    assert.equal(runAs(B, () => takeApproval(aTaskId, "h-rm")), null, "B must not consume A's grant");
    assert.ok(runAs(A, () => takeApproval(aTaskId, "h-rm")), "A can consume its own grant");
  });

  await t("a denial recorded by A does not block B", async () => {
    await runAs(A, () => recordDenial({ taskId: aTaskId, hash: "h-del", tool: "bash", label: "rm", deniedAt: Date.now() }));
    assert.equal(runAs(A, () => isDenied(aTaskId, "h-del")), true);
    assert.equal(runAs(B, () => isDenied(aTaskId, "h-del")), false);
  });

  // ---- Isolation of runtime settings ----
  await t("runtime settings are per account", async () => {
    runAs(A, () => saveRuntimeSettings({ ...loadRuntimeSettings(), concurrency: 2 }));
    await flushWrites();
    assert.equal(runAs(A, () => loadRuntimeSettings().concurrency), 2);
    assert.notEqual(runAs(B, () => loadRuntimeSettings().concurrency), 2, "B must keep the default");
  });

  // ---- The scheduler runs each account's work under its own home ----
  await t("the scheduler runs both accounts' tasks, each under its own runtime dir", async () => {
    setAgentAdapter({
      async run(task) {
        seenDirs.push(runtimeDir());
        return { summary: `done: ${task.prompt}`, verified: true };
      },
      stop() {},
      isRunning() {
        return false;
      },
    });
    // B creates its own task too, and both are queued.
    runAs(B, () => createTask({ prompt: "B's task", sessionId: makeSession("B chat") }));
    await runAs(B, () => createTask({ prompt: "B's task 2", sessionId: makeSession("B chat 2") }));
    scheduler().start();
    scheduler().kick();
    const done = await until(() => runAs(A, () => getTask(aTaskId))?.status === "done" && runAs(B, () => listTasks()).every((x) => x.status === "done"), 10_000);
    assert.ok(done, "both accounts' tasks must finish");
    const aDir = path.join(home, "users", A, "runtime");
    const bDir = path.join(home, "users", B, "runtime");
    assert.ok(seenDirs.includes(aDir), `A's run used A's dir: ${JSON.stringify(seenDirs)}`);
    assert.ok(seenDirs.includes(bDir), `B's run used B's dir: ${JSON.stringify(seenDirs)}`);
  });

  await t("allUserIds enumerates both accounts so the scheduler can find each one", () => {
    const ids = allUserIds().sort();
    assert.deepEqual(ids, [A, B].sort());
  });

  await t("stopping under one account never touches another account's run", async () => {
    // Not running anything now; stopTask under B for A's task is a no-op, and A's task stays done.
    const settled = await runAs(B, () => scheduler().stopTask(aTaskId));
    assert.equal(settled, true);
    assert.equal(runAs(A, () => getTask(aTaskId)).status, "done");
  });

  await t("a created task is announced only after it is committed, so the stream can prove ownership", async () => {
    // The live task stream (app/api/runtime/stream/route.ts) admits an unknown id by re-reading the
    // account's own task list through lib/runtime/stream-filter.ts. That only works if the row is on
    // disk by the time the event fires — otherwise the account's own new task is denied and surfaces
    // only on the 10s safety sweep (measured ~9.8s dead latency). Lock the ordering in.
    const marker = "announce-order-probe";
    const seen = [];
    const off = subscribeRuntime((e) => {
      if (e.type !== "task" || !e.task.prompt.includes(marker)) return;
      // At announce time the task MUST already be persisted and visible to a fresh read.
      seen.push({ id: e.task.id, persisted: runAs(A, () => getTask(e.task.id)) });
    });
    const created = await runAs(A, () => createTask({ prompt: `${marker} task`, sessionId: makeSession("announce probe") }));
    off();
    assert.equal(seen.length, 1, `exactly one create event, saw ${seen.length}`);
    assert.equal(seen[0].id, created.id, "event carries the created task id");
    assert.ok(seen[0].persisted, "the task is on disk when the create event fires");
  });

  console.log(`\nRUNTIME TENANT PASS (${pass})`);
  process.exit(0);
} catch (e) {
  console.error("\nRUNTIME TENANT FAIL:", e && e.stack ? e.stack : e);
  process.exit(1);
}