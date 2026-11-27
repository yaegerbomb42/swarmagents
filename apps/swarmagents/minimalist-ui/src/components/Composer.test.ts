import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import { Composer } from "./Composer";

const h = React.createElement;

function renderComposer() {
  return renderToStaticMarkup(
    h(Composer, {
      value: "",
      onChange: () => {},
      onSend: async () => ({ ok: true as const }),
    }),
  );
}

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

test("Composer shows the mic button when speech recognition is available", () => {
  installBrowserStubs();
  class FakeRecognition {}
  (globalThis.window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
  const markup = renderComposer();
  assert.ok(markup.includes('data-testid="voice-input-button"'), "mic button renders");
  assert.ok(!markup.includes('data-testid="composer-voice-notice"'), "no unsupported notice");
});

test("Composer hides the mic button and explains when speech recognition is missing", () => {
  installBrowserStubs();
  delete (globalThis.window as unknown as Record<string, unknown>).SpeechRecognition;
  delete (globalThis.window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  const markup = renderComposer();
  assert.ok(!markup.includes('data-testid="voice-input-button"'), "no mic button");
  assert.ok(markup.includes('data-testid="composer-voice-notice"'), "unsupported notice shows");
  assert.ok(markup.includes("isn&#x27;t supported in this browser"), "notice explains why");
  assert.ok(markup.includes("Enter to send"), "the send hint is still there");
});
