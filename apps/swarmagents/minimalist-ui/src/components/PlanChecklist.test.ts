/**
 * Component tests for the live plan checklist (static renders, see
 * testing/harness.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs, countOf } from "../testing/harness";
import type { RunPlan } from "../../../lib/run-plan";

const h = React.createElement;

async function load() {
  installBrowserStubs();
  return import("./PlanChecklist");
}

const PLAN: RunPlan = [
  { id: "1", content: "Open the site", status: "completed", activeForm: "Opening the site" },
  { id: "2", content: "Fill the form", status: "in_progress", activeForm: "Filling the form" },
  { id: "3", content: "Submit", status: "pending", activeForm: "Submitting" },
];

test("renders nothing for a run that never planned", async () => {
  const { PlanChecklist } = await load();
  assert.equal(renderToStaticMarkup(h(PlanChecklist, { plan: null })), "");
  assert.equal(renderToStaticMarkup(h(PlanChecklist, { plan: [] })), "");
});

test("live: counter, the in-progress step in its active form, status per step, pinned", async () => {
  const { PlanChecklist } = await load();
  const html = renderToStaticMarkup(h(PlanChecklist, { plan: PLAN, live: true }));
  assert.match(html, /data-testid="plan-counter"[^>]*>1(?:<!-- -->)?\/(?:<!-- -->)?3</);
  assert.match(html, /data-testid="plan-current"[^>]*>Filling the form</);
  assert.equal(countOf(html, 'data-testid="plan-step"'), 3);
  assert.match(html, /data-status="completed"/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /sticky/);
  // Collapsed to the header on mobile by default, open from sm up.
  assert.match(html, /hidden sm:block/);
});

test("finished plan says all steps done and is not pinned", async () => {
  const { PlanChecklist } = await load();
  const finished = PLAN.map((step) => ({ ...step, status: "completed" as const }));
  const html = renderToStaticMarkup(h(PlanChecklist, { plan: finished, defaultOpen: true }));
  assert.match(html, /All steps done/);
  assert.doesNotMatch(html, /sticky/);
  assert.doesNotMatch(html, /hidden sm:block/);
});
