import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "./vitest-compat";

test("vitest-compat matchers pass and fail correctly", () => {
  expect(1).toBe(1);
  expect([1, 2]).toContain(2);
  expect({ a: 1, b: { c: 2 } }).toMatchObject({ b: { c: 2 } });
  expect({ a: [1] }).toEqual({ a: [1] });
  expect(null).toBeNull();
  expect(() => { throw new Error("boom"); }).toThrow("boom");
  expect("abc").not.toContain("z");
  assert.throws(() => expect(1).toBe(2));
  assert.throws(() => expect([1]).toContain(3));
  assert.throws(() => expect({ a: 1 }).toEqual({ a: 2 }));
  assert.throws(() => expect(() => undefined).toThrow());
  assert.throws(() => expect(1).not.toBe(1));
  assert.throws(() => expect(5).toBeLessThan(3));
});

test("toEqual does not equate distinct primitive and structural values", () => {
  // undefined / null and NaN / Infinity used to collapse to null via JSON.
  expect(undefined).toEqual(undefined);
  expect(NaN).toEqual(NaN);
  expect(Infinity).toEqual(Infinity);
  assert.throws(() => expect(undefined).toEqual(null));
  assert.throws(() => expect(null).toEqual(undefined));
  assert.throws(() => expect(NaN).toEqual(null));
  assert.throws(() => expect(Infinity).toEqual(null));

  // Date / Set / Map / RegExp used to collapse to {} (or a string).
  expect(new Date("2020-01-01T00:00:00Z")).toEqual(new Date("2020-01-01T00:00:00Z"));
  expect(new Set([1, 2])).toEqual(new Set([1, 2]));
  expect(new Map([["a", 1]])).toEqual(new Map([["a", 1]]));
  expect(/abc/i).toEqual(/abc/i);
  assert.throws(() => expect(new Date("2020-01-01")).toEqual(new Date("2021-01-01")));
  assert.throws(() => expect(new Set([1])).toEqual(new Set([2])));
  assert.throws(() => expect(new Map([["a", 1]])).toEqual(new Map([["a", 2]])));
  assert.throws(() => expect(/abc/).toEqual(/abd/));
  assert.throws(() => expect(/abc/).toEqual(/abc/i));

  // BigInt and circular structures must not throw a serialization error.
  expect(9007199254740993n).toEqual(9007199254740993n);
  assert.throws(() => expect(1n).toEqual(2n));
  const left: Record<string, unknown> = { v: 1 };
  left.self = left;
  const right: Record<string, unknown> = { v: 1 };
  right.self = right;
  const different: Record<string, unknown> = { v: 2 };
  different.self = different;
  expect(left).toEqual(right);
  assert.throws(() => expect(left).toEqual(different));
});

test("toThrow requires a callable actual value", () => {
  assert.throws(() => expect(123).toThrow());
  assert.throws(() => expect("nope").toThrow("nope"));
  assert.throws(() => expect(null).toThrow());
  expect(123).not.toThrow();
  expect(() => undefined).not.toThrow("boom");
});

test("toMatchObject guards cycles, non-plain objects, and undefined keys", () => {
  const actual: Record<string, unknown> = { a: 1 };
  actual.self = actual;
  const expected: Record<string, unknown> = { a: 1 };
  expected.self = expected;
  expect(actual).toMatchObject(expected);
  assert.throws(() => expect(actual).toMatchObject({ a: 2 }));

  // Non-plain expected values are compared structurally, not by empty keys.
  expect(new Date("2020-01-01T00:00:00Z")).toMatchObject(new Date("2020-01-01T00:00:00Z"));
  expect(/abc/i).toMatchObject(/abc/i);
  assert.throws(() => expect({}).toMatchObject(new Date("2020-01-01")));
  assert.throws(() => expect(new Date("2020-01-01")).toMatchObject(new Date("2021-01-01")));
  assert.throws(() => expect(/abc/).toMatchObject(/abc/i));

  // A missing key must not match an explicitly-undefined expectation.
  expect({}).not.toMatchObject({ key: undefined });
  assert.throws(() => expect({}).toMatchObject({ key: undefined }));
  expect({ key: undefined }).toMatchObject({ key: undefined });
});

test("numeric comparison matchers reject non-numbers and NaN", () => {
  const bad: unknown[] = [null, undefined, NaN, "1", {}];
  for (const value of bad) {
    assert.throws(() => expect(value).toBeLessThan(1));
    assert.throws(() => expect(value).toBeLessThanOrEqual(1));
    assert.throws(() => expect(value).toBeGreaterThan(1));
    assert.throws(() => expect(value).toBeGreaterThanOrEqual(1));
    assert.throws(() => expect(value).toBeCloseTo(1));
    expect(value).not.toBeLessThan(1);
  }
  expect(0).toBeLessThan(1);
  expect(1).toBeLessThanOrEqual(1);
  expect(2).toBeGreaterThan(1);
  expect(1).toBeGreaterThanOrEqual(1);
  expect(1.0001).toBeCloseTo(1, 3);
});
