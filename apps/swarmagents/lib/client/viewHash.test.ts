import test from "node:test";
import assert from "node:assert/strict";
import { buildViewHash, parseViewHash } from "./viewHash";

test("parseViewHash reads the workspace page and tab from the hash", () => {
  assert.deepEqual(parseViewHash("#view=computer&tab=browser"), { landing: false, view: "browser" });
  assert.deepEqual(parseViewHash("#view=computer&tab=files"), { landing: false, view: "files" });
  assert.deepEqual(parseViewHash("#view=computer&tab=desktop"), { landing: false, view: "desktop" });
  assert.deepEqual(parseViewHash("#view=computer"), { landing: false, view: "terminal" });
  assert.deepEqual(parseViewHash("#view=overview"), { landing: true, view: "terminal" });
});

test("parseViewHash falls back to the Overview landing page for unknown hashes", () => {
  assert.deepEqual(parseViewHash(""), { landing: true, view: "terminal" });
  assert.deepEqual(parseViewHash("#view=nowhere&tab=browser"), { landing: true, view: "terminal" });
  assert.deepEqual(parseViewHash("#view=computer&tab=telemetry"), { landing: false, view: "terminal" });
});

test("buildViewHash round-trips through parseViewHash", () => {
  for (const state of [
    { landing: true, view: "terminal" as const },
    { landing: false, view: "terminal" as const },
    { landing: false, view: "browser" as const },
    { landing: false, view: "files" as const },
    { landing: false, view: "desktop" as const },
  ]) {
    assert.deepEqual(parseViewHash(buildViewHash(state)), state);
  }
  assert.equal(buildViewHash({ landing: true, view: "browser" }), "#view=overview");
  assert.equal(buildViewHash({ landing: false, view: "browser" }), "#view=computer&tab=browser");
});
