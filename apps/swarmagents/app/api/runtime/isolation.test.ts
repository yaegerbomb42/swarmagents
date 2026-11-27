/**
 * Cross-user isolation regression suite for runtime routes (h3).
 *
 * Proves that User B can never read, control, approve, or cancel User A's
 * runs, logs, streams, browser frames, VM files, VM snapshots, or shell execs,
 * and that a forged x-swarm-user header without a valid session cookie is
 * rejected by middleware in server mode.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import { VmManager, setVmManagerForTesting } from "../../../lib/vm/manager";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import { createRouter } from "../../../lib/providers";
import { getApprovalStore } from "../../../lib/harness/approvals";
import { configureSessionPaths } from "../../../lib/runtime/session-store";
import { GET as getStream } from "./stream/[runId]/route";
import { GET as getRuns } from "./runs/route";
import { GET as getRun } from "./runs/[id]/route";
import { GET as getRunLog } from "./runs/[id]/log/route";
import { GET as getBrowser } from "./browser/[runId]/route";
import { GET as getBrowserFrame } from "./browser/[runId]/frame/route";
import { POST as postApproval } from "./approvals/[id]/route";
import { GET as getVmFiles } from "./vm/files/route";
import { GET as getVmSnapshots, POST as postVmSnapshots } from "./vm/snapshots/route";
import { DELETE as deleteVmExec } from "./vm/exec/route";
import { DELETE as deleteTask, POST as postTask } from "./tasks/route";

const USER_A = "iso-user-a";
const USER_B = "iso-user-b";

function req(url: string, user: string | null, init: { method?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

test("cross-user isolation across runtime routes and forged header rejection", async (t) => {
  const prevSecret = process.env.SWARM_SESSION_SECRET;
  const prevMode = process.env.SWARM_SERVER_MODE;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-h3-iso-"));
  configureSessionPaths(tmpDir);

  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver, warmPoolSize: 0 });
  const manager = new RuntimeManager({
    vm,
    router: createRouter(),
  });
  setVmManagerForTesting(vm);
  setRuntimeManagerForTesting(manager);

  t.after(() => {
    setRuntimeManagerForTesting(null);
    setVmManagerForTesting(null);
    if (prevSecret === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = prevSecret;
    if (prevMode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = prevMode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Create User A's run, file, snapshot, and approval.
  const startRes = await postTask(
    req("http://localhost/api/runtime/tasks", USER_A, {
      method: "POST",
      body: { prompt: "Write a secret report", fullAuto: true },
    }),
  );
  assert.equal(startRes.status, 201);
  const { runId } = (await startRes.json()) as { runId: string };
  assert.ok(runId);

  await vm.writeFile(USER_A, "/workspace/secret-a.txt", "TOP_SECRET_A");
  const snapA = await vm.snapshot(USER_A, "snap-a");

  const approvalTicket = getApprovalStore().create({
    runId,
    userId: USER_A,
    toolName: "Bash",
    action: "echo hi",
    reason: "test",
  });

  // 2. User B cannot access User A's stream, run, log, browser, or approval.
  const streamB = await getStream(req(`http://localhost/api/runtime/stream/${runId}`, USER_B), {
    params: Promise.resolve({ runId }),
  });
  assert.equal(streamB.status, 404);

  const runsB = await getRuns(req("http://localhost/api/runtime/runs", USER_B));
  assert.equal(runsB.status, 200);
  const runsBJson = (await runsB.json()) as { runs: Array<{ runId: string }> };
  assert.equal(runsBJson.runs.some((r) => r.runId === runId), false, "User B must never see User A's run");

  const runB = await getRun(req(`http://localhost/api/runtime/runs/${runId}`, USER_B), {
    params: Promise.resolve({ id: runId }),
  });
  assert.equal(runB.status, 404);

  const logB = await getRunLog(req(`http://localhost/api/runtime/runs/${runId}/log`, USER_B), {
    params: Promise.resolve({ id: runId }),
  });
  assert.equal(logB.status, 404);

  const browserB = await getBrowser(req(`http://localhost/api/runtime/browser/${runId}`, USER_B), {
    params: Promise.resolve({ runId }),
  });
  assert.equal(browserB.status, 404);

  const frameB = await getBrowserFrame(req(`http://localhost/api/runtime/browser/${runId}/frame`, USER_B), {
    params: Promise.resolve({ runId }),
  });
  assert.equal(frameB.status, 404);

  const approveB = await postApproval(
    req(`http://localhost/api/runtime/approvals/${approvalTicket.id}`, USER_B, {
      method: "POST",
      body: { decision: "approve" },
    }),
    { params: Promise.resolve({ id: approvalTicket.id }) },
  );
  assert.equal(approveB.status, 404);

  // 3. User B cannot list/read User A's VM files or see/restore User A's snapshots.
  const filesListB = await getVmFiles(req("http://localhost/api/runtime/vm/files?path=/workspace", USER_B));
  assert.equal(filesListB.status, 200);
  const filesBodyB = await filesListB.text();
  assert.equal(filesBodyB.includes("secret-a.txt"), false, "User B must not see User A's files");

  const fileReadB = await getVmFiles(req("http://localhost/api/runtime/vm/files?path=/workspace/secret-a.txt&mode=read", USER_B));
  assert.notEqual(fileReadB.status, 200);
  assert.equal((await fileReadB.text()).includes("TOP_SECRET_A"), false);

  const snapsB = await getVmSnapshots(req("http://localhost/api/runtime/vm/snapshots", USER_B));
  assert.equal(snapsB.status, 200);
  assert.equal((await snapsB.text()).includes(snapA.label), false, "User B must not see User A's snapshot");

  const restoreB = await postVmSnapshots(
    req("http://localhost/api/runtime/vm/snapshots", USER_B, {
      method: "POST",
      body: { action: "restore", label: snapA.label },
    }),
  );
  assert.notEqual(restoreB.status, 200);

  // 4. User B cannot cancel User A's shell exec or task run.
  const execCancelB = await deleteVmExec(req(`http://localhost/api/runtime/vm/exec?runId=${runId}`, USER_B, { method: "DELETE" }));
  assert.equal(execCancelB.status, 404);

  const taskCancelB = await deleteTask(req(`http://localhost/api/runtime/tasks?runId=${runId}`, USER_B, { method: "DELETE" }));
  assert.equal(taskCancelB.status, 404);

  // 5. Unauthenticated requests get 401.
  assert.equal((await getRuns(req("http://localhost/api/runtime/runs", null))).status, 401);
  assert.equal((await getStream(req(`http://localhost/api/runtime/stream/${runId}`, null), { params: Promise.resolve({ runId }) })).status, 401);

  // 6. Forged x-swarm-user without a valid session cookie is rejected by middleware in server mode.
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_SESSION_SECRET = "test-isolation-secret-32-chars-minimum";
  const forged = await middleware(
    new NextRequest("http://localhost/api/runtime/runs", {
      method: "GET",
      headers: { "x-swarm-user": USER_A },
    }),
  );
  assert.ok(forged.status === 401 || forged.status === 403, `expected 401/403 for forged header, got ${forged.status}`);
});

test.todo("display (l3) cross-user isolation route test once landed");
test.todo("pty (l6) cross-user isolation route test once landed");
