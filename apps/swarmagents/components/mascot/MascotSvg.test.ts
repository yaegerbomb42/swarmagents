import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { segmentFor, type MascotSvgState } from "./svg-timeline";

// The project compiles TSX with the classic JSX transform outside Next, so the
// component modules expect a React global when node:test imports them.
(globalThis as unknown as { React: typeof React }).React = React;

async function renderMascotSvg(props: Record<string, unknown>): Promise<string> {
  const { MascotSvg } = await import("./MascotSvg");
  return renderToStaticMarkup(React.createElement(MascotSvg, props));
}

async function renderTwo(): Promise<string> {
  const { MascotSvg } = await import("./MascotSvg");
  return renderToStaticMarkup(
    React.createElement(
      "div",
      null,
      React.createElement(MascotSvg, { state: "wave", reducedMotion: true }),
      React.createElement(MascotSvg, { state: "thinking", reducedMotion: true }),
    ),
  );
}

const STATES: MascotSvgState[] = ["wave", "curious", "thinking", "idle"];

test("each state renders the first frame of its own segment", async () => {
  for (const state of STATES) {
    const html = await renderMascotSvg({ state, reducedMotion: true });
    const { start } = segmentFor(state);
    assert.ok(html.includes(`data-mascot-state="${state}"`), `${state} state attr`);
    assert.ok(html.includes(`data-time="${start.toFixed(3)}"`), `${state} still frame at ${start}s`);
    assert.ok(html.includes('data-mascot-reduced="true"'), `${state} reports reduced motion`);
  }
});

test("the artwork is an inline, transparent, scalable SVG", async () => {
  const html = await renderMascotSvg({ state: "curious", size: 120, reducedMotion: true });
  assert.ok(html.includes("<svg"), "inline SVG (no image asset)");
  assert.ok(html.includes('viewBox="130 70 540 640"'), "reference viewBox");
  assert.ok(html.includes('width="120"'), "size sets the width");
  assert.ok(html.includes('height="142"'), "height follows the 540:640 viewBox");
  assert.ok(html.includes("background:transparent"), "no grey stage");
  assert.ok(!html.toLowerCase().includes("c5c5c5"), "reference stage colour is gone");
  assert.ok(!html.includes('data-testid="mascot-sprite"'), "does not fall back to the sprite sheet");
});

test("two instances on one page get distinct SVG ids", async () => {
  const html = await renderTwo();

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length >= 20, "both instances contributed defs");
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids across the two mascots");

  const prefixes = new Set(ids.map((id) => id.replace(/-(?:shell|limb|limbR|rim|creamV|glass|shadowG|b6|b3|faceClip|headClip|rimClip|leg|shell-glow)$/, "")));
  assert.equal(prefixes.size, 2, "each mascot has its own id prefix");

  // Every internal reference points at one of the ids in this document.
  const refs = [...html.matchAll(/(?:url\(#|href="#)([^)"]+)/g)].map((match) => match[1]);
  assert.ok(refs.length > 0, "gradients and clips are referenced");
  for (const ref of refs) assert.ok(ids.includes(ref), `#${ref} resolves`);
});

test("reduced motion renders a still frame without an animation driver", async () => {
  const html = await renderMascotSvg({ state: "thinking", reducedMotion: true });
  assert.ok(html.includes('data-mascot-reduced="true"'));
  assert.ok(html.includes('data-time="6.000"'), "thinking's first frame");
  assert.ok(!html.includes("requestAnimationFrame"), "nothing schedules frames in markup");
  assert.ok(html.includes("opacity"), "the pose is painted, not blank");
});

test("motion is enabled by default (browser path)", async () => {
  const html = await renderMascotSvg({ state: "idle" });
  assert.ok(html.includes('data-mascot-reduced="false"'));
  assert.ok(html.includes('data-time="1.300"'), "idle starts at the calm shoulder");
});

test("a labelled mascot is readable and accepts a click to wave", async () => {
  const html = await renderMascotSvg({
    state: "curious",
    label: "Jimmy is waiting for you.",
    onClick: () => {},
    clickLabel: "Click Jimmy to wave hello",
    reducedMotion: true,
  });
  assert.ok(html.includes("<button"), "click target is a button");
  assert.ok(html.includes('aria-label="Click Jimmy to wave hello"'));
  assert.ok(html.includes('class="sr-only"'), "status line is visually hidden");
  assert.ok(html.includes("Jimmy is waiting for you."));
  assert.ok(html.includes('aria-hidden="true"'), "the artwork itself is decorative");

  const hidden = await renderMascotSvg({ state: "idle", reducedMotion: true });
  const wrapperTag = /<span[^>]*data-testid="mascot-svg"[^>]*>/.exec(hidden)?.[0] ?? "";
  assert.ok(wrapperTag.includes('aria-hidden="true"'), "unlabelled mascot is hidden");
});
