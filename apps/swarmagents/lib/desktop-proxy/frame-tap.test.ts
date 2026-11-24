/**
 * FrameTap tests: rect accumulation into the framebuffer shadow, damage
 * differencing, keyframe thresholds, throttling, fail-open disable, and
 * the KeyframeStore byte cap. Uses synthetic RFB FramebufferUpdate
 * messages in the proxy's 32bpp BGRA wire format (see rfb.ts serverInit).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { FrameTap, type FrameTapOptions } from "./frame-tap";
import { KeyframeStore } from "./takeover/keyframe-store";
import type { DiffResult } from "./takeover/diff";

/** One Raw rect update, uniform color, BGRA wire order. */
function rawUpdate(
  x: number,
  y: number,
  w: number,
  h: number,
  b: number,
  g: number,
  r: number,
): Buffer {
  const head = Buffer.alloc(4 + 12);
  head[0] = 0; // FramebufferUpdate
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(x, 4);
  head.writeUInt16BE(y, 6);
  head.writeUInt16BE(w, 8);
  head.writeUInt16BE(h, 10);
  head.writeInt32BE(0, 12); // Raw
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = b;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = r;
    px[i * 4 + 3] = 255;
  }
  return Buffer.concat([head, px]);
}

function copyUpdate(
  srcX: number,
  srcY: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Buffer {
  const head = Buffer.alloc(4 + 12 + 4);
  head[0] = 0;
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(x, 4);
  head.writeUInt16BE(y, 6);
  head.writeUInt16BE(w, 8);
  head.writeUInt16BE(h, 10);
  head.writeInt32BE(1, 12); // CopyRect
  head.writeUInt16BE(srcX, 16);
  head.writeUInt16BE(srcY, 18);
  return head;
}

function makeTap(extra: FrameTapOptions = {}) {
  let now = 1_000_000;
  const damages: Array<{ result: DiffResult; meta: { width: number; height: number; timestamp: number } }> = [];
  const tap = new FrameTap({
    now: () => now,
    minDiffIntervalMs: 100,
    storeOptions: { minIntervalMs: 0, retentionMs: 10 * 60 * 1000 },
    onDamage: (result, meta) => damages.push({ result, meta }),
    ...extra,
  });
  return {
    tap,
    damages,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

test("first frame is full damage and stores a keyframe", () => {
  const { tap, damages, now } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  assert.equal(damages.length, 1);
  assert.equal(damages[0]!.result.changedRatio, 1);
  const metas = tap.keyframes.listMeta(now());
  assert.equal(metas.length, 1);
  assert.equal(metas[0]!.width, 64);
  assert.equal(metas[0]!.height, 64);
  assert.equal(tap.stats.framesApplied, 1);
  assert.equal(tap.stats.keyframesStored, 1);
});

test("identical frame produces no damage and no keyframe", () => {
  const { tap, damages, advance, now } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  advance(200);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  assert.equal(damages.length, 1);
  assert.equal(tap.keyframes.listMeta(now()).length, 1);
  assert.equal(tap.stats.diffsRun, 2);
});

test("one-tile change yields one damage region; keyframe at threshold", () => {
  const { tap, damages, advance, now } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  advance(200);
  // 32x32 tile of a 64x64 frame = 0.25 changed ratio >= 0.02 default.
  tap.feed(rawUpdate(0, 0, 32, 32, 0, 0, 255));
  assert.equal(damages.length, 2);
  assert.equal(damages[1]!.result.regions.length, 1);
  assert.equal(damages[1]!.result.changedRatio, 0.25);
  assert.deepEqual(damages[1]!.result.regions[0], { x: 0, y: 0, width: 32, height: 32 });
  assert.equal(tap.keyframes.listMeta(now()).length, 2);
});

test("sub-threshold change damages but stores no keyframe; interval forces one", () => {
  const { tap, damages, advance, now } = makeTap();
  tap.setFramebufferSize(256, 256); // 64 tiles
  tap.feed(rawUpdate(0, 0, 256, 256, 10, 10, 10)); // keyframe (first frame)
  advance(200);
  // One tile = 1/64 ≈ 0.0156 < 0.02 threshold.
  tap.feed(rawUpdate(0, 0, 32, 32, 0, 0, 255));
  assert.equal(damages.length, 2);
  assert.equal(tap.keyframes.listMeta(now()).length, 1);
  // Past the 30s interval, the next change stores a keyframe anyway.
  advance(31_000);
  tap.feed(rawUpdate(32, 0, 32, 32, 0, 255, 0));
  assert.equal(tap.keyframes.listMeta(now()).length, 2);
});

test("CopyRect accumulates into the shadow (latestFrame is RGBA)", () => {
  const { tap, advance } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  advance(200);
  tap.feed(rawUpdate(0, 0, 32, 32, 0, 0, 255)); // red tile, BGRA
  advance(200);
  tap.feed(copyUpdate(0, 0, 32, 32, 32, 32));
  const frame = tap.latestFrame()!;
  const px = (x: number, y: number) => {
    const i = (y * 64 + x) * 4;
    return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2], frame.rgba[i + 3]];
  };
  assert.deepEqual(px(40, 40), [255, 0, 0, 255]); // copied red, RGBA order
  assert.deepEqual(px(8, 8), [255, 0, 0, 255]); // source unchanged
  assert.deepEqual(px(40, 8), [10, 10, 10, 255]); // untouched background
});

test("rects partially outside the framebuffer are clipped, not fatal", () => {
  const { tap, advance } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  advance(200);
  // 32x32 rect at (48,48) extends past the 64x64 framebuffer.
  tap.feed(rawUpdate(48, 48, 32, 32, 0, 0, 255));
  assert.equal(tap.disabled, false);
  const frame = tap.latestFrame()!;
  const i = (60 * 64 + 60) * 4;
  assert.equal(frame.rgba[i], 255);
});

test("diffing is throttled: rapid feeds drop diffs, never the compositor", () => {
  const { tap, advance } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  const before = { ...tap.stats };
  for (let i = 0; i < 5; i++) {
    tap.feed(rawUpdate(0, 0, 32, 32, i, 0, 255));
  }
  assert.equal(tap.stats.diffsRun - before.diffsRun, 0);
  assert.equal(tap.stats.diffsDropped - before.diffsDropped, 5);
  assert.equal(tap.stats.framesApplied - before.framesApplied, 5);
  // After the interval, the accumulated shadow diffs as one change.
  advance(200);
  tap.feed(rawUpdate(0, 0, 32, 32, 9, 0, 255));
  assert.equal(tap.stats.diffsRun - before.diffsRun, 1);
});

test("unsupported encoding disables the tap (fail-open), keeps last frame", () => {
  const { tap, advance } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  advance(200);
  const tight = Buffer.alloc(4 + 12);
  tight[0] = 0;
  tight.writeUInt16BE(1, 2);
  tight.writeUInt16BE(8, 8);
  tight.writeUInt16BE(8, 10);
  tight.writeInt32BE(7, 12); // Tight — the framing decoder cannot size it
  tap.feed(tight);
  assert.equal(tap.disabled, true);
  assert.match(tap.disableReason ?? "", /unsupported/);
  assert.ok(tap.latestFrame()); // last good frame still readable
  // Later feeds are ignored, never thrown.
  tap.feed(rawUpdate(0, 0, 64, 64, 1, 2, 3));
  assert.equal(tap.stats.framesApplied, 1);
});

test("feed before setFramebufferSize is ignored; resize resets the shadow", () => {
  const { tap, damages, advance } = makeTap();
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  assert.equal(tap.stats.framesApplied, 0);
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  assert.equal(damages.length, 1);
  advance(200);
  tap.setFramebufferSize(128, 64); // new geometry: shadow reset
  tap.feed(rawUpdate(0, 0, 128, 64, 10, 10, 10));
  assert.equal(damages.length, 2);
  assert.equal(damages[1]!.result.changedRatio, 1);
});

test("forceKeyframe stores on demand; null before any frame", () => {
  const { tap, now } = makeTap();
  assert.equal(tap.forceKeyframe("test"), null);
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  const before = tap.keyframes.listMeta(now()).length;
  const stored = tap.forceKeyframe("takeover");
  assert.ok(stored);
  assert.equal(stored!.meta.activity, "takeover");
  assert.equal(tap.keyframes.listMeta(now()).length, before + 1);
});

test("stored keyframes are structurally valid JPEGs", () => {
  const { tap } = makeTap();
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 30, 60, 90));
  const frame = tap.keyframes.getLatest()!;
  const jpg = frame.jpeg;
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8); // SOI
  assert.equal(jpg.at(-2), 0xff);
  assert.equal(jpg.at(-1), 0xd9); // EOI
  assert.equal(Buffer.from(jpg.subarray(6, 11)).toString("latin1"), "JFIF\0");
  // SOF0 (FF C0) carries height then width.
  let sof = -1;
  for (let i = 0; i + 1 < jpg.length; i++) {
    if (jpg[i] === 0xff && jpg[i + 1] === 0xc0) {
      sof = i;
      break;
    }
  }
  assert.ok(sof > 0, "SOF0 marker present");
  assert.equal((jpg[sof + 5]! << 8) | jpg[sof + 6]!, 64); // height
  assert.equal((jpg[sof + 7]! << 8) | jpg[sof + 8]!, 64); // width
});

test("a throwing onDamage callback does not break the tap", () => {
  const { tap, now } = makeTap({
    onDamage: () => {
      throw new Error("boom");
    },
  });
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  assert.equal(tap.disabled, false);
  assert.equal(tap.keyframes.listMeta(now()).length, 1);
});

test("store min-interval gates keyframes even when damage is large", () => {
  const { tap, advance, now } = makeTap({
    storeOptions: { minIntervalMs: 2_000, retentionMs: 10 * 60 * 1000 },
  });
  tap.setFramebufferSize(64, 64);
  tap.feed(rawUpdate(0, 0, 64, 64, 10, 10, 10));
  advance(500); // diff runs (throttle is 100ms) but store min-interval blocks
  tap.feed(rawUpdate(0, 0, 64, 64, 200, 0, 0));
  assert.equal(tap.keyframes.listMeta(now()).length, 1);
  advance(2_000);
  tap.feed(rawUpdate(0, 0, 64, 64, 0, 200, 0));
  assert.equal(tap.keyframes.listMeta(now()).length, 2);
});

test("KeyframeStore evicts oldest at the byte cap and rejects oversized frames", () => {
  const store = new KeyframeStore({
    minIntervalMs: 0,
    maxFrames: 100,
    maxBytes: 10,
    retentionMs: 1_000_000_000,
  });
  const six = new Uint8Array(6).fill(1);
  assert.ok(store.maybeStore(six, 8, 8, "a", 1000));
  assert.ok(store.maybeStore(six, 8, 8, "b", 1001)); // evicts the first
  assert.equal(store.listMeta(1001).length, 1);
  assert.equal(store.bytesHeld(1001), 6);
  assert.equal(store.maybeStore(new Uint8Array(11), 8, 8, "c", 1002), null);
  assert.equal(store.listMeta(1002).length, 1);
});

test("KeyframeStore count cap still applies alongside the byte cap", () => {
  const store = new KeyframeStore({
    minIntervalMs: 0,
    maxFrames: 2,
    maxBytes: 1_000_000,
    retentionMs: 1_000_000_000,
  });
  const tiny = new Uint8Array(3).fill(7);
  store.maybeStore(tiny, 2, 2, "a", 1000);
  store.maybeStore(tiny, 2, 2, "b", 1001);
  store.maybeStore(tiny, 2, 2, "c", 1002);
  assert.equal(store.listMeta(1002).length, 2);
});
