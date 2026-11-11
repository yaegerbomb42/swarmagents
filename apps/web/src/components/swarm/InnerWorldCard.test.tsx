import { describe, expect, it } from "vitest";
import { deriveLifecycle, ttcTier } from "./InnerWorldCard";
import type { AgentStreamState, AgentEvent } from "@/lib/agentStreamStore";

function mkAgent(over: Partial<AgentStreamState> & { lastEvent?: AgentEvent }): AgentStreamState {
  return {
    agentId: "agent-0001",
    lastSeen: Date.now(),
    eventCount: 10,
    recentTypes: [],
    sparkline: new Array(20).fill(0),
    ...over,
  };
}

function evt(type: AgentEvent["type"], payload: Record<string, unknown> = {}): AgentEvent {
  return { id: "e1", agentId: "agent-0001", type, payload, timestamp: Date.now() };
}

describe("deriveLifecycle", () => {
  it("flags error when last event is error", () => {
    expect(deriveLifecycle(mkAgent({ lastEvent: evt("error") }), Date.now())).toBe("error");
  });
  it("flags settled on terminal state phase", () => {
    expect(deriveLifecycle(mkAgent({ lastEvent: evt("state", { phase: "done" }) }), Date.now())).toBe("settled");
  });
  it("flags settled when silent > 8s", () => {
    const stale = Date.now() - 9000;
    expect(deriveLifecycle(mkAgent({ lastSeen: stale }), Date.now())).toBe("settled");
  });
  it("flags spawning for newborn agents", () => {
    expect(deriveLifecycle(mkAgent({ eventCount: 1 }), Date.now())).toBe("spawning");
  });
  it("flags idle for 5s+ silence", () => {
    const t = Date.now() - 6000;
    expect(deriveLifecycle(mkAgent({ lastSeen: t, eventCount: 5 }), Date.now())).toBe("idle");
  });
  it("flags active otherwise", () => {
    expect(deriveLifecycle(mkAgent({ lastEvent: evt("thought", { text: "hi" }) }), Date.now())).toBe("active");
  });
});

describe("ttcTier", () => {
  it("tiers up with sparkline volume", () => {
    expect(ttcTier(mkAgent({ sparkline: new Array(20).fill(0) }))).toBe(0);
    expect(ttcTier(mkAgent({ sparkline: new Array(20).fill(1) }))).toBe(2);
    expect(ttcTier(mkAgent({ sparkline: new Array(20).fill(3) }))).toBe(3);
  });
});
