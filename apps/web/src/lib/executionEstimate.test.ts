import { describe, it, expect } from "vitest";
import { estimateRunCredits, hasSufficientBalance } from "./executionEstimate";
import { getModelPrice, MODEL_PRICES } from "./modelPricing";

describe("estimateRunCredits", () => {
  it("scales linearly with node count (within ceil rounding)", () => {
    const one = estimateRunCredits({ modelId: "DeepSeek-V4-Flash", nodeCount: 1 });
    const ten = estimateRunCredits({ modelId: "DeepSeek-V4-Flash", nodeCount: 10 });
    expect(one.estCredits).toBeGreaterThan(0);
    // estimate rounds up to 0.01 per call — allow that drift amplified ×10
    expect(Math.abs(ten.estCredits - one.estCredits * 10)).toBeLessThanOrEqual(0.1);
  });

  it("charges more for a more expensive model", () => {
    const cheap = estimateRunCredits({ modelId: "Mistral-NeMo-12B", nodeCount: 8 });
    const pricey = estimateRunCredits({ modelId: "Qwen-3-Max", nodeCount: 8 });
    expect(pricey.estCredits).toBeGreaterThan(cheap.estCredits);
  });

  it("matches manual per-token math (input + output legs)", () => {
    const modelId = "DeepSeek-V4-Flash";
    const r = estimateRunCredits({
      modelId,
      nodeCount: 5,
      estInputTokensPerCall: 1000,
      estOutputTokensPerCall: 500,
      callsPerNode: 2,
    });
    const p = getModelPrice(modelId);
    const expected =
      (1000 / 1000) * p.creditsPer1KInput * 2 * 5 +
      (500 / 1000) * p.creditsPer1KOutput * 2 * 5;
    expect(r.estCredits).toBeCloseTo(Math.ceil(expected * 100) / 100, 6);
  });

  it("throws on unknown model (never free)", () => {
    expect(Object.keys(MODEL_PRICES).length).toBeGreaterThan(0);
    expect(() => estimateRunCredits({ modelId: "nope-9000", nodeCount: 1 })).toThrow();
  });
});

describe("hasSufficientBalance", () => {
  it("gates correctly at the exact boundary", () => {
    expect(hasSufficientBalance(5, 5)).toBe(true);
    expect(hasSufficientBalance(4.999, 5)).toBe(false);
    expect(hasSufficientBalance(0, 0.01)).toBe(false);
  });
});
