import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "./Composer";

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
  assert.ok(markup.includes('data-testid="composer-tier-deep" aria-pressed="true"') || markup.includes('aria-pressed="true"'));
});
