/**
 * v2-247 long trajectories: a --resume that the CLI rejects because the
 * session is gone from the VM (VM reset, session expiry) must not kill the
 * trajectory. When the CLI dies on the stale resume before doing any work,
 * runOnce drops the dead session and retries once fresh; when the session
 * dies after the agent already did work, the run errors instead — re-running
 * the prompt then could duplicate side effects.
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

const STALE_SESSION = "sess_stale_gone";

/** Fail claude calls that try to resume the stale session; replay otherwise. */
class StaleResumeDriver extends FakeVmDriver {
  calls: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    const resumeIdx = cmd.indexOf("--resume");
    if (resumeIdx >= 0 && cmd[resumeIdx + 1] === STALE_SESSION) {
      opts?.onStderr?.(`Error: unknown session '${STALE_SESSION}'\n`);
      return { exitCode: 1 };
    }
    return super.exec(handle, cmd, opts);
  }
}

/**
 * Same stale-session failure, but only after the agent already did work:
 * replay the init + assistant lines, then die with the unknown-session
 * error instead of a result event.
 */
class MidRunStaleDriver extends FakeVmDriver {
  calls: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    const resumeIdx = cmd.indexOf("--resume");
    if (resumeIdx >= 0 && cmd[resumeIdx + 1] === STALE_SESSION) {
      for (const line of FAKE_CLAUDE_TRANSCRIPT_LINES.slice(0, 3)) {
        opts?.onStdout?.(`${line}\n`);
      }
      opts?.onStderr?.(`Error: unknown session '${STALE_SESSION}'\n`);
      return { exitCode: 1 };
    }
    return super.exec(handle, cmd, opts);
  }
}

function hasResume(call: string[], sessionId: string): boolean {
  const idx = call.indexOf("--resume");
  return idx >= 0 && call[idx + 1] === sessionId;
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

// finalize() persists the session without awaiting the write, so poll
// until the store lands instead of asserting immediately.
async function waitForSession(userId: string): Promise<string | undefined> {
  for (let index = 0; index < 200; index++) {
    const session = getLastSession(userId);
    if (session) return session;
    await sleep(10);
  }
  throw new Error("timed out waiting for the session to persist");
}

test("stale --resume rejected at startup retries once fresh and finishes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-stale-resume-"));
  configureSessionPaths(path.join(dir, "session_store.json"));
  await clearLastSession("alice");

  const driver = new StaleResumeDriver();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });

  try {
    manager.start("alice", { prompt: "USER ASK stale", sessionId: STALE_SESSION });
    const runs = await waitForFinished(manager, "alice");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "finished");

    // Two claude invocations: the stale resume, then the fresh retry.
    assert.equal(driver.calls.length, 2);
    assert.equal(hasResume(driver.calls[0], STALE_SESSION), true);
    assert.equal(driver.calls[1].includes("--resume"), false);

    // The fresh run's session replaces the dead one in the store, so the
    // next run resumes the live session instead of the stale id.
    assert.equal(await waitForSession("alice"), "sess_fake_playtest");
  } finally {
    await clearLastSession("alice");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown-session error after work does not retry fresh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-stale-resume-mid-"));
  configureSessionPaths(path.join(dir, "session_store.json"));
  await clearLastSession("alice");

  const driver = new MidRunStaleDriver();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });

  try {
    manager.start("alice", { prompt: "USER ASK stale mid-run", sessionId: STALE_SESSION });
    const runs = await waitForFinished(manager, "alice");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "error");
    assert.match(runs[0].error ?? "", /unknown session/i);

    // Exactly one invocation: no fresh retry once the agent did work.
    assert.equal(driver.calls.length, 1);
    assert.equal(hasResume(driver.calls[0], STALE_SESSION), true);
  } finally {
    await clearLastSession("alice");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
