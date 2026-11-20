import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASCOT_SHEET, framePosition, stillFrameFor, type MascotState } from "./frames";

// The project compiles TSX with the classic JSX transform outside Next, so the
// component modules expect a React global when node:test imports them.
(globalThis as unknown as { React: typeof React }).React = React;

async function renderMascot(props: Record<string, unknown>): Promise<string> {
  const { Mascot } = await import("./Mascot");
  return renderToStaticMarkup(React.createElement(Mascot, props));
}

const STATES: MascotState[] = ["hello", "idle", "working", "attention"];

test("each state renders its sprite sheet frame", async () => {
  for (const state of STATES) {
    const html = await renderMascot({ state, reducedMotion: true });
    const frame = stillFrameFor(state);
    assert.ok(html.includes(`data-frame="${frame}"`), `${state} should show frame ${frame}`);
    assert.ok(html.includes(`data-mascot-state="${state}"`), `${state} state attr`);
    assert.ok(html.includes(MASCOT_SHEET), `${state} uses the sprite sheet`);
  }
});

test("the sprite is a single 192:153 frame positioned in the 8x8 grid", async () => {
  const html = await renderMascot({ state: "attention", size: 96, reducedMotion: true });
  const { col, row } = framePosition(stillFrameFor("attention"));
  const frameHeight = Math.round((96 * 153) / 192); // 77
  assert.ok(html.includes(`background-image:url(${MASCOT_SHEET})`), "background image");
  assert.ok(html.includes(`background-size:${96 * 8}px ${frameHeight * 8}px`), "sheet scaled 8x");
  assert.ok(
    html.includes(`background-position:${-col * 96}px ${-row * frameHeight}px`),
    "frame offset",
  );
  assert.ok(html.includes("image-rendering:pixelated"), "pixel-crisp scaling");
});

test("the mascot is aria-hidden unless it has a status label", async () => {
  const hidden = await renderMascot({ state: "idle", reducedMotion: true });
  assert.ok(hidden.includes('data-testid="mascot"'), "wrapper exists");
  assert.ok(hidden.includes('aria-hidden="true"'), "wrapper is hidden");
  assert.ok(hidden.includes('data-testid="mascot-sprite"'), "sprite exists");

  const labelled = await renderMascot({ state: "working", label: "Jimmy is working.", reducedMotion: true });
  const wrapperTag = /<span[^>]*data-testid="mascot"[^>]*>/.exec(labelled)?.[0] ?? "";
  assert.ok(wrapperTag.length > 0, "wrapper tag found");
  assert.ok(!wrapperTag.includes("aria-hidden"), "wrapper is readable");
  assert.ok(labelled.includes('class="sr-only"'), "visually hidden label");
  assert.ok(labelled.includes("Jimmy is working."), "label text");
});

test("an onClick renders a labelled button and a still-hidden sprite", async () => {
  const html = await renderMascot({
    state: "idle",
    onClick: () => {},
    clickLabel: "Click Jimmy to wave hello",
    reducedMotion: true,
  });
  assert.ok(html.includes("<button"), "click target is a button");
  assert.ok(html.includes('aria-label="Click Jimmy to wave hello"'));
  assert.ok(html.includes('data-testid="mascot-sprite"'));
  assert.ok(html.includes('aria-hidden="true"'), "sprite is hidden from assistive tech");
});

test("reduced motion pins the still frame and drops the entrance transition", async () => {
  const reduced = await renderMascot({ state: "working", reducedMotion: true });
  assert.ok(reduced.includes('data-mascot-reduced="true"'));
  assert.ok(reduced.includes('data-frame="24"'), "working still frame");
  assert.ok(reduced.includes("transition:none"), "no entrance animation");
  assert.ok(reduced.includes("opacity:1"), "final pose is visible immediately");
  assert.ok(!reduced.includes("opacity:0"), "no hidden first paint");
});

test("motion is enabled by default (browser path)", async () => {
  const animated = await renderMascot({ state: "idle" });
  assert.ok(animated.includes('data-mascot-reduced="false"'));
  assert.ok(animated.includes("opacity 220ms ease-out"), "entrance transition");
  assert.ok(animated.includes('data-frame="11"'), "idle starts at frame 11");
});
