/**
 * AnsiRenderer tests: the SGR parser and the terminal row mapping.
 *
 * Rendering goes through react-dom/server so the assertions see the same style
 * objects the browser applies, without a DOM or an extra test renderer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnsiRenderer, AnsiTerminal, parseLogLine } from "./AnsiRenderer";

function renderAnsi(text: string): string {
  return renderToStaticMarkup(createElement(AnsiRenderer, { text }));
}

const FG_0_15 = [
  "#1e1e1e",
  "#d16969",
  "#89b482",
  "#d7ba7d",
  "#6cb6ff",
  "#c586c0",
  "#4ec9b0",
  "#d4d4d4",
  "#808080",
  "#f14c4c",
  "#6a9955",
  "#dcdcaa",
  "#569cd6",
  "#ce9178",
  "#9cdcfe",
  "#ffffff",
];

test("256-color indices 0-15 map to the standard and bright ANSI colors", () => {
  for (let i = 0; i < 16; i += 1) {
    const html = renderAnsi(`\x1b[38;5;${i}mX\x1b[0m`);
    assert.ok(
      html.includes(`color:${FG_0_15[i]}`),
      `256-color index ${i} should render ${FG_0_15[i]}, got: ${html}`,
    );
  }
});

test("background 256-color indices 0-15 use the same palette", () => {
  for (let i = 0; i < 16; i += 1) {
    const html = renderAnsi(`\x1b[48;5;${i}mX\x1b[0m`);
    assert.ok(
      html.includes(`background-color:${FG_0_15[i]}`),
      `background 256-color index ${i} should render ${FG_0_15[i]}, got: ${html}`,
    );
  }
});

test("truecolor and the 6x6x6 cube render concrete rgb values", () => {
  assert.ok(renderAnsi("\x1b[38;2;1;2;3mX\x1b[0m").includes("color:rgb(1,2,3)"));
  // 196 = 16 + 5*36 -> rgb(255,0,0).
  assert.ok(renderAnsi("\x1b[48;5;196mX\x1b[0m").includes("background-color:rgb(255,0,0)"));
});

test("truncated 38;5 and 38;2 sequences never emit NaN colors", () => {
  for (const text of [
    "\x1b[38;5mX",
    "\x1b[38;2;255mX",
    "\x1b[38;2;255;0mX",
    "\x1b[48;2;1mX",
  ]) {
    const html = renderAnsi(text);
    assert.ok(!html.includes("NaN"), `truncated SGR produced NaN: ${text} -> ${html}`);
    assert.ok(html.includes("X"), `truncated SGR should still render its text: ${text}`);
  }
});

test("underline and strike combine into one text-decoration value", () => {
  const html = renderAnsi("\x1b[4;9mX\x1b[0m");
  assert.ok(
    html.includes("text-decoration:underline line-through"),
    `expected both decorations, got: ${html}`,
  );
});

test("parseLogLine skips ANSI escapes when locating the timestamp", () => {
  const parsed = parseLogLine("\x1b[2m12:34:56\x1b[0m error: boom");
  assert.equal(parsed.timestamp, "12:34:56");
  assert.equal(parsed.kind, "error");
  assert.ok(parsed.body.includes("error: boom"), `body was: ${parsed.body}`);
});

test("AnsiTerminal renders only the newest maxLines rows", () => {
  const text = Array.from({ length: 1005 }, (_, i) => `line ${i}`).join("\n");
  const html = renderToStaticMarkup(createElement(AnsiTerminal, { text, maxLines: 1000 }));
  assert.match(html, />line 1004</);
  assert.doesNotMatch(html, />line 0</);
});