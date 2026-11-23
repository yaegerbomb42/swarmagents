/**
 * RfbInputObserver tests (lib/desktop-proxy/rfb-input-observer.ts).
 *
 * The observer is the fail-open twin of RfbInputFilter: it frames
 * client->server RFB messages and decodes the input ones for the takeover
 * summarizer. These tests pin the wire decoding (pointer/key/clipboard),
 * partial-frame buffering, and the permanent-disable behavior on framing
 * surprises.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RfbInputObserver } from "./rfb-input-observer";

function pointer(mask: number, x: number, y: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = 5;
  b[1] = mask;
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  return b;
}

function key(down: boolean, keysym: number): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = down ? 1 : 0;
  b.writeUInt32BE(keysym, 4);
  return b;
}

function cutText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const b = Buffer.alloc(8 + payload.length);
  b[0] = 6;
  b.writeUInt32BE(payload.length, 4);
  payload.copy(b, 8);
  return b;
}

function framebufferUpdateRequest(): Buffer {
  const b = Buffer.alloc(10);
  b[0] = 3;
  b[1] = 1;
  return b;
}

test("rfb observer: pointer move, down, up, and wheel decode", () => {
  const observer = new RfbInputObserver();
  const events = observer.observe(
    Buffer.concat([
      pointer(0, 100, 50), // move
      pointer(1, 100, 50), // left down
      pointer(0, 100, 50), // left up
      pointer(8, 100, 50), // wheel up
      pointer(16, 100, 50), // wheel down
    ]),
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ["mouse_move", "mouse_down", "mouse_up", "mouse_wheel", "mouse_wheel"],
  );
  const down = events[1];
  assert.ok(down.kind === "mouse_down" && down.button === "left" && down.x === 100 && down.y === 50);
  const wheelUp = events[3];
  assert.ok(wheelUp.kind === "mouse_wheel" && wheelUp.deltaY < 0);
  const wheelDown = events[4];
  assert.ok(wheelDown.kind === "mouse_wheel" && wheelDown.deltaY > 0);
});

test("rfb observer: key events carry names, codes, and modifier state", () => {
  const observer = new RfbInputObserver();
  const events = observer.observe(
    Buffer.concat([
      key(true, 0xffe1), // Shift_L down
      key(true, 0x61), // 'a' down (shift held)
      key(false, 0x61), // 'a' up
      key(false, 0xffe1), // Shift_L up
      key(true, 0xff0d), // Return
    ]),
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ["key_down", "key_down", "key_up", "key_up", "key_down"],
  );
  const a = events[1];
  assert.ok(a.kind === "key_down" && a.key === "a" && a.code === "KeyA" && a.modifiers.shift === true);
  const ret = events[4];
  assert.ok(ret.kind === "key_down" && ret.key === "Enter" && ret.modifiers.shift === false);
});

test("rfb observer: clipboard payloads are never carried into events", () => {
  const observer = new RfbInputObserver();
  const events = observer.observe(cutText("hunter2-secret"));
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.ok(ev.kind === "clipboard_set" && ev.text === "");
});

test("rfb observer: non-input messages are framed and ignored", () => {
  const observer = new RfbInputObserver();
  const events = observer.observe(
    Buffer.concat([framebufferUpdateRequest(), pointer(0, 1, 2), framebufferUpdateRequest()]),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "mouse_move");
});

test("rfb observer: partial frames buffer across observe calls", () => {
  const observer = new RfbInputObserver();
  const full = pointer(1, 7, 9);
  assert.deepEqual(observer.observe(full.subarray(0, 3)), []);
  const events = observer.observe(full.subarray(3));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "mouse_down");
});

test("rfb observer: an unknown message type disables the observer permanently", () => {
  const observer = new RfbInputObserver();
  assert.deepEqual(observer.observe(Buffer.from([99, 0, 0])), []);
  // Even valid input afterwards is no longer decoded (framing is lost).
  assert.deepEqual(observer.observe(pointer(1, 1, 1)), []);
});
