/**
 * Tests for attaching the desktop proxy's frame recordings to run reports:
 * session order is preserved, replay bytes land under the report, unrelated
 * recordings are never swept into someone else's run, and sources are cleaned.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DESKTOP_REPLAY_FILE } from "./run-report-types";
import { attachDesktopReplay, desktopRecordingName, desktopReplayDir } from "./desktop-replay";

function tempRunsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desktop-replay-attach-"));
}

test("session recordings are concatenated in session order and cleaned up", () => {
  const runsDir = tempRunsDir();
  try {
    const dir = path.join(runsDir, "replays");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, desktopRecordingName("run_1", 10)), Buffer.from("second"));
    fs.writeFileSync(path.join(dir, desktopRecordingName("run_1", 2)), Buffer.from("first"));
    const unrelated = path.join(dir, desktopRecordingName("run_1evil", 1));
    fs.writeFileSync(unrelated, Buffer.from("not this run"));

    const meta = attachDesktopReplay("run_1", runsDir);
    assert.ok(meta, "replay metadata was produced");
    assert.equal(meta.file, DESKTOP_REPLAY_FILE);
    assert.equal(meta.mime, "application/octet-stream");
    assert.equal(meta.size, Buffer.byteLength("firstsecond"));
    assert.equal(meta.width, 1600);
    assert.equal(meta.height, 900);
    assert.equal(fs.readFileSync(path.join(runsDir, "reports", "run_1", DESKTOP_REPLAY_FILE), "utf8"), "firstsecond");
    assert.equal(fs.existsSync(path.join(dir, desktopRecordingName("run_1", 2))), false);
    assert.equal(fs.existsSync(unrelated), true, "another run's recording is untouched");
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("a run nobody watched has no replay", () => {
  const runsDir = tempRunsDir();
  try {
    assert.equal(attachDesktopReplay("run_1", runsDir), undefined);
    assert.equal(attachDesktopReplay("run_1", null), undefined);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("the proxy's recording dir (desktopReplayDir) is exactly where attach looks", () => {
  const runsDir = tempRunsDir();
  try {
    // instrumentation.ts hands desktopReplayDir(runsDir) to the proxy, and the
    // frame recorder mkdirs its parent; mirror that here.
    const recording = path.join(desktopReplayDir(runsDir), desktopRecordingName("run_rt", 1));
    fs.mkdirSync(path.dirname(recording), { recursive: true });
    fs.writeFileSync(recording, Buffer.from("frames"));
    const meta = attachDesktopReplay("run_rt", runsDir);
    assert.equal(meta?.size, Buffer.byteLength("frames"));
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
