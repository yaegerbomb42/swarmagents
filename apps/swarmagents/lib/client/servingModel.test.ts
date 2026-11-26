import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunStreamItem } from "./useRunStream";
import { reduceServingModel, formatServingModel } from "./servingModel";

function item(kind: string, data: unknown, seq = 1): RunStreamItem {
  return { seq, kind, data, parsed: { id: String(seq), event: kind, data: "" }, ts: seq * 1000 };
}

test("start: derives provider and model from run.started", () => {
  const state = reduceServingModel([item("run.started", { provider: "groq", model: "llama-3.3-70b" })]);
  assert.equal(state.provider, "groq");
  assert.equal(state.model, "llama-3.3-70b");
  assert.equal(state.failover, false);
  assert.equal(formatServingModel(state), "groq · llama-3.3-70b");
});

test("failover: updates to new provider/model and marks failover", () => {
  const state = reduceServingModel([
    item("run.started", { provider: "groq", model: "llama-3.3-70b" }, 1),
    item("provider.pool", { type: "pool.failover", provider: "groq", kind: "auth" }, 2),
    item("provider.pool", { type: "pool.attempt", provider: "openrouter", model: "deepseek-v3", reason: "failover" }, 3),
  ]);
  assert.equal(state.provider, "openrouter");
  assert.equal(state.model, "deepseek-v3");
  assert.equal(state.failover, true);
  assert.equal(formatServingModel(state), "→ openrouter · deepseek-v3 (failover)");
});

test("missing fields: does not crash and leaves state empty", () => {
  const state = reduceServingModel([item("run.started", {}), item("provider.pool", { type: "pool.attempt", reason: "initial" })]);
  assert.equal(state.provider, undefined);
  assert.equal(state.model, undefined);
  assert.equal(formatServingModel(state), undefined);
});
