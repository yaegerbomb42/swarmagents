import { describe, it, expect } from "vitest";
import { ENGINE_STATUS_MAP, engineToUiStatus } from "./ExecutionOrchestrator";

describe("engineToUiStatus (engine → UI state machine)", () => {
  it("collapses pipeline states onto 'running'", () => {
    expect(engineToUiStatus("decomposing")).toBe("running");
    expect(engineToUiStatus("assigned")).toBe("running");
    expect(engineToUiStatus("executing")).toBe("running");
    expect(engineToUiStatus("validating")).toBe("running");
  });

  it("maps terminal success to 'completed'", () => {
    expect(engineToUiStatus("completed")).toBe("completed");
  });

  it("maps failure family to 'failed'", () => {
    expect(engineToUiStatus("failed")).toBe("failed");
    expect(engineToUiStatus("cancelled")).toBe("failed");
  });

  it("maps queued/backlog statuses to 'pending'", () => {
    expect(engineToUiStatus("ready")).toBe("pending");
    expect(engineToUiStatus("blocked")).toBe("pending");
    expect(engineToUiStatus("pending")).toBe("pending");
  });

  it("is case-insensitive and undefined-safe (default 'pending')", () => {
    expect(engineToUiStatus(undefined)).toBe("pending");
    expect(engineToUiStatus("")).toBe("pending");
    expect(engineToUiStatus("EXECUTING")).toBe("running");
    expect(engineToUiStatus("unknown_status")).toBe("pending");
  });

  it("ENGINE_STATUS_MAP covers every UI state bucket", () => {
    const buckets = new Set(Object.values(ENGINE_STATUS_MAP));
    for (const b of ["pending", "running", "completed", "failed"] as const) {
      expect(buckets.has(b)).toBe(true);
    }
    expect(Object.keys(ENGINE_STATUS_MAP).length).toBeGreaterThanOrEqual(8);
  });
});
