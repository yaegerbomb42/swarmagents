/**
 * g5: the project digest is injected exactly once — when a run starts a fresh
 * thread — and never when the prompt continues an existing harness session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager, type RunSummary } from "./manager";
import { configureSessionPaths, clearLastSession, getLastSession } from "./session-store";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { FAKE_CLAUDE_TRANSCRIPT_LINES } from "../vm/fake-claude";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class PromptCaptureDriver extends FakeVmDriver {
  calls: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    for (const line of FAKE_CLAUDE_TRANSCRIPT_LINES) opts?.onStdout?.(`${line}\n`);
    return { exitCode: 0 };
  }
}

function promptArg(call: string[]): string {
  return call.find((arg) => arg.includes("USER ASK")) ?? "";
}

async function waitForFinished(manager: RuntimeManager, userId: string): Promise<RunSummary[]> {
  for (let index = 0; index < 400; index++) {
    const runs = manager.list(userId);
    if (runs.length > 0 && runs.every((run) => run.status !== "running" && run.status !== "queued")) {
      return runs;
    }
    await sleep(10);
  }
  throw new Error("timed out waiting for the run to finish");
}

async function waitForSession(userId: string): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (getLastSession(userId)) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for the session to persist");
}

test("project context is injected on a fresh thread only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-project-context-"));
  configureSessionPaths(path.join(dir, "session_store.json"));
  await clearLastSession("alice");
  await clearLastSession("bob");

  const driver = new PromptCaptureDriver();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });

  try {
    // Fresh account + fresh thread: the digest rides in front of the ask.
    manager.start("alice", {
      prompt: "USER ASK one",
      projectId: "prj_12345678-1234-1234-1234-123456789012",
      projectContext: 'Previously… (project "atlas")\nOpen files: src/app.ts',
    });
    await waitForFinished(manager, "alice");
    await waitForSession("alice");
    assert.match(promptArg(driver.calls[0]), /^Previously…/);
    assert.match(promptArg(driver.calls[0]), /USER ASK one/);

    // Same account, no explicit session: the manager resumes the persisted
    // session, so the project digest must NOT be duplicated into the prompt.
    manager.start("alice", {
      prompt: "USER ASK two",
      projectId: "prj_12345678-1234-1234-1234-123456789012",
      projectContext: "Previously… SHOULD NOT APPEAR",
    });
    await waitForFinished(manager, "alice");
    assert.equal(promptArg(driver.calls[1]).includes("Previously…"), false);
    assert.match(promptArg(driver.calls[1]), /USER ASK two/);

    // Explicit session continuation: same rule.
    manager.start("alice", {
      prompt: "USER ASK three",
      sessionId: "sess_existing",
      projectContext: "Previously… SHOULD NOT APPEAR",
    });
    await waitForFinished(manager, "alice");
    assert.equal(promptArg(driver.calls[2]).includes("Previously…"), false);

    // Another account is a fresh thread again.
    manager.start("bob", {
      prompt: "USER ASK four",
      projectId: "prj_12345678-1234-1234-1234-123456789012",
      projectContext: 'Previously… (project "bob")',
    });
    await waitForFinished(manager, "bob");
    assert.match(promptArg(driver.calls[3]), /^Previously…/);
  } finally {
    await clearLastSession("alice");
    await clearLastSession("bob");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
