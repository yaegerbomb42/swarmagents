/**
 * Regression tests for the bugs found while reviewing Hydrogen's router
 * (see the PR description). Each test fails against the original code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FairTenantQueue } from "./fair-queue";
import { parseRateLimitHeaders } from "./rolling-window";
import {
  InMemoryRouterStore,
  SwarmRouter,
  type Clock,
  type ModelConfigInput,
  type RouteRequest,
  type RouterSnapshot,
  type RouterStore,
} from "./index";

class FakeClock implements Clock {
  t = Date.parse("2026-11-12T10:00:00.000Z");
  now() {
    return this.t;
  }
  random() {
    return 0.5;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

function model(id: string, providerId: string, extra: Partial<ModelConfigInput> = {}): ModelConfigInput {
  return {
    id,
    providerId,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    ...extra,
  };
}

function req(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    requestId: "r",
    userId: "u1",
    runId: "run-1",
    turnIndex: 0,
    estimatedPromptTokens: 2_000,
    maxOutputTokens: 1_024,
    requiresTools: false,
    ...overrides,
  };
}

/** Two free providers, "a" preferred over "b", one key each, for user u1. */
function twoProviders(router: SwarmRouter, userId = "u1", opts: { resetsDailyUtc?: boolean } = {}) {
  router.syncUser(userId, {
    providers: [
      { id: "a", name: "A", resetsDailyUtc: opts.resetsDailyUtc ?? false, models: [model("ma", "a")] },
      { id: "b", name: "B", resetsDailyUtc: opts.resetsDailyUtc ?? false, models: [model("mb", "b")] },
    ],
    keys: [
      { keyId: "ka", userId, providerId: "a", label: "a" },
      { keyId: "kb", userId, providerId: "b", label: "b" },
    ],
    policy: { userId, priorityOrder: ["a", "b"] },
  });
}

describe("router fixes", () => {
  it("fair queue holds the global slot until the lease is released", async () => {
    const q = new FairTenantQueue(1);
    const order: string[] = [];
    const releases: Record<string, () => void> = {};
    const enqueue = (user: string, id: string) =>
      q.enqueue(user, id, () => true, (release) => {
        order.push(id);
        releases[id] = release;
        return id;
      });
    await enqueue("A", "A1");
    const rest = [enqueue("A", "A2"), enqueue("B", "B1")];
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ["A1"], "nothing else may start while A1 is in flight");
    releases.A1!();
    await rest[1];
    assert.deepEqual(order, ["A1", "B1"], "B was never served, so it goes before A's second request");
    releases.B1!();
    await rest[0];
    assert.deepEqual(order, ["A1", "B1", "A2"]);
  });

  it("routeAndAcquire with no route frees the global slot immediately", async () => {
    const router = new SwarmRouter({ clock: new FakeClock(), globalMaxConcurrent: 1 });
    const first = await router.routeAndAcquire(req({ userId: "nobody" }));
    assert.equal(first.decision.chosen, null);
    const second = await router.routeAndAcquire(req({ userId: "nobody", requestId: "r2" }));
    assert.equal(second.decision.chosen, null);
  });

  it("a 429 on the first request does not learn an RPM limit of 1", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    twoProviders(router);
    const d = router.selectRoute(req());
    await router.recordOutcome(req(), d.chosen!, { ok: false, httpStatus: 429, latencyMs: 50 });
    assert.equal(router.getKeyState("u1", "a", "ka")!.learnedRpmLimit, undefined);
  });

  it("learned limits expire after the TTL", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock, learnedLimitTtlMs: 60 * 60_000 });
    twoProviders(router);
    const d = router.selectRoute(req());
    await router.recordOutcome(req(), d.chosen!, {
      ok: true,
      latencyMs: 100,
      outputText: "done",
      headers: { "x-ratelimit-limit-requests": "3" },
    });
    assert.equal(router.getKeyState("u1", "a", "ka")!.learnedRpmLimit, 3);
    clock.advance(60 * 60_000);
    assert.equal(router.getKeyState("u1", "a", "ka")!.learnedRpmLimit, undefined);
  });

  it("a 402 with no reset hint on a non-daily provider is retried after creditRetryMs, not never", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock, creditRetryMs: 15 * 60_000 });
    twoProviders(router);
    const d = router.selectRoute(req());
    assert.equal(d.chosen?.providerId, "a");
    await router.recordOutcome(req(), d.chosen!, { ok: false, httpStatus: 402, latencyMs: 50 });
    assert.equal(router.selectRoute(req()).chosen?.providerId, "b");
    clock.advance(15 * 60_000);
    assert.equal(router.getKeyState("u1", "a", "ka")!.status, "active");
    assert.equal(router.selectRoute(req()).chosen?.providerId, "a");
  });

  it("x-ratelimit-reset given as seconds-from-now is not read as a 1970 epoch", () => {
    const now = Date.parse("2026-11-12T10:00:00.000Z");
    assert.equal(parseRateLimitHeaders({ "x-ratelimit-reset": "30" }, now).resetAtMs, now + 30_000);
    // Epoch-seconds values parse as epoch time (not seconds-from-now), then
    // clamp to one day out: provider headers are untrusted, so a reset 63
    // days ahead must not exclude the key that long (see rolling-window.ts).
    assert.equal(parseRateLimitHeaders({ "x-ratelimit-reset": "1800000000" }, now).resetAtMs, now + 86_400_000);
  });

  it("one early failure is not a 100% error rate, and idle health decays back", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock, healthHalfLifeMs: 10 * 60_000, baseBackoffMs: 1_000 });
    twoProviders(router);
    const d = router.selectRoute(req());
    await router.recordOutcome(req(), d.chosen!, { ok: false, httpStatus: 503, latencyMs: 500 });
    const health = router.getModelHealth("u1", "a", "ma");
    assert.ok(health.ewmaErrorRate <= 0.25 + 1e-9, `error rate ${health.ewmaErrorRate}`);
    clock.advance(5_000); // cooldown over
    // Still recently failed: the healthy lower-priority provider wins.
    assert.equal(router.selectRoute(req()).chosen?.providerId, "b");
    // After an hour idle the error decays and the user's priority wins again.
    clock.advance(60 * 60_000);
    assert.equal(router.selectRoute(req()).chosen?.providerId, "a");
  });

  it("short-prompt garbles demote short prompts (shortPromptQualityScore is used)", async () => {
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock });
    twoProviders(router);
    const d = router.selectRoute(req());
    const out = await router.recordOutcome(req(), d.chosen!, { ok: true, latencyMs: 100, outputText: "" });
    assert.equal(out.errorType, "garbled_output");
    assert.equal(router.selectRoute(req()).chosen?.providerId, "b");
    // Long prompts are unaffected.
    assert.equal(router.selectRoute(req({ estimatedPromptTokens: 30_000 })).chosen?.providerId, "a");
  });

  it("provider catalogs are per user and syncUser drops removed keys", () => {
    const router = new SwarmRouter({ clock: new FakeClock() });
    twoProviders(router, "u1");
    router.syncUser("u2", {
      providers: [{ id: "c", name: "C", models: [model("mc", "c")] }],
      keys: [{ keyId: "kc", userId: "u2", providerId: "c", label: "c" }],
      policy: { userId: "u2" },
    });
    const u2 = router.selectRoute(req({ userId: "u2" }));
    assert.equal(u2.chosen?.providerId, "c");
    assert.ok(u2.candidatesConsidered.every((c) => c.providerId === "c"), "u1's providers are invisible to u2");
    twoProviders(router, "u1");
    router.syncUser("u1", {
      providers: [{ id: "a", name: "A", models: [model("ma", "a")] }],
      keys: [{ keyId: "ka", userId: "u1", providerId: "a", label: "a" }],
      policy: { userId: "u1" },
    });
    assert.equal(router.getKeyState("u1", "b", "kb"), undefined);
  });

  it("isFree override, null budgets and freeFirst=false", () => {
    const router = new SwarmRouter({ clock: new FakeClock() });
    router.syncUser("u1", {
      providers: [
        // Unknown price (0) but not free: must still count as paid.
        { id: "paid", name: "P", models: [model("mp", "paid", { isFree: false })] },
        { id: "free", name: "F", models: [model("mf", "free", { isFree: true })] },
      ],
      keys: [
        { keyId: "kp", userId: "u1", providerId: "paid", label: "p" },
        { keyId: "kf", userId: "u1", providerId: "free", label: "f" },
      ],
      policy: {
        userId: "u1",
        priorityOrder: ["paid", "free"],
        allowPaidFallback: true,
        perRunBudgetUsd: null,
        perDayBudgetUsd: null,
      },
    });
    const freeFirst = router.selectRoute(req());
    assert.equal(freeFirst.chosen?.providerId, "free");
    assert.deepEqual(freeFirst.reasonsRejected["paid:mp:kp"], ["free_tier_available"]);
    router.setUserPolicy({
      userId: "u1",
      priorityOrder: ["paid", "free"],
      allowPaidFallback: true,
      perRunBudgetUsd: null,
      perDayBudgetUsd: null,
      freeFirst: false,
    });
    assert.equal(router.selectRoute(req()).chosen?.providerId, "paid");
  });

  it("excludeTargets skips candidates that already failed this request", () => {
    const router = new SwarmRouter({ clock: new FakeClock() });
    twoProviders(router);
    const d = router.selectRoute(req({ excludeTargets: ["a:ma:ka"] }));
    assert.equal(d.chosen?.providerId, "b");
    assert.deepEqual(d.reasonsRejected["a:ma:ka"], ["already_failed_this_request"]);
  });

  it("per-user stores save and restore one user's slice only", async () => {
    const files = new Map<string, string>();
    const store: RouterStore = {
      async loadSnapshot() {
        return null;
      },
      async saveSnapshot() {
        throw new Error("whole-snapshot save must not be used");
      },
      async loadUserSnapshot(userId) {
        const raw = files.get(userId);
        return raw ? (JSON.parse(raw) as RouterSnapshot) : null;
      },
      async saveUserSnapshot(userId, snapshot) {
        files.set(userId, JSON.stringify(snapshot));
      },
    };
    const clock = new FakeClock();
    const r1 = new SwarmRouter({ clock, store });
    twoProviders(r1, "u1");
    twoProviders(r1, "u2");
    const d = r1.selectRoute(req());
    await r1.recordOutcome(req(), d.chosen!, { ok: false, httpStatus: 401, latencyMs: 10 });
    assert.deepEqual([...files.keys()], ["u1"]);
    const saved = JSON.parse(files.get("u1")!) as RouterSnapshot;
    assert.ok(Object.values(saved.keys).every((k) => k.userId === "u1"));

    const r2 = new SwarmRouter({ clock, store });
    twoProviders(r2, "u1");
    assert.equal(await r2.restoreUser("u1"), true);
    assert.equal(r2.getKeyState("u1", "a", "ka")!.status, "disabled_auth");
    assert.equal(await r2.restoreUser("u2"), false);
  });

  it("rolling windows count requests at dispatch so concurrent calls respect RPM", async () => {
    const router = new SwarmRouter({ clock: new FakeClock() });
    router.syncUser("u1", {
      providers: [{ id: "a", name: "A", models: [model("ma", "a")] }],
      keys: [{ keyId: "ka", userId: "u1", providerId: "a", label: "a", rpmLimit: 1, maxConcurrent: 5 }],
      policy: { userId: "u1" },
    });
    const l1 = await router.routeAndAcquire(req({ requestId: "1" }));
    const l2 = await router.routeAndAcquire(req({ requestId: "2" }));
    assert.equal(l1.decision.chosen?.keyId, "ka");
    assert.equal(l2.decision.chosen, null);
    assert.ok(l2.decision.reasonsRejected["a:ma:ka"]!.some((r) => r.startsWith("rpm_quota_exhausted")));
    await l1.reportOutcome({ ok: true, latencyMs: 10, outputText: "ok" });
    // The outcome does not count the request a second time.
    assert.equal(router.getKeyState("u1", "a", "ka")!.rpmEntries.length, 1);
  });

  it("run spend history is bounded", async () => {
    const router = new SwarmRouter({ clock: new FakeClock(), maxTrackedRuns: 3 });
    router.syncUser("u1", {
      providers: [{ id: "p", name: "P", models: [model("mp", "p", { inputCostPer1kUsd: 0.001 })] }],
      keys: [{ keyId: "k", userId: "u1", providerId: "p", label: "k" }],
      policy: { userId: "u1", allowPaidFallback: true, perRunBudgetUsd: null, perDayBudgetUsd: null },
    });
    for (let i = 0; i < 5; i++) {
      const r = req({ runId: `run-${i}` });
      const d = router.selectRoute(r);
      await router.recordOutcome(r, d.chosen!, { ok: true, latencyMs: 10, outputText: "ok", promptTokensActual: 1000 });
    }
    assert.deepEqual(Object.keys(router.getUserUsage("u1").runSpendUsd), ["run-2", "run-3", "run-4"]);
  });

  it("InMemoryRouterStore round-trips the new optional fields", async () => {
    const store = new InMemoryRouterStore();
    const clock = new FakeClock();
    const router = new SwarmRouter({ clock, store });
    twoProviders(router);
    const d = router.selectRoute(req());
    await router.recordOutcome(req(), d.chosen!, {
      ok: true,
      latencyMs: 10,
      outputText: "ok",
      headers: { "x-ratelimit-limit-requests": "9" },
    });
    await router.persistToStore();
    const restored = new SwarmRouter({ clock, store });
    twoProviders(restored);
    assert.equal(await restored.restoreFromStore(), true);
    assert.equal(restored.getKeyState("u1", "a", "ka")!.learnedLimitsAt, clock.now());
  });
});
