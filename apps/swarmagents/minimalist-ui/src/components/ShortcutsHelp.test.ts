import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHORTCUT_GROUPS, ShortcutsHelp } from "./ShortcutsHelp";
import { countOf } from "../testing/harness";
import { installBrowserStubs } from "../testing/harness";

installBrowserStubs();

const KEYS_TO_ENTRY = new Map<string, { group: string; description: string }>();

for (const group of SHORTCUT_GROUPS) {
  for (const entry of group.entries) {
    const signature = entry.keys.join("+");
    assert.ok(!KEYS_TO_ENTRY.has(signature), `duplicate shortcut ${signature}`);
    KEYS_TO_ENTRY.set(signature, { group: group.title, description: entry.description });
  }
}

test("the help panel lists exactly the shortcuts the console supports", () => {
  assert.equal(KEYS_TO_ENTRY.size, 9, "the accepted set of shortcuts, no more, no less");
  // The set is pinned on purpose: it must mirror what the code actually wires
  // (App.tsx chords + Esc, Composer.tsx Enter/Shift+Enter, ApprovalGate.tsx
  // A/D/Shift+A, ComputerScreen.tsx Ctrl+C). If a shortcut changes, update
  // SHORTCUT_GROUPS and this list together.
  assert.deepEqual([...KEYS_TO_ENTRY.keys()].sort(), [
    "A",
    "Ctrl+C",
    "D",
    "Enter",
    "Esc",
    "Shift+A",
    "Shift+Enter",
    "⌘/Ctrl+K",
    "⌘/Ctrl+Shift+O",
  ]);
});

test("the open panel renders every group, row, and key", () => {
  const html = renderToStaticMarkup(React.createElement(ShortcutsHelp, { open: true, onClose: () => {} }));

  assert.ok(html.includes('data-testid="shortcuts-help"'), "the panel shell renders");
  assert.ok(html.includes("Keyboard shortcuts"), "the panel has a title");

  for (const group of SHORTCUT_GROUPS) {
    assert.ok(html.includes(group.title), `group title "${group.title}" renders`);
    if (group.context) assert.ok(html.includes(group.context), `group context "${group.context}" renders`);
    for (const entry of group.entries) {
      assert.ok(html.includes(entry.description), `"${entry.description}" renders`);
      for (const key of entry.keys) {
        assert.ok(html.includes(key), `key "${key}" renders`);
      }
    }
  }

  const rows = countOf(html, 'data-testid="shortcut-row"');
  assert.equal(rows, KEYS_TO_ENTRY.size, "one row per shortcut");
});

test("the closed panel renders nothing", () => {
  const html = renderToStaticMarkup(React.createElement(ShortcutsHelp, { open: false, onClose: () => {} }));
  assert.equal(countOf(html, 'data-testid="shortcuts-help"'), 0);
  assert.equal(html.trim(), "");
});
