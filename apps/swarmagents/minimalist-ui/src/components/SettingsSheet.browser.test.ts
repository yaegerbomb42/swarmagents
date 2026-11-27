import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserSessionPanel } from "./SettingsSheet";

test("BrowserSessionPanel renders saved session size and clear button", () => {
  const present = renderToStaticMarkup(
    React.createElement(BrowserSessionPanel, {
      status: { exists: true, sizeMb: 14 },
      loading: false,
      clearing: false,
      onClear: () => {},
    }),
  );
  assert.ok(present.includes('data-testid="settings-browser-status"'));
  assert.ok(present.includes("Saved session (14 MB)"));
  assert.ok(present.includes('data-testid="settings-browser-profile-clear"'));
  assert.ok(!present.includes("disabled=\"\""), "clear button is enabled when session exists");

  const absent = renderToStaticMarkup(
    React.createElement(BrowserSessionPanel, {
      status: { exists: false, sizeMb: 0 },
      loading: false,
      clearing: false,
      clearedNotice: true,
      onClear: () => {},
    }),
  );
  assert.ok(absent.includes("No saved browser session"));
  assert.ok(absent.includes("Saved browser session cleared"));
});
