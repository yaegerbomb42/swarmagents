/**
 * Minimal vitest-style `expect` on top of node:assert so the router's tests
 * (originally written for vitest) run on the repo's node:test runner.
 * Only the matchers the router tests use are implemented.
 */
import assert from "node:assert/strict";

function isSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, i) => isSubset(actual[i], item));
  }
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
    isSubset((actual as Record<string, unknown>)[k], v),
  );
}

export function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.ok(Object.is(actual, expected), `expected ${String(actual)} to be ${String(expected)}`),
    toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toBeLessThan: (n: number) => assert.ok((actual as number) < n, `expected ${String(actual)} < ${n}`),
    toBeGreaterThan: (n: number) => assert.ok((actual as number) > n, `expected ${String(actual)} > ${n}`),
    toBeCloseTo: (n: number, digits = 2) =>
      assert.ok(Math.abs((actual as number) - n) < Math.pow(10, -digits) / 2, `expected ${String(actual)} ≈ ${n}`),
    toContain: (item: unknown) => {
      if (typeof actual === "string") assert.ok(actual.includes(String(item)), `expected "${actual}" to contain "${String(item)}"`);
      else assert.ok((actual as unknown[]).includes(item), `expected array to contain ${String(item)}`);
    },
    toHaveLength: (n: number) => assert.equal((actual as { length: number }).length, n),
    toMatch: (re: RegExp | string) => {
      assert.equal(typeof actual, "string", `expected a string, got ${String(actual)}`);
      if (typeof re === "string") assert.ok((actual as string).includes(re));
      else assert.match(actual as string, re);
    },
    toMatchObject: (expected: unknown) =>
      assert.ok(isSubset(actual, expected), `expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`),
  };
}
