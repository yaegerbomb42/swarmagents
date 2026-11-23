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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSubset(actual: unknown, expected: unknown, seen = new WeakSet<object>()): boolean {
  if (Object.is(actual, expected)) return true;
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  // Non-plain expected objects (Date, RegExp, Map, Set, class instances) must be
  // compared structurally instead of being treated as an empty set of keys.
  if (!isPlainObject(expected) && !Array.isArray(expected)) {
    try {
      assert.deepStrictEqual(actual, expected);
      return true;
    } catch {
      return false;
    }
  }
  // Cycle guard: once an expected object is being compared, assume a repeated
  // reference matches so circular structures cannot recurse forever.
  if (seen.has(expected)) return true;
  seen.add(expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => isSubset(actual[i], e, seen));
  }
  const record = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  // Require the key to exist on the received object so a missing key never
  // matches `{ key: undefined }`.
  return Object.keys(expectedRecord).every(
    (k) => Object.prototype.hasOwnProperty.call(record, k) && isSubset(record[k], expectedRecord[k], seen),
  );
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, message: string): void => {
    if (pass === negate) assert.fail(negate ? `Expected NOT: ${message}` : message);
  };
  const show = (v: unknown) => format("%o", v);
  // Coerce to a real number for the ordering matchers so non-numbers (null,
  // undefined, strings, booleans) and NaN never pass via JS coercion
  // (e.g. `null < 1`). NaN comparisons are all false, so a non-number fails.
  const num = typeof actual === "number" && !Number.isNaN(actual) ? actual : Number.NaN;
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `${show(actual)} to be ${show(expected)}`),
    toEqual: (expected: unknown) => {
      let pass = true;
      try {
        assert.deepStrictEqual(actual, expected);
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
    toBeLessThan: (n: number) => check(num < n, `${show(actual)} < ${n}`),
    toBeLessThanOrEqual: (n: number) => check(num <= n, `${show(actual)} <= ${n}`),
    toBeGreaterThan: (n: number) => check(num > n, `${show(actual)} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check(num >= n, `${show(actual)} >= ${n}`),
    toBeCloseTo: (n: number, digits = 2) =>
      check(Math.abs(num - n) < Math.pow(10, -digits) / 2, `${show(actual)} to be close to ${n}`),
    toBeInstanceOf: (ctor: abstract new (...args: never[]) => unknown) =>
      check(actual instanceof ctor, `${show(actual)} to be instance of ${ctor.name}`),
    toThrow: (expected?: string | RegExp | (abstract new (...args: never[]) => unknown)) => {
      let pass = false;
      // Only a function can "throw"; guard so expect(123).toThrow() fails
      // instead of calling 123() and catching the resulting TypeError as a pass.
      if (typeof actual === "function") {
        let thrown: unknown;
        let didThrow = false;
        try {
          (actual as () => unknown)();
        } catch (err) {
          didThrow = true;
          thrown = err;
        }
        pass = didThrow;
        if (didThrow && expected !== undefined) {
          const msg = thrown instanceof Error ? thrown.message : String(thrown);
          if (typeof expected === "string") pass = msg.includes(expected);
          else if (expected instanceof RegExp) pass = expected.test(msg);
          else pass = thrown instanceof expected;
        }
      }
      check(pass, `function to throw${expected !== undefined ? ` ${show(expected)}` : ""}`);
    },
  };
}

export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), { not: matchers(actual, true) });
}
