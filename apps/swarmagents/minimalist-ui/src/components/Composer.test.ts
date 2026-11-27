import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, SteerChoiceChip, steerChoiceKeyAction } from "./Composer";

test("Composer renders Fast / Balanced / Deep tier selector when onTierChange is provided", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Composer, {
      value: "",
      onChange: () => {},
      onSend: async () => ({ ok: true as const }),
      tier: "deep",
      onTierChange: () => {},
    }),
  );
  assert.ok(markup.includes('data-testid="composer-tier-selector"'));
  assert.ok(markup.includes('data-testid="composer-tier-fast"'));
  assert.ok(markup.includes('data-testid="composer-tier-balanced"'));
  assert.ok(markup.includes('data-testid="composer-tier-deep"'));
  const pressed = [...markup.matchAll(/<button[^>]*aria-pressed="true"[^>]*data-testid="composer-tier-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(pressed, ["deep"], "only the selected tier is pressed");
});

test("steerChoiceKeyAction: Enter steers, Escape cancels, Shift+Enter does neither", () => {
  assert.equal(steerChoiceKeyAction({ key: "Enter", shiftKey: false }), "steer");
  assert.equal(steerChoiceKeyAction({ key: "Enter", shiftKey: true }), null);
  assert.equal(steerChoiceKeyAction({ key: "Escape", shiftKey: false }), "cancel");
  assert.equal(steerChoiceKeyAction({ key: "a", shiftKey: false }), null);
  assert.equal(steerChoiceKeyAction({ key: "Enter", shiftKey: false, isComposing: true }), null);
});

test("SteerChoiceChip renders Steer now (default) and Queue after", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SteerChoiceChip, { onSteer: () => {}, onQueue: () => {}, onCancel: () => {} }),
  );
  assert.ok(markup.includes('data-testid="composer-steer-chip"'));
  assert.ok(markup.includes('data-testid="composer-steer-now"'));
  assert.ok(markup.includes("Steer now"));
  assert.ok(markup.includes('data-testid="composer-steer-queue"'));
  assert.ok(markup.includes("Queue after"));
});

test("Composer mentions steering in the footer hint while a run is busy", () => {
  const markup = renderToStaticMarkup(
    React.createElement(Composer, {
      value: "",
      onChange: () => {},
      onSend: async () => ({ ok: true as const }),
      onSteer: async () => ({ ok: true as const }),
      busy: true,
    }),
  );
  assert.ok(markup.includes("Enter to steer"));
});
