/**
 * Component tests for the command palette: the pure query/selection core
 * plus static renders of the dialog (see testing/harness.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import {
  filterPaletteItems,
  matchPaletteQuery,
  movePaletteSelection,
  paletteKeyAction,
  type PaletteItem,
} from "./CommandPalette";

const h = React.createElement;

/** Components are imported after the browser stubs are in place. */
async function load() {
  installBrowserStubs();
  return import("./CommandPalette");
}

function item(overrides: Partial<PaletteItem> & { id: string; label: string }): PaletteItem {
  return {
    group: "Actions",
    run: () => {},
    ...overrides,
  };
}

const ITEMS: PaletteItem[] = [
  item({ id: "new-thread", label: "New thread", hint: "Start a fresh conversation", shortcut: ["⌘/Ctrl", "Shift", "O"] }),
  item({ id: "settings", label: "Open Settings", hint: "Providers, agent, computers…" }),
  item({ id: "library", label: "Open Library", hint: "Skills, connectors, and saved items" }),
  item({ id: "run-a", group: "Recent runs", label: "Fix the rate limiter", hint: "just now · 2 runs" }),
  item({ id: "run-b", group: "Recent runs", label: "Deploy the landing page", hint: "3h ago · 1 run" }),
  item({ id: "disabled", label: "New thread (busy)", disabled: true }),
];

test("subsequence matching is case-insensitive and order-sensitive", () => {
  assert.equal(matchPaletteQuery("New thread", ""), true, "empty query matches");
  assert.equal(matchPaletteQuery("New thread", "new"), true);
  assert.equal(matchPaletteQuery("New thread", "NT"), true, "initials match");
  assert.equal(matchPaletteQuery("New thread", "nth"), true, "scattered letters match in order");
  assert.equal(matchPaletteQuery("New thread", "tne"), false, "out-of-order letters do not match");
  assert.equal(matchPaletteQuery("Open Settings", "os"), true);
  assert.equal(matchPaletteQuery("Open Settings", "xyz"), false);
});

test("filtering matches labels and hints and keeps the original order", () => {
  assert.deepEqual(
    filterPaletteItems(ITEMS, "").map((i) => i.id),
    ["new-thread", "settings", "library", "run-a", "run-b", "disabled"],
    "empty query keeps everything in order",
  );
  assert.deepEqual(
    filterPaletteItems(ITEMS, "open").map((i) => i.id),
    ["settings", "library"],
    "label match",
  );
  assert.deepEqual(
    filterPaletteItems(ITEMS, "3h").map((i) => i.id),
    ["run-b"],
    "hint match finds the run",
  );
  assert.deepEqual(filterPaletteItems(ITEMS, "zzz"), [], "no match is empty");
});

test("key mapping covers navigation, run, and close only", () => {
  assert.equal(paletteKeyAction({ key: "ArrowDown" }), "down");
  assert.equal(paletteKeyAction({ key: "ArrowUp" }), "up");
  assert.equal(paletteKeyAction({ key: "Enter" }), "run");
  assert.equal(paletteKeyAction({ key: "Escape" }), "close");
  assert.equal(paletteKeyAction({ key: "Tab" }), null);
  assert.equal(paletteKeyAction({ key: "a" }), null);
});

test("selection wraps and skips disabled rows", () => {
  assert.equal(movePaletteSelection(ITEMS, 0, "down"), 1);
  assert.equal(movePaletteSelection(ITEMS, 4, "down"), 0, "wraps past the end");
  assert.equal(movePaletteSelection(ITEMS, 0, "up"), 4, "wraps past the start");
  assert.equal(movePaletteSelection(ITEMS, 4, "up"), 3);
  assert.equal(movePaletteSelection(ITEMS, 5, "down"), 0, "a disabled row is never landed on");
  assert.equal(movePaletteSelection([], 0, "down"), -1, "nothing selectable");
  assert.equal(
    movePaletteSelection([item({ id: "only", label: "Only", disabled: true })], 0, "down"),
    -1,
    "all disabled means nothing selectable",
  );
});

test("the closed palette renders nothing", async () => {
  const { CommandPalette } = await load();
  const markup = renderToStaticMarkup(
    h(CommandPalette, { open: false, onClose: () => {}, items: ITEMS }),
  );
  assert.equal(markup.trim(), "");
});

test("the open palette lists every command with its shortcut", async () => {
  const { CommandPalette } = await load();
  const markup = renderToStaticMarkup(
    h(CommandPalette, { open: true, onClose: () => {}, items: ITEMS }),
  );
  assert.ok(markup.includes('data-testid="command-palette"'), "palette renders");
  assert.ok(markup.includes('data-testid="command-palette-input"'), "search input renders");
  assert.ok(markup.includes("Type a command or search runs…"), "input has a prompt");
  assert.ok(markup.includes("Actions"), "actions group renders");
  assert.ok(markup.includes("Recent runs"), "runs group renders");
  for (const entry of ITEMS) {
    assert.ok(markup.includes(entry.label), `"${entry.label}" renders`);
  }
  assert.ok(markup.includes("⌘/Ctrl"), "shortcut chips render");
  assert.ok(markup.includes("Shift"), "multi-key shortcut renders");
  assert.ok(markup.includes("↑↓"), "footer names navigation");
  assert.ok(markup.includes("esc"), "footer names close");
  const rows = (markup.match(/data-testid="palette-item"/g) ?? []).length;
  assert.equal(rows, ITEMS.length, "one row per item");
  // The first runnable row starts selected.
  assert.ok(markup.includes('aria-selected="true"'), "a row starts selected");
});

test("a query filters the rendered list to the match", async () => {
  const { CommandPalette } = await load();
  const markup = renderToStaticMarkup(
    h(CommandPalette, { open: true, onClose: () => {}, items: ITEMS, defaultQuery: "deploy" }),
  );
  assert.ok(markup.includes("Deploy the landing page"), "the match renders");
  assert.ok(!markup.includes("New thread"), "non-matches do not render");
  assert.ok(!markup.includes("Actions"), "the empty group heading is gone");
  assert.ok(markup.includes("Recent runs"), "the matching group stays");
});

test("no match shows the empty state instead of rows", async () => {
  const { CommandPalette } = await load();
  const markup = renderToStaticMarkup(
    h(CommandPalette, { open: true, onClose: () => {}, items: ITEMS, defaultQuery: "zzz" }),
  );
  assert.ok(markup.includes('data-testid="command-palette-empty"'), "empty state renders");
  assert.ok(markup.includes("No matching commands"), "empty state explains itself");
  assert.equal((markup.match(/data-testid="palette-item"/g) ?? []).length, 0, "no rows");
});

test("a disabled row is marked and never starts selected", async () => {
  const { CommandPalette } = await load();
  const markup = renderToStaticMarkup(
    h(CommandPalette, {
      open: true,
      onClose: () => {},
      items: [item({ id: "off", label: "Off", disabled: true })],
      defaultQuery: "",
    }),
  );
  assert.ok(markup.includes('aria-disabled="true"'), "disabled row is marked");
  assert.ok(!markup.includes('aria-selected="true"'), "nothing is selected when nothing is runnable");
});
