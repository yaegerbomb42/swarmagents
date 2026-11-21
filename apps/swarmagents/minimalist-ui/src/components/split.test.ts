import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs, tagOf, countOf } from "../testing/harness";
import {
  SplitHandle,
  clampSplitRatio,
  clampSplitRatioForWidth,
  splitChatWidthCss,
  splitChatWidthPx,
  splitRatioBounds,
  SPLIT_RATIO_DEFAULT,
} from "./ui";

test("clampSplitRatio sanitizes a stored ratio to [0.2, 0.8]", () => {
  assert.equal(clampSplitRatio(0.38), 0.38);
  assert.equal(clampSplitRatio(0.5), 0.5);
  assert.equal(clampSplitRatio(0.2), 0.2);
  assert.equal(clampSplitRatio(0.8), 0.8);
  assert.equal(clampSplitRatio(0.99), 0.8, "above the max clamps down");
  assert.equal(clampSplitRatio(0.01), 0.2, "below the min clamps up");
  assert.equal(clampSplitRatio(1.5), 0.8);
  assert.equal(clampSplitRatio(-1), 0.2);
  assert.equal(clampSplitRatio(Number.NaN), SPLIT_RATIO_DEFAULT, "NaN becomes the default");
  assert.equal(clampSplitRatio("junk"), SPLIT_RATIO_DEFAULT, "a non-number becomes the default");
  assert.equal(clampSplitRatio(undefined), SPLIT_RATIO_DEFAULT);
  assert.equal(clampSplitRatio(null), SPLIT_RATIO_DEFAULT);
});

test("splitRatioBounds keeps 480px for both panes", () => {
  // A 1416px row (1440px viewport less the main padding): 38% is feasible.
  const wide = splitRatioBounds(1416);
  assert.ok(wide.min <= 0.38 && 0.38 <= wide.max, "the default fits a wide row");
  assert.equal(wide.min, 480 / 1416);
  assert.equal(wide.max, (1416 - 480 - 12) / 1416);

  // A 1000px row (the 1024px breakpoint): barely any room to move.
  const narrow = splitRatioBounds(1000);
  assert.equal(narrow.min, 0.48);
  assert.equal(narrow.max, 0.508);
  assert.ok(narrow.min <= narrow.max);

  // Too narrow for both floors: the split sits in the middle.
  assert.deepEqual(splitRatioBounds(900), { min: 0.5, max: 0.5 });
  assert.deepEqual(splitRatioBounds(0), { min: 0.5, max: 0.5 });
  assert.deepEqual(splitRatioBounds(Number.NaN), { min: 0.5, max: 0.5 });
});

test("clampSplitRatioForWidth clamps a ratio to the feasible range for the row", () => {
  assert.equal(clampSplitRatioForWidth(0.38, 1416), 0.38);
  assert.equal(clampSplitRatioForWidth(0.1, 1416), 480 / 1416, "below the chat floor clamps up");
  assert.equal(clampSplitRatioForWidth(0.9, 1416), (1416 - 480 - 12) / 1416, "above the stage floor clamps down");
  assert.equal(clampSplitRatioForWidth(0.99, 1000), 0.508, "a wide drag on a narrow row stops at the stage floor");
  assert.equal(clampSplitRatioForWidth(0.01, 1000), 0.48, "a narrow drag on a narrow row stops at the chat floor");
  assert.equal(clampSplitRatioForWidth("junk", 1416), SPLIT_RATIO_DEFAULT);
});

test("splitChatWidthPx is the px width the CSS clamp resolves to", () => {
  assert.equal(splitChatWidthPx(1416, 0.38), 1416 * 0.38);
  assert.equal(splitChatWidthPx(1416, 0.1), 480, "the chat never goes below 480px");
  assert.equal(splitChatWidthPx(1416, 0.9), 1416 - 480 - 12, "the stage never goes below 480px");
  assert.equal(splitChatWidthPx(1000, 0.38), 480, "the default ratio floors at 480px on a narrow row");
  assert.equal(splitChatWidthPx(1000, 0.5), 500);
});

test("splitChatWidthCss is a clamp with a 480px floor and a stage-keeps-480px ceiling", () => {
  assert.equal(splitChatWidthCss(0.38), "clamp(480px, 38.0%, calc(100% - 492px))");
  assert.equal(splitChatWidthCss(0.5), "clamp(480px, 50.0%, calc(100% - 492px))");
  assert.equal(splitChatWidthCss(0.99), "clamp(480px, 80.0%, calc(100% - 492px))", "out of range clamps");
  assert.equal(splitChatWidthCss("junk"), "clamp(480px, 38.0%, calc(100% - 492px))", "unusable clamps to the default");
});

test("SplitHandle renders as a keyboard-operable vertical separator, hidden on narrow screens", () => {
  installBrowserStubs({ wide: true });
  const html = renderToStaticMarkup(
    React.createElement(SplitHandle, {
      containerRef: React.createRef<HTMLElement>(),
      chatRef: React.createRef<HTMLDivElement>(),
      ratio: 0.38,
      onRatioChange: () => {},
    }),
  );
  assert.equal(countOf(html, 'data-testid="split-handle"'), 1);
  const tag = tagOf(html, "split-handle");
  assert.match(tag, /role="separator"/);
  assert.match(tag, /aria-orientation="vertical"/);
  assert.match(tag, /aria-label="Resize chat and stage panels"/);
  assert.match(tag, /aria-valuenow="38"/);
  assert.match(tag, /aria-valuemin="20"/);
  assert.match(tag, /aria-valuemax="80"/);
  assert.match(tag, /tabindex="0"/i);
  assert.match(tag, /\bhidden\b/, "hidden below the wide breakpoint");
  assert.match(tag, /\blg:flex\b/, "shown at the wide breakpoint");
  assert.match(tag, /cursor-col-resize/);
});

test("SplitHandle reports the sanitized ratio in its aria value", () => {
  installBrowserStubs({ wide: true });
  const html = renderToStaticMarkup(
    React.createElement(SplitHandle, {
      containerRef: React.createRef<HTMLElement>(),
      chatRef: React.createRef<HTMLDivElement>(),
      ratio: 0.99,
      onRatioChange: () => {},
    }),
  );
  assert.match(tagOf(html, "split-handle"), /aria-valuenow="80"/, "an out-of-range ratio is clamped in the markup");
});
