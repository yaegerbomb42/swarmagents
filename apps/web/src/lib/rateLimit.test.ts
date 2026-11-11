import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// In-memory backend determinism: fresh module load per test
const load = async () => {
  vi.resetModules();
  delete process.env.REDIS_REST_URL;
  delete process.env.REDIS_REST_TOKEN;
  return await import("./rateLimit");
};

describe("rateLimit (in-memory backend)", () => {
  beforeEach(() => {
    delete process.env.REDIS_REST_URL;
    delete process.env.REDIS_REST_TOKEN;
  });
  afterEach(() => vi.restoreAllMocks());

  it("allows up to `limit` requests in the window, then 429", async () => {
    const { rateLimit } = await load();
    const key = `k:${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      const r = await rateLimit(key, 5);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(5 - i - 1);
    }
    const blocked = await rateLimit(key, 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
    expect(blocked.backend).toBe("memory");
  });

  it("isolates counters per key", async () => {
    const { rateLimit } = await load();
    const a = `a:${Math.random()}`;
    const b = `b:${Math.random()}`;
    for (let i = 0; i < 3; i++) await rateLimit(a, 3);
    const blockedA = await rateLimit(a, 3);
    const allowedB = await rateLimit(b, 3);
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it("resets after the fixed window elapses", async () => {
    const { rateLimit } = await load();
    const key = `w:${Math.random()}`;
    await rateLimit(key, 1);
    expect((await rateLimit(key, 1)).allowed).toBe(false);
    // Fast-forward past the 60s window
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
    expect((await rateLimit(key, 1)).allowed).toBe(true);
  });
});
