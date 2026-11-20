import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MASCOT_VARIANT,
  MASCOT_VARIANT_STORAGE_KEY,
  isMascotVariant,
  mascotVariantFromLocation,
  parseMascotVariantQuery,
  persistMascotVariant,
  readStoredMascotVariant,
  resolveMascotVariant,
  type MascotVariantStorage,
} from "./variant";

function fakeStorage(seed: Record<string, string> = {}): MascotVariantStorage & { values: Record<string, string> } {
  const values = { ...seed };
  return {
    values,
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

test("the svg variant is the default", () => {
  assert.equal(DEFAULT_MASCOT_VARIANT, "svg");
  assert.equal(resolveMascotVariant(), "svg");
  assert.equal(resolveMascotVariant({ queryParam: null, stored: null }), "svg");
});

test("a query param overrides localStorage", () => {
  assert.equal(resolveMascotVariant({ queryParam: "svg", stored: "sprite" }), "svg");
  assert.equal(resolveMascotVariant({ queryParam: "sprite", stored: "svg" }), "sprite");
  assert.equal(mascotVariantFromLocation("?mascot=svg", fakeStorage({ [MASCOT_VARIANT_STORAGE_KEY]: "sprite" })), "svg");
  assert.equal(mascotVariantFromLocation("mascot=svg", fakeStorage({ [MASCOT_VARIANT_STORAGE_KEY]: "sprite" })), "svg");
});

test("localStorage is used when the query string has no valid choice", () => {
  assert.equal(mascotVariantFromLocation("", fakeStorage({ [MASCOT_VARIANT_STORAGE_KEY]: "svg" })), "svg");
  assert.equal(mascotVariantFromLocation("?mascot=bogus", fakeStorage({ [MASCOT_VARIANT_STORAGE_KEY]: "svg" })), "svg");
  assert.equal(resolveMascotVariant({ queryParam: "bogus", stored: "svg" }), "svg");
});

test("malformed or missing preferences fall back to the default", () => {
  assert.equal(mascotVariantFromLocation("", null), "svg");
  assert.equal(mascotVariantFromLocation("", fakeStorage({ [MASCOT_VARIANT_STORAGE_KEY]: "gif" })), "svg");
  assert.equal(readStoredMascotVariant(fakeStorage()), null);
  assert.equal(readStoredMascotVariant(null), null);
  assert.equal(isMascotVariant("svg"), true);
  assert.equal(isMascotVariant("sprite"), true);
  assert.equal(isMascotVariant("gif"), false);
});

test("query parsing accepts only the two known values", () => {
  assert.equal(parseMascotVariantQuery("?mascot=svg"), "svg");
  assert.equal(parseMascotVariantQuery("?mascot=sprite"), "sprite");
  assert.equal(parseMascotVariantQuery("?mascot=SVG"), null);
  assert.equal(parseMascotVariantQuery("?view=computer"), null);
  assert.equal(parseMascotVariantQuery(""), null);
});

test("choosing a style persists it", () => {
  const storage = fakeStorage();
  persistMascotVariant("svg", storage);
  assert.equal(storage.values[MASCOT_VARIANT_STORAGE_KEY], "svg");
  assert.equal(readStoredMascotVariant(storage), "svg");
});

test("storage failures never break the mascot", () => {
  const throwing: MascotVariantStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readStoredMascotVariant(throwing), null);
  assert.doesNotThrow(() => persistMascotVariant("svg", throwing));
});
