/**
 * F4 — test-drive route: snapshot-first start, keep/rollback, auto-rollback
 * of failed drives, supersede of abandoned drives, and the active-run guard.
 * Runs against the fake VM driver + fake claude transcript (no Docker).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLibraryStoreDir } from "./user-store";
import { configureRunsDir } from "../telemetry/paths";
import { publishItem } from "./public-store";
import { updateTestDrive } from "./test-drive";
import { RuntimeManager } from "../runtime/manager";
import { VmManager, setVmManagerForTesting } from "../vm/manager";
import { setRuntimeManagerForTesting } from "../runtime/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { readRunReport } from "../runtime/run-report";
import { withUserLock } from "./test-drive-mutex";
import { POST as testDrivePOST, GET as testDriveGET } from "../../app/api/library/public/[id]/test-drive/route";
import { resetPublishRateLimit } from "./rate";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess_drive",
  model: "claude-sonnet-5-5",
});
const ASSISTANT = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_drive_1",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Trying the skill on a small example." }],
  },
});
const RESULT_OK = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "sess_drive",
  cost_usd: 0.01,
  duration_ms: 100,
  num_turns: 1,
});
const RESULT_FAIL = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  session_id: "sess_drive",
  cost_usd: 0.01,
  duration_ms: 100,
  num_turns: 1,
  is_error: true,
});

/** Fake claude transcript driver: "ok" finishes, "fail" errors, "slow" stalls. */
class DriveFakeVm extends FakeVmDriver {
  constructor(private readonly mode: "ok" | "fail" | "slow" = "ok") {
    super();
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") {
      if (this.mode === "slow") await sleep(800);
      opts?.onStdout?.(`${INIT}\n${ASSISTANT}\n`);
      opts?.onStdout?.(`${this.mode === "fail" ? RESULT_FAIL : RESULT_OK}\n`);
      // A failed claude must exit nonzero or the harness still calls the
      // run "finished" (a non-success result alone does not error it).
      return { exitCode: this.mode === "fail" ? 1 : 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

let libDir: string;
let runsDir: string;
let savedEnv: NodeJS.ProcessEnv;
let vmManager: VmManager;
let manager: RuntimeManager;

function setup(mode: "ok" | "fail" | "slow" = "ok"): void {
  const driver = new DriveFakeVm(mode);
  vmManager = new VmManager({ customDriver: driver });
  // Persist the bus or the run log is never written and the RunReporter
  // finalizes to nothing (see lib/runtime/run-reporter.ts).
  manager = new RuntimeManager({
    vm: vmManager,
    bus: new TelemetryBus({ persist: true, runsDir: () => runsDir }),
  });
  setVmManagerForTesting(vmManager);
  setRuntimeManagerForTesting(manager);
}

test.beforeEach(() => {
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-drive-lib-"));
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-drive-runs-"));
  configureLibraryStoreDir(libDir);
  configureRunsDir(runsDir);
  savedEnv = { ...process.env };
  delete process.env.SWARM_SERVER_MODE;
  delete process.env.SWARM_ADMIN_USERS;
  resetPublishRateLimit();
});

test.afterEach(() => {
  configureLibraryStoreDir(undefined);
  configureRunsDir(null);
  setVmManagerForTesting(null);
  setRuntimeManagerForTesting(null);
  resetPublishRateLimit();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(libDir, { recursive: true, force: true });
  fs.rmSync(runsDir, { recursive: true, force: true });
});

function publishSkill(): string {
  const record = publishItem(ALICE, {
    kind: "skill",
    name: "Try me",
    description: "A skill to test-drive",
    license: "MIT",
    payload: { kind: "skill", skillMd: "# Try me\n\nDo the thing.", files: [], requiredFields: [] },
  });
  return record.id;
}

function request(
  user: string,
  id: string,
  body: unknown,
  method = "POST",
): Request {
  return new Request(`http://localhost/api/library/public/${id}/test-drive`, {
    method,
    headers: { "content-type": "application/json", "x-swarm-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function getRequest(user: string, id: string, driveId?: string): Request {
  const url = `http://localhost/api/library/public/${id}/test-drive${driveId ? `?driveId=${driveId}` : ""}`;
  return new Request(url, { headers: { "x-swarm-user": user } });
}

async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

async function waitForReport(runId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readRunReport(runId)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for the run report of ${runId}`);
}

test("start snapshots first, finishes to awaiting-decision, rollback restores", async () => {
  setup("ok");
  const id = publishSkill();

  const res = await testDrivePOST(request(ALICE, id, { action: "start", prompt: "Try it on a hello file." }), {
    params: Promise.resolve({ id }),
  });
  assert.equal(res.status, 201);
  const body = await json(res);
  const drive = body.drive;
  assert.equal(drive.status, "running");
  assert.match(drive.snapshotLabel, /^test-drive-/);
  assert.equal(body.queued, false);

  // The pre-drive snapshot exists before the run writes anything.
  const snapshots = await vmManager.listSnapshots(ALICE);
  assert.ok(snapshots.some((snapshot) => snapshot.label === drive.snapshotLabel));

  // The drive run is marked as a test-drive, never a normal run.
  const history = manager.list(ALICE).find((run) => run.runId === drive.runId);
  assert.ok(history?.prompt.includes(`[test-drive:${id}]`));

  await waitForReport(drive.runId);
  const statusRes = await testDriveGET(getRequest(ALICE, id, drive.id), {
    params: Promise.resolve({ id }),
  });
  const status = await json(statusRes);
  assert.equal(status.drive.status, "awaiting-decision");
  assert.equal(status.drive.report.status, "finished");
  assert.equal(status.drive.report.costUsd, 0.01);
  assert.equal(status.drive.runStatus, "finished");

  const rollbackRes = await testDrivePOST(
    request(ALICE, id, { action: "rollback", driveId: drive.id }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(rollbackRes.status, 200);
  const rolled = await json(rollbackRes);
  assert.equal(rolled.drive.status, "rolled-back");
  assert.equal(rolled.drive.rollbackReason, "user");
});

test("keep preserves the post-drive state", async () => {
  setup("ok");
  const id = publishSkill();
  const started = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  await waitForReport(started.drive.runId);
  await testDriveGET(getRequest(ALICE, id, started.drive.id), { params: Promise.resolve({ id }) });
  const keepRes = await testDrivePOST(
    request(ALICE, id, { action: "keep", driveId: started.drive.id }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(keepRes.status, 200);
  const kept = await json(keepRes);
  assert.equal(kept.drive.status, "kept");
  // A second decision is refused.
  const again = await testDrivePOST(
    request(ALICE, id, { action: "rollback", driveId: started.drive.id }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(again.status, 409);
});

test("a failed drive run auto-rolls back on first status read", async () => {
  setup("fail");
  const id = publishSkill();
  const started = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  await waitForReport(started.drive.runId);
  const report = readRunReport(started.drive.runId);
  assert.equal(report?.status, "error");

  const status = await json(
    await testDriveGET(getRequest(ALICE, id, started.drive.id), { params: Promise.resolve({ id }) }),
  );
  assert.equal(status.drive.status, "rolled-back");
  assert.equal(status.drive.rollbackReason, "run-failed");
  assert.equal(status.drive.report.status, "error");
});

test("starting a new drive supersedes an abandoned awaiting-decision drive", async () => {
  setup("ok");
  const id = publishSkill();
  const first = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  await waitForReport(first.drive.runId);
  const firstStatus = await json(
    await testDriveGET(getRequest(ALICE, id, first.drive.id), { params: Promise.resolve({ id }) }),
  );
  assert.equal(firstStatus.drive.status, "awaiting-decision");

  const second = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  assert.equal(second.drive.status, "running");

  const abandoned = await json(
    await testDriveGET(getRequest(ALICE, id, first.drive.id), { params: Promise.resolve({ id }) }),
  );
  assert.equal(abandoned.drive.status, "rolled-back");
  assert.equal(abandoned.drive.rollbackReason, "superseded");
  await waitForReport(second.drive.runId);
});

test("start is refused while another run is active; keep is refused while driving", async () => {
  setup("slow");
  const id = publishSkill();
  // Hold the VM busy with a normal run first.
  const normal = manager.start(ALICE, { prompt: "normal work" });
  assert.equal(normal.accepted, true);

  const refused = await testDrivePOST(request(ALICE, id, { action: "start" }), {
    params: Promise.resolve({ id }),
  });
  assert.equal(refused.status, 409);
  assert.match((await json(refused)).error, /Finish or cancel your current run first/);

  // Let the normal run finish, then start a slow drive and try to keep early.
  await waitForReport(normal.runId);
  const started = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  assert.equal(started.drive.status, "running");
  const early = await testDrivePOST(
    request(ALICE, id, { action: "keep", driveId: started.drive.id }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(early.status, 409);
  await waitForReport(started.drive.runId);
});

test("drives are per-account and a missing item is a 404", async () => {
  setup("ok");
  const id = publishSkill();
  const started = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  const bob = await testDriveGET(getRequest(BOB, id, started.drive.id), {
    params: Promise.resolve({ id }),
  });
  assert.equal(bob.status, 404);
  const missing = await testDrivePOST(request(ALICE, "pub_missing", { action: "start" }), {
    params: Promise.resolve({ id: "pub_missing" }),
  });
  assert.equal(missing.status, 404);
  await waitForReport(started.drive.runId);
});

test("starting a drive when the run refuses leaves no drive behind", async () => {
  setup("ok");
  const id = publishSkill();
  // Fill the queue so the drive run cannot start: queue limit is 3 by
  // default; use a slow run plus three queued prompts.
  void manager.start(ALICE, { prompt: "busy 1" });
  // The first start above runs immediately; queue three more behind it.
  manager.start(ALICE, { prompt: "queued 1" });
  manager.start(ALICE, { prompt: "queued 2" });
  manager.start(ALICE, { prompt: "queued 3" });
  // The test-drive start is refused by the active-run guard first.
  const refused = await testDrivePOST(request(ALICE, id, { action: "start" }), {
    params: Promise.resolve({ id }),
  });
  assert.equal(refused.status, 409);
  const list = await json(await testDriveGET(getRequest(ALICE, id), { params: Promise.resolve({ id }) }));
  assert.equal(list.drives.length, 0);
});

/** Start a drive, let its run finish, and read it to awaiting-decision. */
async function finishedDrive(id: string): Promise<{ driveId: string; runId: string }> {
  const started = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  assert.equal(started.drive.status, "running");
  await waitForReport(started.drive.runId);
  const status = await json(
    await testDriveGET(getRequest(ALICE, id, started.drive.id), { params: Promise.resolve({ id }) }),
  );
  assert.equal(status.drive.status, "awaiting-decision");
  return { driveId: started.drive.id, runId: started.drive.runId };
}

/** Age a drive past the abandonment window (8 days). */
function ageDrive(driveId: string): void {
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
  updateTestDrive(driveId, { startedAt: old, finishedAt: old });
}

test("POST sweep rolls back a stale awaiting-decision drive", async () => {
  setup("ok");
  const id = publishSkill();
  const { driveId } = await finishedDrive(id);
  ageDrive(driveId);

  const swept = await testDrivePOST(request(ALICE, id, { action: "sweep" }), {
    params: Promise.resolve({ id }),
  });
  assert.equal(swept.status, 200);
  const body = await json(swept);
  assert.deepEqual(body.swept, [driveId]);
  assert.deepEqual(body.failed, []);

  const status = await json(
    await testDriveGET(getRequest(ALICE, id, driveId), { params: Promise.resolve({ id }) }),
  );
  assert.equal(status.drive.status, "rolled-back");
  assert.equal(status.drive.rollbackReason, "abandoned");
});

test("POST sweep leaves a fresh awaiting-decision drive alone", async () => {
  setup("ok");
  const id = publishSkill();
  const { driveId } = await finishedDrive(id);

  const swept = await testDrivePOST(request(ALICE, id, { action: "sweep" }), {
    params: Promise.resolve({ id }),
  });
  assert.equal(swept.status, 200);
  assert.deepEqual((await json(swept)).swept, []);

  const status = await json(
    await testDriveGET(getRequest(ALICE, id, driveId), { params: Promise.resolve({ id }) }),
  );
  assert.equal(status.drive.status, "awaiting-decision");
});

test("GET list sweeps a stale drive on read", async () => {
  setup("ok");
  const id = publishSkill();
  const { driveId } = await finishedDrive(id);
  ageDrive(driveId);

  const list = await json(await testDriveGET(getRequest(ALICE, id), { params: Promise.resolve({ id }) }));
  assert.equal(list.drives.length, 1);
  assert.equal(list.drives[0].status, "rolled-back");
  assert.equal(list.drives[0].rollbackReason, "abandoned");
});

test("a rejected params promise returns structured JSON, not a 500", async () => {
  setup("ok");
  const id = publishSkill();

  const post = await testDrivePOST(request(ALICE, id, { action: "start" }), {
    params: Promise.reject(new Error("bad params")),
  });
  assert.equal(post.status, 400);
  const postBody = (await post.json()) as { error?: string };
  assert.equal(typeof postBody.error, "string");

  const get = await testDriveGET(getRequest(ALICE, id), {
    params: Promise.reject(new Error("bad params")),
  });
  assert.equal(get.status, 400);
  const getBody = (await get.json()) as { error?: string };
  assert.equal(typeof getBody.error, "string");
});

test("two concurrent test-drive starts yield exactly one active run", async () => {
  setup("ok");
  const id = publishSkill();
  const start = () =>
    testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) });

  const [a, b] = await Promise.all([start(), start()]);
  const statuses = [a.status, b.status];
  const wins = statuses.filter((status) => status === 201);
  const losses = statuses.filter((status) => status === 409);
  assert.equal(wins.length, 1, `expected exactly one 201, got statuses ${statuses.join(", ")}`);
  assert.equal(losses.length, 1, `expected exactly one 409, got statuses ${statuses.join(", ")}`);

  // Exactly one drive run exists for this item; the losing start recorded nothing.
  const drives = manager.list(ALICE).filter((run) => run.prompt.includes(`[test-drive:${id}]`));
  assert.equal(drives.length, 1);
});

test("concurrent keep and rollback on the same drive cannot both win", async () => {
  setup("ok");
  const id = publishSkill();
  const started = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  await waitForReport(started.drive.runId);
  const driveId: string = started.drive.id;

  const [a, b] = await Promise.all([
    testDrivePOST(request(ALICE, id, { action: "keep", driveId }), { params: Promise.resolve({ id }) }),
    testDrivePOST(request(ALICE, id, { action: "rollback", driveId }), { params: Promise.resolve({ id }) }),
  ]);
  const statuses = [a.status, b.status].sort();
  // Exactly one wins (200); the other sees a drive that is no longer
  // awaiting-decision and gets a 409.
  assert.deepEqual(statuses, [200, 409], `expected one 200 and one 409, got ${statuses.join(", ")}`);

  const drive = await json(
    await testDriveGET(getRequest(ALICE, id, driveId), { params: Promise.resolve({ id }) }),
  );
  assert.ok(
    drive.drive.status === "kept" || drive.drive.status === "rolled-back",
    `drive must settle on one outcome, got ${drive.drive.status}`,
  );
});

test("GET and the sweep action wait for the user's Test-Drive lock", async () => {
  setup("ok");
  const id = publishSkill();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let holderDone = false;
  const holder = withUserLock(ALICE, async () => {
    await gate;
    holderDone = true;
  });

  // Both the GET (drive lookup + sweep + finalize happen under the lock, so
  // even the 404 waits) and the explicit sweep action must queue behind it:
  // a GET-driven restore that ignores the lock can wipe a drive the user is
  // keeping, and two overlapping sweeps can restore the same drive twice.
  let getDone = false;
  const fetched = testDriveGET(getRequest(ALICE, id, "drive_missing"), {
    params: Promise.resolve({ id }),
  }).then((res) => {
    getDone = true;
    return res;
  });
  let swept = false;
  const sweep = testDrivePOST(request(ALICE, id, { action: "sweep" }), {
    params: Promise.resolve({ id }),
  }).then((res) => {
    swept = true;
    return res;
  });

  await sleep(100);
  assert.equal(holderDone, false, "the lock should still be held");
  assert.equal(getDone, false, "GET must answer only after the lock is released");
  assert.equal(swept, false, "the sweep action must answer only after the lock is released");

  release();
  await Promise.all([holder, fetched, sweep]);
  assert.equal(getDone, true);
  assert.equal(swept, true);
});

test("an overlapping keep and sweep cannot restore over a kept drive", async () => {
  setup("ok");
  const id = publishSkill();
  const started = await json(
    await testDrivePOST(request(ALICE, id, { action: "start" }), { params: Promise.resolve({ id }) }),
  );
  await waitForReport(started.drive.runId);
  const driveId: string = started.drive.id;
  // Force the drive stale so the sweep considers it (default window: 7 days).
  updateTestDrive(driveId, { finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });

  const [keep, sweep] = await Promise.all([
    testDrivePOST(request(ALICE, id, { action: "keep", driveId }), { params: Promise.resolve({ id }) }),
    testDrivePOST(request(ALICE, id, { action: "sweep" }), { params: Promise.resolve({ id }) }),
  ]);
  assert.equal(keep.status, 200);

  const after = await json(
    await testDriveGET(getRequest(ALICE, id, driveId), { params: Promise.resolve({ id }) }),
  );
  assert.equal(
    after.drive.status,
    "kept",
    "the sweep, running after the keep finished, must not restore over a kept drive",
  );
  const sweptIds = await json(sweep);
  assert.deepEqual(sweptIds.swept, [], "nothing should be swept once the keep re-reads under the lock");
});
