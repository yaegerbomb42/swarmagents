import assert from "node:assert/strict";
import { test } from "node:test";

import { devModeFromSearch } from "./devMode";

test("dev=1 turns dev mode on, dev=0 turns it off, no parameter keeps the stored value", () => {
  assert.equal(devModeFromSearch("?dev=1", false), true);
  assert.equal(devModeFromSearch("?dev=0", true), false);
  assert.equal(devModeFromSearch("", true), true);
  assert.equal(devModeFromSearch("", false), false);
  assert.equal(devModeFromSearch("?dev=2", true), true);
});
