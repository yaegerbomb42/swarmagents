/**
 * Decoder tests for the desktop replay played in run reports: Raw and CopyRect
 * rectangles reconstruct the framebuffer, and a capped/truncated recording
 * keeps every complete frame playable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReplayUpdate,
  createReplayFramebuffer,
  parseDesktopReplay,
} from "./desktop-replay";

interface TestRect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: number;
  payload: number[];
}

function fbu(rects: TestRect[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0, 0, rects.length >>> 8 & 0xff, rects.length & 0xff])];
  for (const rect of rects) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(rect.x, 0);
    header.writeUInt16BE(rect.y, 2);
    header.writeUInt16BE(rect.width, 4);
    header.writeUInt16BE(rect.height, 6);
    header.writeUInt32BE(rect.encoding, 8);
    parts.push(header, Buffer.from(rect.payload));
  }
  return Buffer.concat(parts);
}

test("raw rectangles decode RFB's little-endian BGRX pixels", () => {
  const bytes = fbu([
    { x: 0, y: 0, width: 2, height: 1, encoding: 0, payload: [0, 0, 255, 0, 0, 255, 0, 0] },
  ]);
  const updates = parseDesktopReplay(bytes);
  assert.equal(updates.length, 1, "one complete framebuffer update");
  const frame = createReplayFramebuffer(2, 1);
  applyReplayUpdate(frame, 2, 1, updates[0], bytes);
  assert.deepEqual([...frame], [255, 0, 0, 255, 0, 255, 0, 255]);
});

test("copy rects replay damage without resending pixels", () => {
  const bytes = Buffer.concat([
    fbu([{ x: 0, y: 0, width: 1, height: 1, encoding: 0, payload: [0, 0, 255, 0] }]),
    fbu([{ x: 1, y: 0, width: 1, height: 1, encoding: 1, payload: [0, 0, 0, 0] }]),
  ]);
  const updates = parseDesktopReplay(bytes);
  assert.equal(updates.length, 2);
  const frame = createReplayFramebuffer(2, 1);
  for (const update of updates) applyReplayUpdate(frame, 2, 1, update, bytes);
  assert.deepEqual([...frame], [255, 0, 0, 255, 255, 0, 0, 255]);
});

test("a truncated tail or unknown encoding leaves earlier frames playable", () => {
  const good = fbu([{ x: 0, y: 0, width: 1, height: 1, encoding: 0, payload: [1, 2, 3, 0] }]);
  assert.equal(parseDesktopReplay(Buffer.concat([good, Buffer.from([0, 0, 0, 1])])).length, 1);
  assert.equal(
    parseDesktopReplay(
      Buffer.concat([
        good,
        fbu([{ x: 0, y: 0, width: 1, height: 1, encoding: 99, payload: [] }]),
      ]),
    ).length,
    1,
  );
  assert.deepEqual([...parseDesktopReplay(Buffer.from([2, 0, 0, 0]))], []);
});
