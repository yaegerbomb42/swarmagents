/**
 * Runtime #7 — toggling "Prefer free providers" must bust the per-user
 * router cache: effectiveRouter() keys the cache on the provider signature
 * + server mode, and the preferFree setting was missing from the key, so the
 * toggle had no effect until a server restart.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { configureProviderStorePaths, saveProvider } from "../providers/store";
import { writeUserSettings } from "../providers/settings";

let tempDir = "";
let seq = 0;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-router-cache-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

function user(): string {
  return `user-router-cache-${++seq}`;
}

test("toggling preferFreeProviders rebuilds the cached router", () => {
  const u = user();
  saveProvider(u, {
    id: "paid",
    apiKey: "sk-paid-test-key",
    rank: 0,
    models: ["paid-model"],
  });
  saveProvider(u, {
    id: "free",
    apiKey: "sk-free-test-key",
    rank: 1,
    isFree: true,
    models: ["free-model"],
  });

  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });

  writeUserSettings(u, { preferFreeProviders: false });
  const before = manager.routerForUser(u);
  assert.ok(before, "expected a router for the user");
  // Same settings: the cache holds.
  assert.strictEqual(manager.routerForUser(u), before);

  // Toggling the setting must bust the cache (new router instance).
  writeUserSettings(u, { preferFreeProviders: true });
  const after = manager.routerForUser(u);
  assert.ok(after, "expected a router after the toggle");
  assert.notStrictEqual(after, before);
  // And the new router is cached again under the new key.
  assert.strictEqual(manager.routerForUser(u), after);

  // The rebuild actually changes routing: free-first now wins.
  assert.equal(after!.selectForClaude({}, new Set())?.provider, "free");
  assert.equal(before!.selectForClaude({}, new Set())?.provider, "paid");
});
