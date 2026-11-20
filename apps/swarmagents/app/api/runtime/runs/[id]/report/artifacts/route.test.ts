/**
 * Artifact download gate (VM-10 / Bug 27): a report artifact path is only
 * readable while it resolves inside /workspace. A workspace symlink swapped to
 * /etc or /proc/1/environ must not turn the allowlist into an arbitrary read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { configureRunsDir } from "../../../../../../../lib/telemetry/paths";
import { VmManager, setVmManagerForTesting } from "../../../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../../../lib/vm/fake-driver";

const USER = "artifact-owner@example.com";
const RUN_ID = "run_artifact_symlink";

let runsDir: string;

/** Write a minimal report the artifacts route can load. */
function writeReport(artifacts: Array<{ rel: string; size: number }>): void {
  const dir = path.join(runsDir, "reports", RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "report.json"),
    JSON.stringify({
      runId: RUN_ID,
      userId: USER,
      artifacts: artifacts.map((a) => ({
        path: `/workspace/${a.rel}`,
        rel: a.rel,
        size: a.size,
        mtimeMs: 0,
        change: "created",
      })),
    }),
    "utf8",
  );
}

function request(rel: string, user: string | null = USER): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(
    `http://localhost/api/runtime/runs/${RUN_ID}/report/artifacts?path=${encodeURIComponent(rel)}`,
    { headers },
  );
}

function ctx(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: RUN_ID }) };
}

test.beforeEach(() => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-artifact-route-"));
  configureRunsDir(runsDir);
});

test.afterEach(() => {
  setVmManagerForTesting(null);
  configureRunsDir(null);
  fs.rmSync(runsDir, { recursive: true, force: true });
});

test("refuses an artifact whose workspace path is a symlink outside /workspace", async () => {
  const driver = new FakeVmDriver();
  setVmManagerForTesting(new VmManager({ customDriver: driver }));
  const handle = await driver.ensure(USER);
  await driver.writeFile(handle, "/etc/passwd", "root:x:0:0:root:/root:/bin/bash");
  driver.symlink(USER, "/workspace/link", "/etc");
  writeReport([{ rel: "link/passwd", size: 10 }]);

  const res = await GET(request("link/passwd"), ctx());
  assert.equal(res.status, 403);
  const text = await res.text();
  assert.match(text, /outside the workspace/i);
  assert.equal(text.includes("root:x:0"), false);
});

test("serves a normal workspace artifact", async () => {
  const driver = new FakeVmDriver();
  setVmManagerForTesting(new VmManager({ customDriver: driver }));
  const handle = await driver.ensure(USER);
  await driver.writeFile(handle, "/workspace/ok.txt", "artifact bytes");
  writeReport([{ rel: "ok.txt", size: 14 }]);

  const res = await GET(request("ok.txt"), ctx());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "artifact bytes");
});

test("a path that is not in the report's artifact list is refused", async () => {
  const driver = new FakeVmDriver();
  setVmManagerForTesting(new VmManager({ customDriver: driver }));
  const handle = await driver.ensure(USER);
  await driver.writeFile(handle, "/workspace/secret.txt", "not an artifact");
  writeReport([{ rel: "ok.txt", size: 14 }]);

  const res = await GET(request("secret.txt"), ctx());
  assert.equal(res.status, 404);
});

test("another user cannot download the artifact", async () => {
  const driver = new FakeVmDriver();
  setVmManagerForTesting(new VmManager({ customDriver: driver }));
  const handle = await driver.ensure(USER);
  await driver.writeFile(handle, "/workspace/ok.txt", "artifact bytes");
  writeReport([{ rel: "ok.txt", size: 14 }]);

  const res = await GET(request("ok.txt", "someone-else@example.com"), ctx());
  assert.equal(res.status, 404);
});
