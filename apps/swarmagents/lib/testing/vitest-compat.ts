/**
 * Minimal vitest-compatible `describe` / `it` / `expect` on top of node:test
 * and node:assert, so ported vitest suites run unchanged under `npm test`
 * (tsx --test). Only the matchers our suites use are implemented.
 */
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import assert from "node:assert/strict";
import { format } from "node:util";

type Fn = () => unknown | Promise<unknown>;

export function describe(name: string, fn: () => void): void {
  nodeDescribe(name, fn);
}

function itImpl(name: string, fn: Fn): void {
  nodeIt(name, async () => {
    await fn();
  });
}

function each<T extends readonly unknown[]>(cases: readonly T[]) {
  return (name: string, fn: (...args: T) => unknown | Promise<unknown>): void => {
    for (const row of cases) {
      const args = (Array.isArray(row) ? row : [row]) as unknown as T;
      itImpl(format(name, ...args), () => fn(...args));
    }
  };
}

export const it = Object.assign(itImpl, { each });
export const test = it;

function isSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => isSubset(actual[i], e));
  }
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
    isSubset((actual as Record<string, unknown>)[k], v),
  );
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, message: string): void => {
    if (pass === negate) assert.fail(negate ? `Expected NOT: ${message}` : message);
  };
  const show = (v: unknown) => format("%o", v);
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `${show(actual)} to be ${show(expected)}`),
    toEqual: (expected: unknown) => {
      let pass = true;
      try {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)));
      } catch {
        pass = false;
      }
      check(pass, `${show(actual)} to equal ${show(expected)}`);
    },
    toMatchObject: (expected: unknown) => check(isSubset(actual, expected), `${show(actual)} to match ${show(expected)}`),
    toContain: (item: unknown) => {
      const pass =
        typeof actual === "string"
          ? actual.includes(String(item))
          : Array.isArray(actual) || actual instanceof Set
            ? [...(actual as Iterable<unknown>)].some((x) => Object.is(x, item))
            : false;
      check(pass, `${show(actual)} to contain ${show(item)}`);
    },
    toHaveLength: (n: number) => check((actual as { length?: number })?.length === n, `${show(actual)} to have length ${n}`),
    toBeNull: () => check(actual === null, `${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `${show(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, `${show(actual)} to be defined`),
    toBeTruthy: () => check(Boolean(actual), `${show(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `${show(actual)} to be falsy`),
    toBeLessThan: (n: number) => check((actual as number) < n, `${show(actual)} < ${n}`),
    toBeLessThanOrEqual: (n: number) => check((actual as number) <= n, `${show(actual)} <= ${n}`),
    toBeGreaterThan: (n: number) => check((actual as number) > n, `${show(actual)} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check((actual as number) >= n, `${show(actual)} >= ${n}`),
    toBeCloseTo: (n: number, digits = 2) =>
      check(Math.abs((actual as number) - n) < Math.pow(10, -digits) / 2, `${show(actual)} to be close to ${n}`),
    toBeInstanceOf: (ctor: abstract new (...args: never[]) => unknown) =>
      check(actual instanceof ctor, `${show(actual)} to be instance of ${ctor.name}`),
    toThrow: (expected?: string | RegExp | (abstract new (...args: never[]) => unknown)) => {
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (err) {
        didThrow = true;
        thrown = err;
      }
      let pass = didThrow;
      if (didThrow && expected !== undefined) {
        const msg = thrown instanceof Error ? thrown.message : String(thrown);
        if (typeof expected === "string") pass = msg.includes(expected);
        else if (expected instanceof RegExp) pass = expected.test(msg);
        else pass = thrown instanceof expected;
      }
      check(pass, `function to throw${expected !== undefined ? ` ${show(expected)}` : ""}`);
    },
  };
}

export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true) });
}
