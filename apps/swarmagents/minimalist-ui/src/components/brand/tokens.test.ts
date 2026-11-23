import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRAND_COLORS,
  BRAND_MOTION_MS,
  BRAND_SPACING,
  ICON_NAMES,
  STATUS_COLORS,
} from "./tokens";

test("brand palette matches BRAND.md exactly", () => {
  assert.equal(BRAND_COLORS.voidNavy, "#13192C");
  assert.equal(BRAND_COLORS.signalCyan, "#00D0F0");
  assert.equal(BRAND_COLORS.deepSignal, "#005080");
  assert.equal(BRAND_COLORS.ink, "#0B1020");
  assert.equal(BRAND_COLORS.paper, "#FFFFFF");
  assert.equal(BRAND_COLORS.mist, "#B4BED2");
});

test("icon set is the 13 hand-authored brand icons, unique", () => {
  assert.equal(ICON_NAMES.length, 13);
  assert.equal(new Set(ICON_NAMES).size, 13);
  for (const required of ["chat-bar", "vm-screen", "takeover", "settings", "play", "stop"]) {
    assert.ok((ICON_NAMES as readonly string[]).includes(required), `missing icon: ${required}`);
  }
});

test("motion timings are ordered and sane", () => {
  assert.ok(BRAND_MOTION_MS.fast < BRAND_MOTION_MS.base);
  assert.ok(BRAND_MOTION_MS.base < BRAND_MOTION_MS.slow);
  assert.ok(BRAND_MOTION_MS.slow <= 500, "brand motion stays under half a second");
});

test("spacing scale is a 4px ladder, strictly increasing", () => {
  const values = Object.values(BRAND_SPACING);
  for (const v of values) assert.equal(v % 4, 0);
  const sorted = [...values].sort((a, b) => a - b);
  assert.deepEqual(values, sorted);
});

test("status colors are valid hex", () => {
  for (const hex of Object.values(STATUS_COLORS)) {
    assert.match(hex, /^#[0-9A-F]{6}$/);
  }
});
