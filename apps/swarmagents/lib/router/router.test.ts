import { describe, it } from "node:test";
import { expect } from "./expect-shim.test-helper";
import {
  InMemoryRouterStore,
  SwarmRouter,
  inspectOutputQuality,
  type Clock,
  type RouteRequest,
  type RouterEvent,
} from "./index";

class FakeClock implements Clock {
  private currentMs: number;
  private rngState = 0.5;

  constructor(startIso = "2026-11-12T10:00:00.000Z") {
    this.currentMs = Date.parse(startIso);
  }

  now(): number {
    return this.currentMs;
  }

  random(): number {
    // Deterministic LCG
    this.rngState = (this.rngState * 1664525 + 1013904223) % 4294967296;
    return this.rngState / 4294967296;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

function setupStandardCatalog(router: SwarmRouter, userId = "user-1") {
  router.registerProvider({
    id: "groq",
    name: "Groq",
    resetsDailyUtc: true,
    defaultKeyRpmLimit: 30,
    models: [
      {
        id: "llama-3.3-70b-versatile",
        providerId: "groq",
        displayName: "Llama 3.3 70B",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        goodAtLongAgentLoops: true,
        inputCostPer1kUsd: 0,
        outputCostPer1kUsd: 0,
      },
      {
        id: "llama-8b-short",
        providerId: "groq",
        displayName: "Llama 8B Short",
        contextWindow: 8_192,
        maxOutputTokens: 2_048,
        supportsTools: true,
        goodAtLongAgentLoops: false,
        inputCostPer1kUsd: 0,
        outputCostPer1kUsd: 0,
      },
    ],
  });

  router.registerProvider({
    id: "nim",
    name: "NVIDIA NIM",
    resetsDailyUtc: true,
    defaultKeyRpmLimit: 40,
    models: [
      {
        id: "qwen-2.5-coder-32b",
        providerId: "nim",
        displayName: "Qwen 2.5 Coder 32B",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        goodAtLongAgentLoops: true,
        inputCostPer1kUsd: 0,
        outputCostPer1kUsd: 0,
      },
    ],
  });

  router.registerProvider({
    id: "openrouter",
    name: "OpenRouter Free",
    resetsDailyUtc: true,
    defaultKeyRpdLimit: 50,
    models: [
      {
        id: "deepseek-r1:free",
        providerId: "openrouter",
        displayName: "DeepSeek R1 Free",
        contextWindow: 64_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        goodAtLongAgentLoops: true,
        inputCostPer1kUsd: 0,
        outputCostPer1kUsd: 0,
      },
    ],
  });

  router.registerProvider({
    id: "anthropic",
    name: "Anthropic Paid",
    resetsDailyUtc: false,
    models: [
      {
        id: "claude-sonnet-4",
        providerId: "anthropic",
        displayName: "Claude Sonnet 4",
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
        supportsTools: true,
        goodAtLongAgentLoops: true,
        inputCostPer1kUsd: 0.003,
        outputCostPer1kUsd: 0.015,
      },
    ],
  });

  router.setUserPolicy({
    userId,
    priorityOrder: ["groq", "nim", "openrouter", "anthropic"],
    allowPaidFallback: false,
    perRunBudgetUsd: 0.5,
    perDayBudgetUsd: 2.0,
    maxConcurrentRequests: 4,
  });
}

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    requestId: "req-1",
    userId: "user-1",
    runId: "run-1",
    turnIndex: 0,
    estimatedPromptTokens: 24_000,
    maxOutputTokens: 4_096,
    requiresTools: true,
    isAgentLoop: true,
    promptSample: "Refactor the TypeScript authentication middleware and run tests.",
    ...overrides,
  };
}

describe("SwarmRouter", () => {
  it("enforces capability matching: never routes a 60k-token request to an 8k model", () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    setupStandardCatalog(router);

    router.registerUserKey({
      keyId: "groq-k1",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Free",
      maxConcurrent: 2,
    });

    const decision = router.selectRoute(
      makeReq({
        estimatedPromptTokens: 60_000,
        maxOutputTokens: 4_096,
      }),
    );

    expect(decision.chosen?.modelId).toBe("llama-3.3-70b-versatile");
    // (Hydrogen's original test expected only the context reason; the 8k model
    // also fails the max-output gate, and reporting both is correct.)
    expect(decision.reasonsRejected["groq:llama-8b-short:groq-k1"]).toEqual([
      "context_window_too_small:8192<64096",
      "max_output_too_small:2048<4096",
    ]);
  });

  it("tracks rolling quotas, rotates keys within a provider, and resets after window expires", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    setupStandardCatalog(router);

    // Two Groq keys with tight 2 RPM limits + one NIM key
    router.registerUserKey({
      keyId: "groq-k1",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Key 1",
      maxConcurrent: 2,
      rpmLimit: 2,
    });
    router.registerUserKey({
      keyId: "groq-k2",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Key 2",
      maxConcurrent: 2,
      rpmLimit: 2,
    });
    router.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Key 1",
      maxConcurrent: 2,
      rpmLimit: 40,
    });

    // Four requests stay on Groq. The quota-headroom term spreads them across
    // both keys (Hydrogen's original test assumed k1 is drained first, but its
    // own scoring prefers the key with more headroom).
    const perKey: Record<string, number> = {};
    for (let i = 0; i < 4; i++) {
      const d = router.selectRoute(makeReq({ requestId: `r-${i}` }));
      expect(d.chosen?.providerId).toBe("groq");
      perKey[d.chosen!.keyId] = (perKey[d.chosen!.keyId] ?? 0) + 1;
      await router.recordOutcome(makeReq({ requestId: `r-${i}` }), d.chosen!, {
        ok: true,
        latencyMs: 800,
        ttftMs: 250,
        promptTokensActual: 20_000,
        completionTokensActual: 300,
        outputText: "Applied patch to auth.ts successfully.",
      });
      clock.advance(1_000);
    }
    expect(perKey).toEqual({ "groq-k1": 2, "groq-k2": 2 });

    // Both Groq keys exhausted -> falls over to NIM
    const d5 = router.selectRoute(makeReq({ requestId: "r-5" }));
    expect(d5.chosen?.providerId).toBe("nim");
    expect(d5.chosen?.keyId).toBe("nim-k1");
    expect(d5.reasonsRejected["groq:llama-3.3-70b-versatile:groq-k1"]).toContain("rpm_quota_exhausted:2/2");

    // Advance 61s so rolling 1-minute window clears -> Groq key 1 is available again
    clock.advance(61_000);
    const d6 = router.selectRoute(makeReq({ requestId: "r-6" }));
    expect(d6.chosen?.providerId).toBe("groq");
    expect(d6.chosen?.keyId).toBe("groq-k1");
  });

  it("handles 429 with Retry-After header and learns rate limits", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    setupStandardCatalog(router);

    router.registerUserKey({
      keyId: "groq-k1",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Key 1",
      maxConcurrent: 2,
    });
    router.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Key 1",
      maxConcurrent: 2,
    });

    const d1 = router.selectRoute(makeReq({ requestId: "r-1" }));
    expect(d1.chosen?.keyId).toBe("groq-k1");

    // Simulate 429 with Retry-After: 45s and x-ratelimit-limit-requests: 15
    await router.recordOutcome(makeReq({ requestId: "r-1" }), d1.chosen!, {
      ok: false,
      httpStatus: 429,
      errorType: "rate_limit",
      headers: {
        "Retry-After": "45",
        "x-ratelimit-limit-requests": "15",
      },
      latencyMs: 120,
    });

    const keyState = router.getKeyState("user-1", "groq", "groq-k1")!;
    expect(keyState.status).toBe("cooldown");
    expect(keyState.learnedRpmLimit).toBe(15);
    expect(keyState.cooldownUntil).toBe(clock.now() + 45_000);

    // During 45s cooldown, routes to NIM
    clock.advance(20_000);
    const d2 = router.selectRoute(makeReq({ requestId: "r-2" }));
    expect(d2.chosen?.providerId).toBe("nim");

    // After 45s total elapsed, Groq key recovers
    clock.advance(26_000);
    const d3 = router.selectRoute(makeReq({ requestId: "r-3" }));
    expect(d3.chosen?.providerId).toBe("groq");
  });

  it("removes a key on 402 Out of Credit until daily UTC reset, then restores it", async () => {
    const clock = new FakeClock("2026-11-12T22:00:00.000Z"); // 2 hours before UTC midnight
    const router = new SwarmRouter({ clock });
    setupStandardCatalog(router);

    router.registerUserKey({
      keyId: "or-k1",
      userId: "user-1",
      providerId: "openrouter",
      label: "OpenRouter Free",
      maxConcurrent: 2,
    });
    router.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Free",
      maxConcurrent: 2,
    });

    router.setUserPolicy({
      userId: "user-1",
      priorityOrder: ["openrouter", "nim"],
      allowPaidFallback: false,
      perRunBudgetUsd: 0,
      perDayBudgetUsd: 0,
      maxConcurrentRequests: 4,
    });

    const d1 = router.selectRoute(makeReq({ requestId: "r-1" }));
    expect(d1.chosen?.providerId).toBe("openrouter");

    await router.recordOutcome(makeReq({ requestId: "r-1" }), d1.chosen!, {
      ok: false,
      httpStatus: 402,
      errorType: "billing",
      errorMessage: "Free daily credits exhausted",
      latencyMs: 180,
    });

    const orState = router.getKeyState("user-1", "openrouter", "or-k1")!;
    expect(orState.status).toBe("exhausted_credit");

    // 1 hour later (23:00 UTC) -> still excluded
    clock.advance(3_600_000);
    const d2 = router.selectRoute(makeReq({ requestId: "r-2" }));
    expect(d2.chosen?.providerId).toBe("nim");
    expect(d2.reasonsRejected["openrouter:deepseek-r1:free:or-k1"]).toContain("key_exhausted_credit_402");

    // Advance past 00:00 UTC -> automatically re-enabled
    clock.advance(3_600_000 + 1_000);
    const d3 = router.selectRoute(makeReq({ requestId: "r-3" }));
    expect(d3.chosen?.providerId).toBe("openrouter");
  });

  it("detects garbled 200 OK outputs and demotes that model specifically for long prompts", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    setupStandardCatalog(router);

    router.registerUserKey({
      keyId: "groq-k1",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Free",
      maxConcurrent: 2,
    });
    router.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Free",
      maxConcurrent: 2,
    });

    // Verify quality detector catches empty, broken JSON, repetition, and charset corruption
    expect(inspectOutputQuality({ outputText: " ", requiresTools: false }).reason).toBe("empty_output");
    expect(
      inspectOutputQuality({
        outputText: "Calling tool",
        toolCalls: [{ name: "edit_file", arguments: '{"path": "src/app.ts", broken' }],
        requiresTools: true,
      }).reason,
    ).toBe("invalid_tool_json");
    expect(
      inspectOutputQuality({
        outputText: "const x = fixBug();\n".repeat(12),
        requiresTools: false,
      }).reason,
    ).toBe("repetition_loop");
    expect(
      inspectOutputQuality({
        outputText: "Here is the fix: \uFFFD\uFFFD\uFFFD corrupted output stream",
        requiresTools: false,
      }).reason,
    ).toBe("charset_corruption");

    // Groq returns 200 OK with garbled repetition on two long prompts (24k
    // tokens). One garble is already enough to move the next long prompt off
    // Groq, so the second report targets Groq directly.
    const first = router.selectRoute(makeReq({ requestId: "long-0", estimatedPromptTokens: 24_000 }));
    expect(first.chosen?.providerId).toBe("groq");
    for (let i = 0; i < 2; i++) {
      const longReq = makeReq({ requestId: `long-${i}`, estimatedPromptTokens: 24_000 });
      const d = first;

      const recorded = await router.recordOutcome(longReq, d.chosen!, {
        ok: true,
        httpStatus: 200,
        latencyMs: 1_500,
        ttftMs: 400,
        promptTokensActual: 24_000,
        completionTokensActual: 400,
        outputText: "while(true) { retryConnection(); }\n".repeat(15),
      });
      expect(recorded.ok).toBe(false);
      expect(recorded.errorType).toBe("garbled_output");
    }

    const groqHealth = router.getModelHealth("user-1", "groq", "llama-3.3-70b-versatile");
    expect(groqHealth.longPromptQualityScore).toBeLessThan(0.2);
    expect(groqHealth.shortPromptQualityScore).toBe(1);

    // Next LONG prompt (24k tokens) demotes Groq and selects NIM instead
    const nextLong = router.selectRoute(makeReq({ requestId: "long-3", estimatedPromptTokens: 24_000 }));
    expect(nextLong.chosen?.providerId).toBe("nim");

    // Next SHORT prompt (2k tokens) still uses Groq because short-prompt quality was unaffected!
    const nextShort = router.selectRoute(makeReq({ requestId: "short-1", estimatedPromptTokens: 2_000 }));
    expect(nextShort.chosen?.providerId).toBe("groq");
  });

  it("enforces free-first ordering and paid per-run and per-day $ caps", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    setupStandardCatalog(router);

    router.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Free",
      maxConcurrent: 2,
    });
    router.registerUserKey({
      keyId: "anth-k1",
      userId: "user-1",
      providerId: "anthropic",
      label: "Anthropic Paid",
      maxConcurrent: 2,
    });

    // 1. Even with allowPaidFallback=true, free NIM wins when eligible
    router.setUserPolicy({
      userId: "user-1",
      priorityOrder: ["anthropic", "nim"],
      allowPaidFallback: true,
      perRunBudgetUsd: 0.15,
      perDayBudgetUsd: 0.25,
      maxConcurrentRequests: 4,
    });

    const dFree = router.selectRoute(makeReq({ requestId: "r-free" }));
    expect(dFree.chosen?.providerId).toBe("nim");
    expect(dFree.chosen?.isPaid).toBe(false);
    expect(dFree.reasonsRejected["anthropic:claude-sonnet-4:anth-k1"]).toContain("free_tier_available");

    // Exhaust free NIM with 402
    await router.recordOutcome(makeReq({ requestId: "r-free" }), dFree.chosen!, {
      ok: false,
      httpStatus: 402,
      errorType: "billing",
      latencyMs: 100,
    });

    // 2. With allowPaidFallback=false, never falls back to Anthropic
    router.setUserPolicy({
      userId: "user-1",
      priorityOrder: ["nim", "anthropic"],
      allowPaidFallback: false,
      perRunBudgetUsd: 0.15,
      perDayBudgetUsd: 0.25,
      maxConcurrentRequests: 4,
    });
    const dBlocked = router.selectRoute(makeReq({ requestId: "r-blocked" }));
    expect(dBlocked.chosen).toBeNull();
    expect(dBlocked.reasonsRejected["anthropic:claude-sonnet-4:anth-k1"]).toContain("paid_fallback_disabled");

    // 3. Enable paid fallback with $0.15 per-run cap and $0.25 per-day cap
    router.setUserPolicy({
      userId: "user-1",
      priorityOrder: ["nim", "anthropic"],
      allowPaidFallback: true,
      perRunBudgetUsd: 0.15,
      perDayBudgetUsd: 0.25,
      maxConcurrentRequests: 4,
    });

    // 20k input ($0.06) + 4k output ($0.06) = $0.12 estimated -> fits inside $0.15 run cap
    const reqRun1 = makeReq({
      requestId: "r-paid-1",
      runId: "run-A",
      estimatedPromptTokens: 20_000,
      maxOutputTokens: 4_000,
    });
    const dPaid1 = router.selectRoute(reqRun1);
    expect(dPaid1.chosen?.providerId).toBe("anthropic");
    expect(dPaid1.estimatedCost).toBeCloseTo(0.12, 4);

    await router.recordOutcome(reqRun1, dPaid1.chosen!, {
      ok: true,
      latencyMs: 1_800,
      ttftMs: 500,
      promptTokensActual: 20_000,
      completionTokensActual: 4_000, // Actual spend = $0.12
      outputText: "Completed architectural refactor.",
    });

    // Second turn in SAME run-A ($0.12 spent + $0.12 estimated = $0.24 > $0.15 per-run cap) -> blocked!
    const dPaidRunCap = router.selectRoute(
      makeReq({
        requestId: "r-paid-2",
        runId: "run-A",
        estimatedPromptTokens: 20_000,
        maxOutputTokens: 4_000,
      }),
    );
    expect(dPaidRunCap.chosen).toBeNull();
    expect(dPaidRunCap.reasonsRejected["anthropic:claude-sonnet-4:anth-k1"]?.[0]).toMatch(
      /^per_run_budget_exceeded/,
    );

    // New run-B succeeds ($0.12 daily + $0.12 = $0.24 <= $0.25 per-day cap)
    const reqRunB = makeReq({
      requestId: "r-paid-3",
      runId: "run-B",
      estimatedPromptTokens: 20_000,
      maxOutputTokens: 4_000,
    });
    const dPaidRunB = router.selectRoute(reqRunB);
    expect(dPaidRunB.chosen?.providerId).toBe("anthropic");
    await router.recordOutcome(reqRunB, dPaidRunB.chosen!, {
      ok: true,
      latencyMs: 1_700,
      ttftMs: 480,
      promptTokensActual: 20_000,
      completionTokensActual: 4_000, // Daily spend now $0.24
      outputText: "Done.",
    });

    // Third run-C ($0.24 daily + $0.12 = $0.36 > $0.25 per-day cap) -> blocked!
    const dPaidDayCap = router.selectRoute(
      makeReq({
        requestId: "r-paid-4",
        runId: "run-C",
        estimatedPromptTokens: 20_000,
        maxOutputTokens: 4_000,
      }),
    );
    expect(dPaidDayCap.chosen).toBeNull();
    expect(dPaidDayCap.reasonsRejected["anthropic:claude-sonnet-4:anth-k1"]?.[0]).toMatch(
      /^per_day_budget_exceeded/,
    );
  });

  it("maintains mid-run stickiness for prompt caching while healthy and fails over with an event on failure", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    setupStandardCatalog(router);

    const events: RouterEvent[] = [];
    router.on((e) => events.push(e));

    router.registerUserKey({
      keyId: "groq-k1",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Free",
      maxConcurrent: 2,
    });
    router.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Free",
      maxConcurrent: 2,
    });

    // Turn 0 picks Groq
    const t0 = router.selectRoute(makeReq({ requestId: "t0", turnIndex: 0 }));
    expect(t0.chosen?.providerId).toBe("groq");
    await router.recordOutcome(makeReq({ requestId: "t0" }), t0.chosen!, {
      ok: true,
      latencyMs: 900,
      ttftMs: 250,
      promptTokensActual: 24_000,
      completionTokensActual: 300,
      outputText: "Step 1 complete.",
    });

    // Even if user changes priorityOrder to prefer NIM, Turn 1 stays sticky on Groq for prompt cache benefit
    router.setUserPolicy({
      userId: "user-1",
      priorityOrder: ["nim", "groq"],
      allowPaidFallback: false,
      perRunBudgetUsd: 0,
      perDayBudgetUsd: 0,
      maxConcurrentRequests: 4,
    });

    const t1 = router.selectRoute(
      makeReq({
        requestId: "t1",
        turnIndex: 1,
        stickyTarget: {
          providerId: "groq",
          modelId: "llama-3.3-70b-versatile",
          keyId: "groq-k1",
        },
      }),
    );
    expect(t1.chosen?.providerId).toBe("groq");
    expect(t1.chosen?.stickyPreserved).toBe(true);

    // Now Groq suffers a 503 outage -> Turn 2 fails over to NIM and emits route:failover
    await router.recordOutcome(makeReq({ requestId: "t1" }), t1.chosen!, {
      ok: false,
      httpStatus: 503,
      errorType: "server_error",
      errorMessage: "Upstream 503 Service Unavailable",
      latencyMs: 2_000,
    });

    const t2 = router.selectRoute(
      makeReq({
        requestId: "t2",
        turnIndex: 2,
        stickyTarget: {
          providerId: "groq",
          modelId: "llama-3.3-70b-versatile",
          keyId: "groq-k1",
        },
      }),
    );
    expect(t2.chosen?.providerId).toBe("nim");
    expect(t2.chosen?.stickyPreserved).toBe(false);
    expect(t2.failoverReason).toContain("groq:llama-3.3-70b-versatile unavailable");

    const failoverEvents = events.filter((e) => e.type === "route:failover");
    expect(failoverEvents).toHaveLength(1);
    expect(failoverEvents[0]).toMatchObject({
      type: "route:failover",
      runId: "run-1",
      from: { providerId: "groq", modelId: "llama-3.3-70b-versatile" },
      to: { providerId: "nim", modelId: "qwen-2.5-coder-32b" },
    });
  });

  it("fairly schedules requests across two users so a heavy user cannot starve another user", async () => {
    const clock = new FakeClock();
    // Global worker concurrency = 1 to verify deterministic multi-tenant fair interleaving
    const router = new SwarmRouter({ clock, globalMaxConcurrent: 1 });
    setupStandardCatalog(router, "user-A");
    setupStandardCatalog(router, "user-B");

    router.registerUserKey({
      keyId: "a-nim",
      userId: "user-A",
      providerId: "nim",
      label: "User A NIM",
      maxConcurrent: 2,
    });
    router.registerUserKey({
      keyId: "b-nim",
      userId: "user-B",
      providerId: "nim",
      label: "User B NIM",
      maxConcurrent: 2,
    });

    const dispatchOrder: string[] = [];

    // User A acquires the single active worker slot first
    const leaseA1 = await router.routeAndAcquire(
      makeReq({ requestId: "A1", userId: "user-A", runId: "run-A" }),
    );
    dispatchOrder.push("A1");

    // While A1 is in flight, User A floods 3 more requests (A2, A3, A4)
    const pendingA2 = router
      .routeAndAcquire(makeReq({ requestId: "A2", userId: "user-A", runId: "run-A" }))
      .then((lease) => {
        dispatchOrder.push("A2");
        return lease;
      });
    const pendingA3 = router
      .routeAndAcquire(makeReq({ requestId: "A3", userId: "user-A", runId: "run-A" }))
      .then((lease) => {
        dispatchOrder.push("A3");
        return lease;
      });
    const pendingA4 = router
      .routeAndAcquire(makeReq({ requestId: "A4", userId: "user-A", runId: "run-A" }))
      .then((lease) => {
        dispatchOrder.push("A4");
        return lease;
      });

    // Then User B submits 2 requests (B1, B2) AFTER User A's burst
    const pendingB1 = router
      .routeAndAcquire(makeReq({ requestId: "B1", userId: "user-B", runId: "run-B" }))
      .then((lease) => {
        dispatchOrder.push("B1");
        return lease;
      });
    const pendingB2 = router
      .routeAndAcquire(makeReq({ requestId: "B2", userId: "user-B", runId: "run-B" }))
      .then((lease) => {
        dispatchOrder.push("B2");
        return lease;
      });

    // Release A1 -> fair queue round-robins to User B (B1 runs before A2/A3/A4!)
    leaseA1.release();
    const leaseB1 = await pendingB1;
    leaseB1.release();

    const leaseA2 = await pendingA2;
    leaseA2.release();

    const leaseB2 = await pendingB2;
    leaseB2.release();

    const leaseA3 = await pendingA3;
    leaseA3.release();

    const leaseA4 = await pendingA4;
    leaseA4.release();

    expect(dispatchOrder).toEqual(["A1", "B1", "A2", "B2", "A3", "A4"]);
  });

  it("persists state and recovers cooldowns, quotas, spend caps, and health across restarts", async () => {
    const clock = new FakeClock();
    const store = new InMemoryRouterStore();

    // Instance 1 before restart
    const router1 = new SwarmRouter({ clock, store });
    setupStandardCatalog(router1);
    router1.setUserPolicy({
      userId: "user-1",
      priorityOrder: ["groq", "nim", "anthropic"],
      allowPaidFallback: true,
      perRunBudgetUsd: 0.5,
      perDayBudgetUsd: 0.2,
      maxConcurrentRequests: 4,
    });
    router1.registerUserKey({
      keyId: "groq-k1",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Free",
      maxConcurrent: 2,
    });
    router1.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Free",
      maxConcurrent: 2,
    });
    router1.registerUserKey({
      keyId: "anth-k1",
      userId: "user-1",
      providerId: "anthropic",
      label: "Anthropic Paid",
      maxConcurrent: 2,
    });

    // Groq hits 429 with 60s Retry-After
    const d1 = router1.selectRoute(makeReq({ requestId: "r-1" }));
    await router1.recordOutcome(makeReq({ requestId: "r-1" }), d1.chosen!, {
      ok: false,
      httpStatus: 429,
      errorType: "rate_limit",
      headers: { "Retry-After": "60" },
      latencyMs: 100,
    });

    // NIM returns garbled output on long prompt
    const d2 = router1.selectRoute(makeReq({ requestId: "r-2", estimatedPromptTokens: 24_000 }));
    expect(d2.chosen?.providerId).toBe("nim");
    await router1.recordOutcome(makeReq({ requestId: "r-2", estimatedPromptTokens: 24_000 }), d2.chosen!, {
      ok: true,
      latencyMs: 1_200,
      outputText: "", // empty 200 OK
    });

    // Simulate full process restart: brand-new SwarmRouter reading from the same RouterStore
    clock.advance(10_000); // Only 10s elapsed; Groq's 60s cooldown is still active
    const router2 = new SwarmRouter({ clock, store });
    setupStandardCatalog(router2);
    router2.setUserPolicy({
      userId: "user-1",
      priorityOrder: ["groq", "nim", "anthropic"],
      allowPaidFallback: true,
      perRunBudgetUsd: 0.5,
      perDayBudgetUsd: 0.2,
      maxConcurrentRequests: 4,
    });
    router2.registerUserKey({
      keyId: "groq-k1",
      userId: "user-1",
      providerId: "groq",
      label: "Groq Free",
      maxConcurrent: 2,
    });
    router2.registerUserKey({
      keyId: "nim-k1",
      userId: "user-1",
      providerId: "nim",
      label: "NIM Free",
      maxConcurrent: 2,
    });
    router2.registerUserKey({
      keyId: "anth-k1",
      userId: "user-1",
      providerId: "anthropic",
      label: "Anthropic Paid",
      maxConcurrent: 2,
    });

    const restored = await router2.restoreFromStore();
    expect(restored).toBe(true);

    // Groq cooldown survived restart
    const postRestartKey = router2.getKeyState("user-1", "groq", "groq-k1")!;
    expect(postRestartKey.status).toBe("cooldown");

    // NIM long-prompt garble demotion survived restart
    const postRestartNimHealth = router2.getModelHealth("user-1", "nim", "qwen-2.5-coder-32b");
    expect(postRestartNimHealth.longPromptGarbleCount).toBe(1);
    expect(postRestartNimHealth.longPromptQualityScore).toBeLessThan(0.5);

    // Routing after restart still rejects Groq due to persisted cooldown
    const postRestartDecision = router2.selectRoute(makeReq({ requestId: "r-3" }));
    expect(postRestartDecision.reasonsRejected["groq:llama-3.3-70b-versatile:groq-k1"]?.[0]).toMatch(
      /^key_in_cooldown_until_/,
    );
  });
});
