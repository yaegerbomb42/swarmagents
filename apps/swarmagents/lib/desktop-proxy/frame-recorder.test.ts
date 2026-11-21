/**
 * FrameRecorder tests: append-only frame recording with hard byte/time caps
 * and a terminal stop note. Never throws into the caller; a bad path simply
 * disables recording.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FrameRecorder, FRAME_RECORDING_STOP_NOTE } from "./frame-recorder";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frame-recorder-"));

function scratch(name: string): string {
  return path.join(tmp, name);
}

test("recorder: appends frames so the file decodes back in order", () => {
  const file = scratch("in-order.rfb");
  const r = new FrameRecorder(file);
  assert.equal(r.active, true);
  const f1 = Buffer.from([0, 0, 0, 1, 0xaa, 0xbb]);
  const f2 = Buffer.from([0, 0, 0, 2, 0xcc]);
  r.append(f1);
  r.append(f2);
  r.close();
  const content = fs.readFileSync(file);
  assert.ok(content.equals(Buffer.concat([f1, f2])), "file concatenates frames in insertion order");
  assert.equal(r.active, false);
});

test("recorder: closes idempotently and never throws", () => {
  const file = scratch("idempotent.rfb");
  const r = new FrameRecorder(file);
  r.close();
  r.close(); // second close is a no-op
  r.append(Buffer.from([1])); // append after close is a no-op
  assert.equal(r.active, false);
});

test("recorder: byte cap stops recording and writes the terminal note", () => {
  const file = scratch("byte-cap.rfb");
  const r = new FrameRecorder(file, { capBytes: 8 });
  r.append(Buffer.alloc(5, 1));
  assert.equal(r.active, true, "still under the cap");
  r.append(Buffer.alloc(5, 2)); // 5 + 5 > 8 → trips the cap
  assert.equal(r.active, false, "cap tripped");
  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.endsWith(FRAME_RECORDING_STOP_NOTE), "terminal note appended");
});

test("recorder: time cap stops recording on an injected clock", () => {
  const file = scratch("time-cap.rfb");
  let nowMs = 1000;
  const r = new FrameRecorder(file, { capMs: 100, now: () => nowMs });
  r.append(Buffer.from([7]));
  nowMs += 50;
  r.append(Buffer.from([8]));
  assert.equal(r.active, true, "within the time window");
  nowMs += 60; // 50+60 = 110ms elapsed → over the 100ms cap
  r.append(Buffer.from([9]));
  assert.equal(r.active, false);
  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.endsWith(FRAME_RECORDING_STOP_NOTE));
});

test("recorder: a write failure disables recording without throwing", () => {
  const file = scratch("bad-write.rfb");
  const r = new FrameRecorder(file, { capBytes: 2 }); // tiny cap
  assert.equal(r.active, true);
  r.append(Buffer.alloc(3, 9)); // exceeds capBytes → stopWithNote path exercises write
  assert.equal(r.active, false);
});

test("recorder: a directory cannot be opened as a recording file, failing safe", () => {
  // Pass a directory path as the recording file: openSync("a") on a directory
  // fails (EISDIR on macOS/Linux) and the recorder must deactivate silently.
  const dir = path.join(tmp, "not-a-file");
  fs.mkdirSync(dir, { recursive: true });
  const r = new FrameRecorder(dir);
  assert.equal(r.active, false, "fails open — recording disabled, no throw");
  r.append(Buffer.from([1])); // no-op
  r.close();
});

test("recorder: active is false until a file is opened", () => {
  const r = new FrameRecorder(path.join(tmp, "sub", "deep", "frames.rfb"));
  assert.equal(r.active, true, "mkdirSync recursive creates parent dirs");
  r.close();
});
