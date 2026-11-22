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

function deepEqual(actual: unknown, expected: unknown): boolean {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSubset(actual: unknown, expected: unknown, seen = new WeakMap<object, object>()): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  // Non-plain objects (Date, RegExp, Map, Set, class instances) are compared
  // structurally rather than by their (often empty) enumerable own keys.
  if (!isPlainObject(expected) && !Array.isArray(expected)) return deepEqual(actual, expected);
  // Cycle guard: a previously visited expected object must be paired with the
  // same actual object, otherwise the recursion could loop forever.
  if (seen.get(expected) === actual) return true;
  seen.set(expected, actual);
  try {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) return false;
      return expected.every((e, i) => isSubset(actual[i], e, seen));
    }
    return Object.entries(expected).every(([k, v]) => {
      // An absent key must not match an explicitly undefined expectation.
      if (v === undefined && !Object.prototype.hasOwnProperty.call(actual, k)) return false;
      return isSubset((actual as Record<string, unknown>)[k], v, seen);
    });
  } finally {
    seen.delete(expected);
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, message: string): void => {
    if (pass === negate) assert.fail(negate ? `Expected NOT: ${message}` : message);
  };
  const show = (v: unknown) => format("%o", v);
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `${show(actual)} to be ${show(expected)}`),
    toEqual: (expected: unknown) => {
      check(deepEqual(actual, expected), `${show(actual)} to equal ${show(expected)}`);
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
    toBeLessThan: (n: number) => check(isNumber(actual) && actual < n, `${show(actual)} < ${n}`),
    toBeLessThanOrEqual: (n: number) => check(isNumber(actual) && actual <= n, `${show(actual)} <= ${n}`),
    toBeGreaterThan: (n: number) => check(isNumber(actual) && actual > n, `${show(actual)} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check(isNumber(actual) && actual >= n, `${show(actual)} >= ${n}`),
    toBeCloseTo: (n: number, digits = 2) =>
      check(isNumber(actual) && Math.abs(actual - n) < Math.pow(10, -digits) / 2, `${show(actual)} to be close to ${n}`),
    toBeInstanceOf: (ctor: abstract new (...args: never[]) => unknown) =>
      check(actual instanceof ctor, `${show(actual)} to be instance of ${ctor.name}`),
    toThrow: (expected?: string | RegExp | (abstract new (...args: never[]) => unknown)) => {
      let thrown: unknown;
      let didThrow = false;
      const callable = typeof actual === "function";
      if (callable) {
        try {
          (actual as () => unknown)();
        } catch (err) {
          didThrow = true;
          thrown = err;
        }
      }
      let pass = callable && didThrow;
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
