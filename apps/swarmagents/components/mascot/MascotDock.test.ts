import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as { React: typeof React }).React = React;

async function renderDock(props: Record<string, unknown>): Promise<string> {
  const { MascotDock } = await import("./MascotDock");
  return renderToStaticMarkup(
    React.createElement(MascotDock, props as unknown as React.ComponentProps<typeof MascotDock>),
  );
}

test("the dock renders the SVG variant by default", async () => {
  const html = await renderDock({ state: "working" });
  assert.ok(html.includes('data-testid="mascot-svg"'), "SVG renderer");
  assert.ok(!html.includes("/brand/mascot/mascot-sheet.png"), "sprite sheet is not mounted");
});

test("the dock still renders the sprite sheet when explicitly asked", async () => {
  const html = await renderDock({ state: "working", variant: "sprite" });
  assert.ok(html.includes('data-testid="mascot"'), "sprite renderer");
  assert.ok(html.includes("/brand/mascot/mascot-sheet.png"), "sprite sheet");
  assert.ok(!html.includes('data-testid="mascot-svg"'), "SVG renderer is not mounted");
});

test("the dock renders the SVG variant when asked", async () => {
  const html = await renderDock({ state: "attention", variant: "svg", size: 56 });
  assert.ok(html.includes('data-testid="mascot-svg"'), "SVG renderer");
  assert.ok(!html.includes("/brand/mascot/mascot-sheet.png"), "sprite sheet is not mounted");
  assert.ok(html.includes('data-mascot-state="wave"'), "first load still waves hello");
  assert.ok(html.includes("Click Jimmy to wave hello"), "the greeting is clickable");
});
