/**
 * Post-run auto-commit gate tests: the hook fires only for a successful
 * run on an opted-in account, publishes the committer's result (including
 * filesCommitted) as a git.commit run event, and never throws — a commit
 * failure (e.g. a VM without a git identity) is data, not an exception.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { maybeAutoCommitAfterRun, type AutoCommitDeps } from "./auto-commit";
import type { GitCommitResult } from "../harness/git-committer";
import type { UserSettings } from "../providers/settings";

const ENABLED: UserSettings = { preferFreeProviders: true, gitAutoCommit: true };
const DISABLED: UserSettings = { preferFreeProviders: true };

const SUCCESS: GitCommitResult = {
  success: true,
  commitMessage: "feat(app): add the thing",
  filesCommitted: ["src/app.ts", "src/app.test.ts"],
  output: "[main abc1234] feat(app): add the thing",
};

function harness(settings: UserSettings, commit: AutoCommitDeps["commit"]) {
  const published: { runId: string; event: { type: string; data?: unknown } }[] = [];
  const deps: AutoCommitDeps = {
    commit,
    publish: (runId, event) => published.push({ runId, event }),
    settingsFor: () => settings,
  };
  return { deps, published };
}

test("fires after a successful run when enabled and publishes filesCommitted", async () => {
  const calls: string[] = [];
  const { deps, published } = harness(ENABLED, async (userId) => {
    calls.push(userId);
    return SUCCESS;
  });
  const ran = await maybeAutoCommitAfterRun(deps, { userId: "alice", runId: "run_1", exitCode: 0 });
  assert.equal(ran, true);
  assert.deepEqual(calls, ["alice"]);
  assert.equal(published.length, 1);
  assert.equal(published[0].runId, "run_1");
  assert.equal(published[0].event.type, "git.commit");
  assert.deepEqual(published[0].event.data, {
    success: true,
    commitMessage: "feat(app): add the thing",
    filesCommitted: ["src/app.ts", "src/app.test.ts"],
    output: "[main abc1234] feat(app): add the thing",
  });
});

test("does not fire when the setting is off (absent or false)", async () => {
  for (const settings of [DISABLED, { ...DISABLED, gitAutoCommit: false }]) {
    let called = false;
    const { deps, published } = harness(settings, async () => {
      called = true;
      return SUCCESS;
    });
    const ran = await maybeAutoCommitAfterRun(deps, { userId: "alice", runId: "run_1", exitCode: 0 });
    assert.equal(ran, false);
    assert.equal(called, false);
    assert.equal(published.length, 0);
  }
});

test("does not fire for a non-zero exit code", async () => {
  let called = false;
  const { deps, published } = harness(ENABLED, async () => {
    called = true;
    return SUCCESS;
  });
  const ran = await maybeAutoCommitAfterRun(deps, { userId: "alice", runId: "run_1", exitCode: 1 });
  assert.equal(ran, false);
  assert.equal(called, false);
  assert.equal(published.length, 0);
});

test("a commit failure is published, not thrown (e.g. missing git identity)", async () => {
  const failure: GitCommitResult = {
    success: false,
    commitMessage: "",
    filesCommitted: [],
    output: "git commit failed: Author identity unknown",
  };
  const { deps, published } = harness(ENABLED, async () => failure);
  const ran = await maybeAutoCommitAfterRun(deps, { userId: "alice", runId: "run_1", exitCode: 0 });
  assert.equal(ran, true);
  assert.deepEqual(published[0].event.data, {
    success: false,
    commitMessage: "",
    filesCommitted: [],
    output: "git commit failed: Author identity unknown",
  });
});

test("a throwing committer dep is converted to a published failure", async () => {
  const { deps, published } = harness(ENABLED, async () => {
    throw new Error("vm exec exploded");
  });
  const ran = await maybeAutoCommitAfterRun(deps, { userId: "alice", runId: "run_1", exitCode: 0 });
  assert.equal(ran, true);
  assert.deepEqual(published[0].event.data, {
    success: false,
    commitMessage: "",
    filesCommitted: [],
    output: "vm exec exploded",
  });
});

test("a throwing settings source closes the gate instead of throwing", async () => {
  const deps: AutoCommitDeps = {
    commit: async () => SUCCESS,
    publish: () => {
      throw new Error("publish must not be reached");
    },
    settingsFor: () => {
      throw new Error("settings unreadable");
    },
  };
  const ran = await maybeAutoCommitAfterRun(deps, { userId: "alice", runId: "run_1", exitCode: 0 });
  assert.equal(ran, false);
});
