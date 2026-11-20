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
