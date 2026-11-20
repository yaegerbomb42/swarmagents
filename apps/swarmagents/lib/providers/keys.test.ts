import test from "node:test";
import assert from "node:assert/strict";
import { maskProviderKey, providerKeySlots } from "./keys";

test("maskProviderKey keeps only the last four characters", () => {
  assert.equal(maskProviderKey("sk-secret-1234"), "••••1234");
  assert.equal(maskProviderKey("  sk-secret-1234  "), "••••1234");
});

test("maskProviderKey masks short keys completely", () => {
  assert.equal(maskProviderKey(""), "••••");
  assert.equal(maskProviderKey("abcd"), "••••");
  assert.equal(maskProviderKey("abcde"), "••••bcde");
});

test("providerKeySlots pairs each key with its index and mask", () => {
  assert.deepEqual(providerKeySlots(["sk-one-1111", "sk-two-2222"]), [
    { index: 0, mask: "••••1111" },
    { index: 1, mask: "••••2222" },
  ]);
  assert.deepEqual(providerKeySlots([]), []);
  assert.deepEqual(providerKeySlots(undefined), []);
});
