/**
 * The codebase context pack is injected into a run exactly once, and the
 * persisted run log records that injection.
 *
 * A run is driven end to end through RuntimeManager with the fake VM driver
 * replaying Claude's stream-json, and a scanner that serves a fixed map. The
 * two things the DoD cares about are asserted directly:
 *   - the run log has one `codebase.context.injected` event with a token count;
 *   - the pack actually rides in the system prompt passed to Claude.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { telemetryBus } from "../telemetry/bus";
import { getRunsDir } from "../telemetry/paths";
import { readRunEvents } from "../telemetry/run-log";
import { forgetCodebaseMap } from "../codebase/store";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import type { CodebaseMap, CodebaseRepoOption, CodebaseScan, CodebaseScanner } from "../codebase/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const REPO_ROOT = "/workspace/demo";

const SCAN: CodebaseScan = {
  repoRoot: REPO_ROOT,
  repoName: "demo",
  repoHash: "codebase-injection-test",
  generatedAt: new Date(0).toISOString(),
  gitHead: "head-1",
  files: [
    { path: "src/core.ts", bytes: 400, language: "TypeScript", exports: ["core"] },
    { path: "src/app.ts", bytes: 200, language: "TypeScript", imports: ["./core"] },
  ],
  churn: { "src/core.ts": 12 },
  packageJson: {
    scripts: { build: "tsc", test: "node --test" },
    devDependencies: { vitest: "^1.0.0" },
  },
};

function mapScanner(): CodebaseScanner {
  return {
    async scan(): Promise<CodebaseScan | null> {
      return SCAN;
    },
    async head(): Promise<string | undefined> {
      return SCAN.gitHead;
    },
    async publish(): Promise<void> {},
    async readMap(): Promise<CodebaseMap | null> {
      return null;
    },
    async listRepos(): Promise<CodebaseRepoOption[]> {
      return [{ repo: "demo", repoRoot: REPO_ROOT, name: "demo" }];
    },
    async selectedRepo(): Promise<string | null> {
      return REPO_ROOT;
    },
    async selectRepo(): Promise<void> {},
  };
}

/** Captures the argv Claude was spawned with. */
class CapturingDriver extends FakeVmDriver {
  calls: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") this.calls.push(cmd);
    return super.exec(handle, cmd, opts);
  }
}

async function waitFor(pred: () => boolean, steps = 400): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for the run to finish");
}

test("the pack is injected into the run once and appears in the run log", async () => {
  const userId = "inject-run-log-user";
  forgetCodebaseMap(userId, REPO_ROOT);

  const driver = new CapturingDriver();
  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: driver }),
    router: null,
    codebaseScanner: mapScanner(),
  });

  const started = manager.start(userId, { prompt: "Read the codebase map" });
  assert.equal(started.accepted, true);

  const events: Array<{ type?: string; data?: unknown }> = [];
  telemetryBus.subscribe(started.runId, 0, (event) => events.push(event));

  await waitFor(() => {
    const run = manager.list(userId).find((candidate) => candidate.runId === started.runId);
    return !!run && run.status !== "running" && run.status !== "queued";
  });

  const injected = events.filter((event) => event.type === "codebase.context.injected");
  assert.equal(injected.length, 1, "the pack must be injected exactly once per run");
  const data = injected[0].data as { tokenEstimate?: number };
  assert.ok(typeof data.tokenEstimate === "number" && data.tokenEstimate > 0);

  // The pack is really in the system prompt: --append-system-prompt <pack>.
  const call = driver.calls[0];
  assert.ok(call, "claude must have been spawned");
  const index = call.indexOf("--append-system-prompt");
  assert.ok(index >= 0, "--append-system-prompt must carry the pack");
  const appended = call[index + 1];
  assert.match(appended, /<codebase_context/);
  assert.match(appended, /src\/core\.ts/);

  // The persisted run log has the same single event (the terminal reads it).
  const logged = readRunEvents(started.runId, getRunsDir()!).filter(
    (event) => event.type === "codebase.context.injected",
  );
  assert.equal(logged.length, 1);

  forgetCodebaseMap(userId, REPO_ROOT);
});
