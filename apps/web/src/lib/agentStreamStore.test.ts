import { describe, it, expect, beforeEach } from "vitest";
import { agentStreamStore, type AgentEvent } from "./agentStreamStore";

function evt(agentId: string, id: string, timestamp: number, type: AgentEvent["type"] = "thought"): AgentEvent {
  return { id, agentId, type, payload: { id }, timestamp };
}

describe("agentStreamStore", () => {
  beforeEach(() => {
    agentStreamStore.clear();
  });

  it("bounds the global event buffer to EVENT_BUFFER (500)", () => {
    const many: AgentEvent[] = [];
    for (let i = 0; i < 620; i++) many.push(evt("a1", `e${i}`, i * 1000));
    agentStreamStore.ingestMany(many);
    const buf = agentStreamStore.bufferSnapshot();
    expect(buf.length).toBe(500);
    // Ring-buffer keeps the newest tail
    expect(buf[buf.length - 1].id).toBe("e619");
    expect(buf[0].id).toBe("e120");
  });

  it("dedupes by agentId — one state per agent regardless of event volume", () => {
    for (let i = 0; i < 50; i++) agentStreamStore.ingest(evt("agent-x", `e${i}`, i * 1000));
    expect(agentStreamStore.size()).toBe(1);
    const [state] = agentStreamStore.agentsSnapshot();
    expect(state.agentId).toBe("agent-x");
    expect(state.eventCount).toBe(50);
  });

  it("keeps lastSeen monotonic on latest ingest", () => {
    agentStreamStore.ingest(evt("a", "first", 1000));
    agentStreamStore.ingest(evt("a", "second", 5000));
    const [state] = agentStreamStore.agentsSnapshot();
    expect(state.lastSeen).toBe(5000);
    expect(state.lastEvent?.id).toBe("second");
  });

  it("caps recentTypes to the last 8 (sliding window, oldest evicted)", () => {
    const types: AgentEvent["type"][] = [
      "thought", "tool_call", "tool_result", "memory",
      "state", "error", "thought", "tool_call", "tool_result",
    ];
    types.forEach((t, i) => agentStreamStore.ingest(evt("a", `e${i}`, i * 1000, t)));
    const [state] = agentStreamStore.agentsSnapshot();
    expect(state.recentTypes.length).toBe(8);
    expect(state.recentTypes[0]).toBe("tool_call"); // "thought" evicted
    expect(state.recentTypes[7]).toBe("tool_result");
  });

  it("buckets sparkline by TICK_MS window and accumulates counts", () => {
    // All events in two adjacent 1s buckets
    for (let i = 0; i < 3; i++) agentStreamStore.ingest(evt("a", `x${i}`, 0 + i * 10));
    for (let i = 0; i < 2; i++) agentStreamStore.ingest(evt("a", `y${i}`, 1000 + i * 10));
    const [state] = agentStreamStore.agentsSnapshot();
    expect(state.sparkline.reduce((a, b) => a + b, 0)).toBe(5);
    const bucket0 = 0 % 20;
    const bucket1 = 1 % 20;
    expect(state.sparkline[bucket0]).toBe(3);
    expect(state.sparkline[bucket1]).toBe(2);
  });

  it("zeroes skipped sparkline buckets when time wraps past the window", () => {
    agentStreamStore.ingest(evt("a", "old", 0)); // bucket 0 @ tick 0
    agentStreamStore.ingest(evt("a", "new", 20_000)); // tick 20 → same bucket 0, one window later
    const [state] = agentStreamStore.agentsSnapshot();
    expect(state.sparkline[0]).toBe(1);
    expect(state.sparkline.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("advance() decays quiet agents to zero", () => {
    agentStreamStore.ingest(evt("a", "e", 5_000));
    agentStreamStore.advance(5_000 + 30_000);
    const [state] = agentStreamStore.agentsSnapshot();
    expect(state.sparkline.every((v) => v === 0)).toBe(true);
  });

  it("clear() empties agents and buffer", () => {
    agentStreamStore.ingest(evt("a", "e", 0));
    agentStreamStore.clear();
    expect(agentStreamStore.size()).toBe(0);
    expect(agentStreamStore.bufferSnapshot()).toEqual([]);
  });
});
