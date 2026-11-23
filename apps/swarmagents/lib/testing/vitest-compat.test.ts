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

test("toEqual distinguishes undefined/null, NaN/Infinity, and does not collapse rich types", () => {
  // undefined no longer equals null (the old JSON round-trip did).
  assert.throws(() => expect(undefined).toEqual(null));
  assert.throws(() => expect(null).toEqual(undefined));
  expect(undefined).toEqual(undefined);
  expect(null).toEqual(null);

  // NaN and Infinity no longer serialize to null.
  assert.throws(() => expect(NaN).toEqual(null));
  assert.throws(() => expect(Infinity).toEqual(null));
  expect(NaN).toEqual(NaN);
  expect(Infinity).toEqual(Infinity);

  // Date / RegExp / Set / Map compare structurally instead of collapsing to {}.
  expect(new Date(0)).toEqual(new Date(0));
  assert.throws(() => expect(new Date(0)).toEqual(new Date(1)));
  expect(/a/g).toEqual(/a/g);
  assert.throws(() => expect(/a/g).toEqual(/a/));
  expect(new Set([1, 2])).toEqual(new Set([1, 2]));
  assert.throws(() => expect(new Set([1, 2])).toEqual(new Set([1, 3])));
  expect(new Map([["a", 1]])).toEqual(new Map([["a", 1]]));
  assert.throws(() => expect(new Map([["a", 1]])).toEqual(new Map([["a", 2]])));

  // BigInt compares by value (the old JSON path threw and reported a false pass).
  expect(1n).toEqual(1n);
  assert.throws(() => expect(1n).toEqual(1));

  // Circular structures do not crash (RangeError stack overflow).
  const a: Record<string, unknown> = { x: 1 };
  a.self = a;
  const b: Record<string, unknown> = { x: 1 };
  b.self = b;
  expect(a).toEqual(b);
});

test("toThrow only passes for functions that actually throw", () => {
  // Non-function received values must fail rather than catching the TypeError.
  assert.throws(() => expect(123).toThrow());
  assert.throws(() => expect(null).toThrow());
  assert.throws(() => expect({}).toThrow());

  // Real assertions on thrown error messages / classes still work.
  expect(() => { throw new Error("kaboom"); }).toThrow("kaboom");
  expect(() => { throw new Error("kaboom"); }).toThrow(/boom/);
  expect(() => { throw new TypeError("bad type"); }).toThrow(TypeError);
  assert.throws(() => expect(() => { throw new Error("nope"); }).toThrow("different"));
  assert.throws(() => expect(() => 42).toThrow());
});

test("toMatchObject guards circular refs, non-plain objects, and missing keys", () => {
  // A missing key must not match `{ key: undefined }`.
  assert.throws(() => expect({}).toMatchObject({ key: undefined }));
  expect({ key: undefined }).toMatchObject({ key: undefined });

  // Non-plain expected values (Date, RegExp) compare structurally.
  expect({ d: new Date(0) }).toMatchObject({ d: new Date(0) });
  assert.throws(() => expect({ d: new Date(0) }).toMatchObject({ d: new Date(1) }));
  expect({ r: /a/ }).toMatchObject({ r: /a/ });
  assert.throws(() => expect({ r: /a/ }).toMatchObject({ r: /b/ }));

  // Partial matches still succeed for plain nested objects.
  expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });

  // Circular structures do not recurse forever.
  const actual: Record<string, unknown> = { name: "x" };
  actual.self = actual;
  const expected: Record<string, unknown> = { name: "x" };
  expected.self = expected;
  expect(actual).toMatchObject(expected);
});

test("ordering matchers reject non-numbers instead of coercing", () => {
  // null/undefined/strings/NaN must never pass via JS coercion (null < 1).
  assert.throws(() => expect(null).toBeLessThan(1));
  assert.throws(() => expect(undefined).toBeLessThanOrEqual(5));
  assert.throws(() => expect("5").toBeGreaterThan(1));
  assert.throws(() => expect(true).toBeGreaterThanOrEqual(0));
  assert.throws(() => expect(NaN).toBeGreaterThanOrEqual(0));
  assert.throws(() => expect(null).toBeCloseTo(0));

  // Real numbers still compare normally.
  expect(5).toBeLessThan(10);
  expect(5).toBeLessThanOrEqual(5);
  expect(5).toBeGreaterThan(1);
  expect(5).toBeGreaterThanOrEqual(5);
  expect(1.001).toBeCloseTo(1, 2);
  assert.throws(() => expect(1.1).toBeCloseTo(1, 2));
});
