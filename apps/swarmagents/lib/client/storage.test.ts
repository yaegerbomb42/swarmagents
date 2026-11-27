import test from "node:test";
import assert from "node:assert/strict";
import { clearSessionValue, readSessionValue, writeSessionValue } from "./storage";

test("session storage helpers round-trip and tolerate a missing storage", () => {
  const previous = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  try {
    const store = new Map<string, string>();
    (globalThis as { sessionStorage: unknown }).sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    assert.equal(readSessionValue("k"), undefined);
    writeSessionValue("k", "v");
    assert.equal(readSessionValue("k"), "v");
    clearSessionValue("k");
    assert.equal(readSessionValue("k"), undefined);
  } finally {
    if (previous === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    else (globalThis as { sessionStorage: unknown }).sessionStorage = previous;
  }
  // Without sessionStorage (plain node) the helpers are no-ops, not throws.
  assert.equal(readSessionValue("k"), undefined);
  writeSessionValue("k", "v");
  clearSessionValue("k");
});
