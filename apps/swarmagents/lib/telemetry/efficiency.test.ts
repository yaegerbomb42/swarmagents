/**
 * Unit tests for the pure efficiency metrics (lib/telemetry/efficiency.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { efficiency, type RunEvent } from "./efficiency";

test("efficiency returns undefined for an empty stream", () => {
  assert.equal(efficiency([]), undefined);
});

test("efficiency counts turns, tool calls, and cache share", () => {
  const events: RunEvent[] = [
    { type: "turn", ts: 1000, tokens: { cacheRead: 900, uncached: 100 } },
    { type: "tool.call", tool: "read", ts: 1100 },
    { type: "tool.call", tool: "read", ts: 1200 },
    { type: "turn", ts: 2000, tokens: { cacheRead: 900, uncached: 100 } },
  ];
  const eff = efficiency(events);
  assert.ok(eff);
  assert.equal(eff!.turns, 2);
  assert.equal(eff!.tool_calls, 2);
  assert.equal(eff!.calls_per_turn, 2);
  assert.equal(eff!.multi_call_turns, 1);
  assert.equal(eff!.cache_share, 0.9);
});

test("efficiency flags idle gaps over IDLE_GAP_MS", () => {
  const events: RunEvent[] = [
    { type: "turn", ts: 0, tokens: { cacheRead: 10, uncached: 10 } },
    { type: "turn", ts: 70_000, tokens: { cacheRead: 10, uncached: 10 } },
  ];
  const eff = efficiency(events);
  assert.ok(eff);
  assert.ok(eff!.idle_ms > 60_000, `idle should exceed the gap threshold, got ${eff!.idle_ms}`);
});
