/**
 * Unit tests for the stick-to-bottom helpers in useStickToBottom. The hook
 * itself only owns a scroll listener and a scrollTop side effect, so the
 * decision logic (is the pane at the bottom? pin it there?) is tested here
 * against plain geometry doubles — no DOM, no React renderer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STICK_TO_BOTTOM_THRESHOLD_PX,
  isNearBottom,
  scrollElementToBottom,
} from "./useStickToBottom";

/** Geometry for a pane whose content exactly fills the viewport. */
function exactFit() {
  return { scrollHeight: 400, scrollTop: 0, clientHeight: 400 };
}

test("content shorter than the viewport is always at the bottom", () => {
  // The q5 repro pane starts empty; nothing to scroll means stuck.
  assert.equal(isNearBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 400 }), true);
  assert.equal(isNearBottom(exactFit()), true);
});

test("scrolled fully to the bottom is near the bottom", () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
});

test("within the threshold of the bottom still counts as stuck", () => {
  // One line (or sub-pixel rounding) above the bottom must not unstick.
  const oneLineUp = { scrollHeight: 1000, scrollTop: 600 - 10, clientHeight: 400 };
  assert.equal(isNearBottom(oneLineUp), true);
  // Exactly at the threshold boundary is still stuck.
  const atThreshold = {
    scrollHeight: 1000,
    scrollTop: 600 - STICK_TO_BOTTOM_THRESHOLD_PX,
    clientHeight: 400,
  };
  assert.equal(isNearBottom(atThreshold), true);
});

test("scrolled up past the threshold is not at the bottom", () => {
  // The user scrolled up to read the middle of the `ls` output: the pane
  // must stop auto-scrolling and show "Jump to latest" instead.
  const midOutput = { scrollHeight: 1000, scrollTop: 200, clientHeight: 400 };
  assert.equal(isNearBottom(midOutput), false);
  // One pixel past the threshold already unsticks.
  const justPast = {
    scrollHeight: 1000,
    scrollTop: 600 - STICK_TO_BOTTOM_THRESHOLD_PX - 1,
    clientHeight: 400,
  };
  assert.equal(isNearBottom(justPast), false);
});

test("a custom threshold is honoured", () => {
  const el = { scrollHeight: 1000, scrollTop: 550, clientHeight: 400 };
  assert.equal(isNearBottom(el, 100), true);
  assert.equal(isNearBottom(el, 10), false);
});

test("scrollElementToBottom pins scrollTop to scrollHeight", () => {
  // After the run ends (run.finished appended) the pane must show the last
  // line — the separator and the cat result — not the middle of the output.
  const el = { scrollHeight: 1250, scrollTop: 200, clientHeight: 400 };
  scrollElementToBottom(el);
  assert.equal(el.scrollTop, 1250);
  // Pinning is idempotent: a second call at the bottom changes nothing.
  scrollElementToBottom(el);
  assert.equal(el.scrollTop, 1250);
});
