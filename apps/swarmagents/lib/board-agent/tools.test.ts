import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureStorePaths, getStoragePaths, loadStore, saveStoreAtomic } from "../board/store";
import type { SwarmTask } from "../mcp-types";
import { RuntimeManager, setRuntimeManagerForTesting, type RunSummary } from "../runtime/manager";
import { TelemetryBus } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { FakeVmDriver } from "../vm/fake-driver";
import { VmManager, setVmManagerForTesting } from "../vm/manager";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import {
  createBoardTask,
  getBoardDigest,
  getBoardTask,
  getRunStatus,
  listBoardTasks,
  vmExec,
  vmListWorkspace,
  vmReadFile,
  vmReadOutput,
  vmScreenshot,
  vmWriteFile,
  VM_MCP_TOOL_DEFINITIONS,
} from "./tools";

class StubVmDriver extends FakeVmDriver {
  scrotPaths: string[] = [];
  removedPaths: string[] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "scrot") {
      const target = cmd[cmd.length - 1];
      this.scrotPaths.push(target);
      await this.writeFile(handle, target, `png-for-${handle.userId}`);
      return { exitCode: 0 };
    }
    if (cmd[0] === "rm") {
      this.removedPaths.push(cmd[cmd.length - 1]);
      return super.exec(handle, cmd, opts);
    }
    if (cmd[0] === "bash" && cmd[1] === "-lc") {
      const line = cmd[2] ?? "";
      if (line.includes("echo-test")) {
        opts?.onStdout?.(`hello-${handle.userId}\n`);
        opts?.onStderr?.(`warn-${handle.userId}\n`);
        return { exitCode: 0 };
      }
      if (line.includes("exit-7")) {
        opts?.onStderr?.("boom\n");
        return { exitCode: 7 };
      }
    }
    return super.exec(handle, cmd, opts);
  }
}

let runsDir: string;
let cleanup: () => void;
test.beforeEach(() => {
  const { STORAGE_DIR, DATA_FILE } = getStoragePaths();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-agent-tools-"));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  runsDir = path.join(dir, "runs");
  configureRunsDir(runsDir);
  cleanup = () => {
    setRuntimeManagerForTesting(null);
    setVmManagerForTesting(null);
    configureRunsDir(null);
    configureStorePaths(STORAGE_DIR, DATA_FILE);
    fs.rmSync(dir, { recursive: true, force: true });
  };
});
test.afterEach(() => cleanup());

const TASK = { title: "Update docs", description: "Document the example", constraints: ["Tests only"] };

test("creation defaults omitted difficulty and persists using the existing board schema", async () => {
  const result = await createBoardTask("alice", TASK);
  assert.equal(result.ok, true);
  assert.ok(result.data);
  const { taskId, title } = result.data;
  assert.match(result.summary, new RegExp(taskId));
  const [saved] = loadStore().tasks;
  assert.equal(saved.id, taskId);
  assert.equal(saved.title, title);
  assert.equal(saved.difficulty, "medium");
  assert.equal(saved.status, "open");
  assert.deepEqual(saved.constraints, TASK.constraints);
  assert.equal("runId" in saved, false);
  assert.deepEqual(getBoardTask("alice", taskId).data, saved);
  assert.equal(getBoardTask("alice", "missing").ok, false);
});

test("creation rejects invalid lengths, difficulty and constraints without saving", async () => {
  for (const [patch, field] of [
    [{ title: " " }, "title"],
    [{ title: "x".repeat(201) }, "title"],
    [{ description: "x".repeat(8001) }, "description"],
    [{ difficulty: null }, "difficulty"],
    [{ difficulty: "impossible" }, "difficulty"],
    [{ constraints: [1] }, "constraints"],
    [{ constraints: ["x".repeat(501)] }, "constraints"],
  ] as const) {
    const result = await createBoardTask("alice", { ...TASK, ...patch });
    assert.equal(result.ok, false);
    assert.match(result.summary, new RegExp(field));
  }
  assert.deepEqual(loadStore().tasks, []);
});

test("listing filters by status and shows at most the newest 20 compact task summaries", async () => {
  const store = loadStore();
  store.tasks = Array.from({ length: 24 }, (_, n): SwarmTask => ({
    ...TASK, id: `task_${n}`, difficulty: "easy", minElo: 1200, createdAt: n, updatedAt: n,
    status: n === 23 ? "in_review" : "open",
    ...(n === 23 ? { claimedBy: "worker", prUrl: "https://example.test/pr/23" } : {}),
  }));
  await saveStoreAtomic(store);
  const all = listBoardTasks("alice", {});
  assert.equal(all.ok, true);
  assert.equal(all.data?.length, 20);
  assert.equal(all.data?.[0].id, "task_23");
  assert.match(all.summary, /20 of 24/);
  assert.doesNotMatch(all.summary, /Document the example/);
  const review = listBoardTasks("alice", { status: "in_review" });
  assert.deepEqual(review.data, [{
    id: "task_23", title: TASK.title, status: "in_review", claimedBy: "worker", prUrl: "https://example.test/pr/23",
  }]);
  assert.match(review.summary, /worker.*https:\/\/example.test\/pr\/23/);
  assert.equal(listBoardTasks("alice", { status: "invalid" }).ok, false);
});

test("run status is caller-scoped and includes the terminal reply when persisted", (t) => {
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  const manager = new RuntimeManager({ router: null, bus });
  const run: RunSummary = {
    runId: "run_fixture", userId: "alice", status: "finished", prompt: "Update docs", lastSeq: 3, createdAt: 1, exitCode: 0,
  };
  bus.publish(run.runId, { type: "run.created", data: { userId: "alice", prompt: run.prompt } });
  bus.publish(run.runId, { type: "assistant.text", data: { text: "Docs updated. PR: https://example.test/pr/42" } });
  bus.publish(run.runId, { type: "run.finished", data: { exitCode: 0 } });
  const list = t.mock.method(manager, "list", (userId: string) => userId === "alice" ? [run] : []);
  setRuntimeManagerForTesting(manager);
  const result = getRunStatus("alice", run.runId);
  assert.deepEqual(result.data, { runId: run.runId, status: "finished" });
  assert.match(result.summary, /Exit code: 0/);
  assert.match(result.summary, /Docs updated.*https:\/\/example.test\/pr\/42/);
  assert.deepEqual(getRunStatus("bob", run.runId), { ok: false, summary: "VM run not found." });
  assert.deepEqual(list.mock.calls.map((call) => call.arguments), [["alice"], ["bob"]]);
});


test("digest reports ready, stale, review and completed work without writing the board", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const task = (id: string, status: SwarmTask["status"], updatedAt: number): SwarmTask => ({
    ...TASK, id, status, updatedAt, createdAt: updatedAt, difficulty: "easy", minElo: 1200,
  });
  const current = task("task_active", "claimed", now);
  const expired = {
    ...task("task_expired", "claimed", 1), claimedBy: "old-worker", prUrl: "https://example.test/pull/33",
  };
  const store = loadStore();
  store.tasks = [
    current, expired, task("task_blocked", "blocked", now), task("task_open", "open", now),
    task("task_done", "completed", now),
    ...Array.from({ length: 7 }, (_, i) => task(`task_review_${i}`, "in_review", i + 2)).reverse(),
  ];
  await saveStoreAtomic(store);
  const original = fs.readFileSync(getStoragePaths().DATA_FILE, "utf-8");
  const digest = getBoardDigest();
  assert.equal(digest.ok, true);
  assert.match(digest.summary, /Open: 2 · Active claims: 1/);
  assert.match(digest.summary, /Needs review \(7\)\ntask_review_0/);
  assert.match(digest.summary, /and 2 more/);
  assert.match(digest.summary, /Expired claims \(ready to reclaim\) \(1\)\ntask_expired/);
  assert.match(digest.summary, /Blocked \(1\)\ntask_blocked/);
  assert.match(digest.summary, /Git merge not verified\) \(1\)\ntask_done/);
  assert.doesNotMatch(digest.summary, /old-worker|pull\/33|task_review_6/);
  assert.equal(getBoardTask("alice", expired.id).data?.status, "open");
  assert.deepEqual(listBoardTasks("alice", { status: "claimed" }).data?.map(({ id }) => id), [current.id]);
  assert.equal(fs.readFileSync(getStoragePaths().DATA_FILE, "utf-8"), original);
});

test("VM MCP tool definitions include all 6 schemas without $schema", () => {
  const names = VM_MCP_TOOL_DEFINITIONS.map((t) => t.name);
  assert.deepEqual(names, [
    "vm_exec",
    "vm_read_output",
    "vm_read_file",
    "vm_write_file",
    "vm_list_workspace",
    "vm_screenshot",
  ]);
  for (const def of VM_MCP_TOOL_DEFINITIONS) {
    assert.equal("$schema" in def.inputSchema, false);
    assert.equal(def.inputSchema.type, "object");
  }
});

test("vm_exec and vm_read_output execute per-user commands, filter high-risk cmds, and enforce scope", async () => {
  const driver = new StubVmDriver();
  const vm = new VmManager({ customDriver: driver });
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  const runtime = new RuntimeManager({ router: null, bus, vm });
  setVmManagerForTesting(vm);
  setRuntimeManagerForTesting(runtime);

  const invalid = await vmExec("alice", { cmd: "" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "invalid_input");

  const blocked = await vmExec("alice", { cmd: "sudo rm -rf /" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "command_blocked");

  const runAlice = await vmExec("alice", { cmd: "echo-test", waitMs: 2000 });
  assert.equal(runAlice.ok, true);
  assert.equal(runAlice.data?.status, "finished");
  assert.equal(runAlice.data?.exitCode, 0);
  assert.match(runAlice.data?.stdout ?? "", /hello-alice/);
  assert.match(runAlice.data?.stderr ?? "", /warn-alice/);

  const readAlice = await vmReadOutput("alice", { runId: runAlice.data!.runId });
  assert.equal(readAlice.ok, true);
  assert.equal(readAlice.data?.status, "finished");
  assert.match(readAlice.data?.stdout ?? "", /hello-alice/);

  const incremental = await vmReadOutput("alice", {
    runId: runAlice.data!.runId,
    fromSeq: readAlice.data!.lastSeq,
  });
  assert.equal(incremental.ok, true);
  assert.equal(incremental.data?.output, "");

  // Bob must NEVER see Alice's run or output
  const crossUser = await vmReadOutput("bob", { runId: runAlice.data!.runId });
  assert.equal(crossUser.ok, false);
  assert.equal(crossUser.error, "scope_denied");
  assert.doesNotMatch(crossUser.summary, /hello-alice/);

  const badRun = await vmReadOutput("alice", { runId: "../escape" });
  assert.equal(badRun.ok, false);
  assert.equal(badRun.error, "invalid_input");
});

test("vm_write_file, vm_read_file, and vm_list_workspace stay in /workspace and isolate callers", async () => {
  const driver = new StubVmDriver();
  const vm = new VmManager({ customDriver: driver });
  const runtime = new RuntimeManager({ router: null, vm });
  setVmManagerForTesting(vm);
  setRuntimeManagerForTesting(runtime);

  // Path containment rejections
  for (const badPath of ["/etc/passwd", "../secret.txt", "/workspace/../etc/shadow", "a\\b"]) {
    assert.equal((await vmReadFile("alice", { path: badPath })).ok, false);
    assert.equal((await vmWriteFile("alice", { path: badPath, content: "x" })).ok, false);
    assert.equal((await vmListWorkspace("alice", { path: badPath })).ok, false);
  }
  assert.equal((await vmWriteFile("alice", { path: "/workspace", content: "x" })).error, "is_a_directory");

  // Symlink escape containment
  await vm.writeFile("alice", "/workspace/seed.txt", "ok");
  driver.symlink("alice", "/workspace/escape", "/etc/hosts");
  assert.equal((await vmReadFile("alice", { path: "/workspace/escape" })).error, "outside_workspace");
  assert.equal((await vmWriteFile("alice", { path: "/workspace/escape", content: "x" })).error, "outside_workspace");

  // Happy path + cross-user isolation
  const wrote = await vmWriteFile("alice", { path: "notes/hello.txt", content: "alice-secret" });
  assert.equal(wrote.ok, true);
  assert.equal(wrote.data?.path, "/workspace/notes/hello.txt");

  const readAlice = await vmReadFile("alice", { path: "/workspace/notes/hello.txt" });
  assert.equal(readAlice.ok, true);
  assert.equal(readAlice.data?.content, "alice-secret");

  const listedAlice = await vmListWorkspace("alice", { path: "/workspace/notes" });
  assert.equal(listedAlice.ok, true);
  assert.deepEqual(listedAlice.data?.entries.map((e) => e.name), ["hello.txt"]);

  // Binary omission
  await vm.writeFile("alice", "/workspace/bin.dat", Buffer.from([0, 1, 2, 3]).toString("binary"));
  const readBin = await vmReadFile("alice", { path: "/workspace/bin.dat" });
  assert.equal(readBin.ok, true);
  assert.equal(readBin.data?.binary, true);
  assert.equal(readBin.data?.content, undefined);

  // Bob's VM is completely isolated from Alice's files
  const bobRead = await vmReadFile("bob", { path: "/workspace/notes/hello.txt" });
  assert.equal(bobRead.ok, false);
  assert.equal(bobRead.error, "not_found");
  const bobList = await vmListWorkspace("bob", {});
  assert.equal(bobList.ok, true);
  assert.deepEqual(bobList.data?.entries, []);
});

test("vm_screenshot is caller-scoped, requires running VM, and cleans up unique scrot frames", async () => {
  const driver = new StubVmDriver();
  const vm = new VmManager({ customDriver: driver });
  const runtime = new RuntimeManager({ router: null, vm });
  setVmManagerForTesting(vm);
  setRuntimeManagerForTesting(runtime);

  // Neither Alice nor Bob has a running VM yet
  const cold = await vmScreenshot("alice", {});
  assert.equal(cold.ok, false);
  assert.equal(cold.error, "vm_not_running");

  // Start only Alice's VM
  await vm.writeFile("alice", "/workspace/init.txt", "1");

  const shotAlice = await vmScreenshot("alice", {});
  assert.equal(shotAlice.ok, true);
  assert.equal(shotAlice.data?.mimeType, "image/png");
  assert.equal(Buffer.from(shotAlice.data!.dataBase64, "base64").toString("utf8"), "png-for-alice");
  assert.equal(driver.scrotPaths.length, 1);
  assert.deepEqual(driver.removedPaths, driver.scrotPaths);
  await assert.rejects(vm.readFileBytes("alice", driver.scrotPaths[0], 1024));

  // Bob still does not have a running VM and cannot grab Alice's desktop
  const shotBob = await vmScreenshot("bob", {});
  assert.equal(shotBob.ok, false);
  assert.equal(shotBob.error, "vm_not_running");
  assert.equal(driver.scrotPaths.length, 1);
});

