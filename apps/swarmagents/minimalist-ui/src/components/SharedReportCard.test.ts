/**
 * Component tests for SharedReportCard (core-32): the public showcase card
 * renders only redacted, curated facts — the prompt, a status badge, counts,
 * duration and model — and fetches nothing. Static renders (see
 * testing/harness.ts); no DOM, no jsdom.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import type { ShareShowcase } from "../../../lib/projects/store";

const h = React.createElement;

async function load() {
  installBrowserStubs();
  return import("./SharedReportCard");
}

function showcase(overrides: Partial<ShareShowcase> = {}): ShareShowcase {
  return {
    runId: "run_1",
    prompt: "Build a landing page with the repo's own tooling",
    status: "finished",
    steps: 12,
    shots: 3,
    artifacts: 2,
    durationMs: 95000,
    model: "claude-sonnet-5-5",
    sharedAt: 0,
    ...overrides,
  };
}

test("the card shows the redacted prompt, status badge, counts, duration and model", async () => {
  const { SharedReportCard } = await load();
  const markup = renderToStaticMarkup(h(SharedReportCard, { showcase: showcase() }));
  assert.ok(markup.includes("Build a landing page"));
  assert.ok(markup.includes("finished"));
  assert.ok(markup.includes("12"), "step count is shown");
  assert.ok(markup.includes("1m 35s"), "duration is humanized");
  assert.ok(markup.includes("claude-sonnet-5-5"));
});

test("a non-finished status never renders as a success badge", async () => {
  const { SharedReportCard } = await load();
  const markup = renderToStaticMarkup(
    h(SharedReportCard, { showcase: showcase({ status: "error", durationMs: undefined }) }),
  );
  assert.ok(markup.includes("error"));
  assert.ok(!markup.includes("emerald"), "no green badge for a failed run");
  assert.ok(markup.includes("—"), "missing duration renders as a dash");
});

test("the card never contains private paths or owner identity fields", async () => {
  const { SharedReportCard } = await load();
  const markup = renderToStaticMarkup(h(SharedReportCard, { showcase: showcase() }));
  // The component takes the curated shape only: there is no prop that could
  // carry a workspace path, an owner id, or cost/token accounting, and the
  // markup cannot invent one.
  assert.equal(markup.includes("/workspace"), false);
  assert.equal(markup.includes("userId"), false);
  assert.equal(markup.includes("costUsd"), false);
  assert.equal(markup.includes("tokensIn"), false);
});
