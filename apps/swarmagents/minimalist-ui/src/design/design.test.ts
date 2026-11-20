/**
 * Tests for the design-layer logic: capability gating and the step rail.
 *
 * The primitives themselves are presentational; every decision that can be
 * wrong (when a control is disabled, why, and what a rail node shows) lives in
 * these pure modules, matching how TeamPanel/agentForm are tested here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityTone,
  degradedHint,
  deriveCapabilities,
  gate,
} from "./capabilities";
import { buildPlanSteps, eventTone, planProgressLabel, stepGlyph } from "./steps";

test("a fully configured deployment reports every capability ready", () => {
  const caps = deriveCapabilities({
    vmDriver: "docker",
    providersConfigured: true,
    desktop: true,
    agentsEnabled: true,
  });
  assert.deepEqual(caps.map((c) => c.state), ["ready", "ready", "ready", "ready", "ready", "ready"]);
  assert.equal(gate(caps, "vm").disabled, false);
  assert.equal(degradedHint(caps, "vm"), null);
});

test("missing signals are unavailable, never optimistically true", () => {
  const caps = deriveCapabilities({});
  assert.deepEqual(caps.map((c) => c.state), [
    "unavailable",
    "unavailable",
    "unavailable",
    "ready", // the agent store works whenever the app booted
    "unavailable",
    "unavailable",
  ]);
  const vm = gate(caps, "vm");
  assert.equal(vm.disabled, true);
  assert.match(vm.reason ?? "", /No VM driver/);
  assert.equal(capabilityTone("unavailable"), "off");
});

test("the fake VM driver is degraded, not ready — and it says why", () => {
  const caps = deriveCapabilities({ vmDriver: "fake", providersConfigured: true });
  assert.equal(caps.find((c) => c.id === "vm")?.state, "degraded");
  assert.equal(gate(caps, "vm").disabled, false, "degraded still allows the action");
  assert.match(degradedHint(caps, "vm") ?? "", /replay a recorded transcript/);
  assert.equal(capabilityTone("degraded"), "warn");
  assert.equal(caps.find((c) => c.id === "livePreview")?.state, "unavailable");
});

test("no providers blocks agent deploys with an actionable reason", () => {
  const caps = deriveCapabilities({ vmDriver: "docker", providersConfigured: false });
  const providers = gate(caps, "providers");
  assert.equal(providers.disabled, true);
  assert.match(providers.reason ?? "", /BYOK/);
});

test("an unknown capability id is disabled rather than silently allowed", () => {
  const result = gate(deriveCapabilities({ vmDriver: "docker" }), "teleport" as never);
  assert.equal(result.disabled, true);
  assert.match(result.reason ?? "", /no "teleport" capability/);
});

test("the step rail marks one active step and never lies about a finished run", () => {
  const steps = [{ title: "Read" }, { title: "Change" }, { title: "Verify" }];

  const running = buildPlanSteps(steps, { currentIndex: 1 });
  assert.deepEqual(running.map((s) => s.status), ["done", "active", "pending"]);
  assert.equal(planProgressLabel(running), "1/3");
  assert.deepEqual(running.map((s, i) => stepGlyph(s, i)), ["✓", "2", "3"]);

  const completed = buildPlanSteps(steps, { currentIndex: 2, finished: "completed" });
  assert.deepEqual(completed.map((s) => s.status), ["done", "done", "done"]);
  assert.equal(completed.some((s) => s.status === "active"), false, "a finished run must not show a spinner");

  const failed = buildPlanSteps(steps, { currentIndex: 1, finished: "failed" });
  assert.deepEqual(failed.map((s) => s.status), ["done", "failed", "pending"]);
  assert.equal(stepGlyph(failed[1], 1), "✕");

  const cancelled = buildPlanSteps(steps, { currentIndex: 0, finished: "cancelled" });
  assert.equal(cancelled[0].status, "skipped");
  assert.equal(stepGlyph(cancelled[0], 0), "–");
});

test("nothing started means every step is pending", () => {
  const steps = buildPlanSteps([{ title: "A", detail: "why" }], { currentIndex: -1 });
  assert.equal(steps[0].status, "pending");
  assert.equal(steps[0].detail, "why");
  assert.equal(planProgressLabel(steps), "0/1");
});

test("event tones separate failures, retries and successes", () => {
  assert.equal(eventTone("run.failed"), "err");
  assert.equal(eventTone("tool.call.denied"), "err");
  assert.equal(eventTone("run.retry"), "warn");
  assert.equal(eventTone("run.queued"), "warn");
  assert.equal(eventTone("approval.resolved"), "ok");
  assert.equal(eventTone("step.done"), "ok");
  assert.equal(eventTone("assistant.message"), "neutral");
});
