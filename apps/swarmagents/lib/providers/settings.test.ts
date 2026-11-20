/**
 * Unit tests for per-user routing settings (lib/providers/settings.ts):
 * defaults when missing, atomic round-trips, and corrupt files falling back
 * to defaults instead of breaking LLM traffic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "./store";
import {
  DEFAULT_USER_SETTINGS,
  parseUserSettings,
  readUserSettings,
  updateUserSettings,
  userSettingsFilePath,
  writeUserSettings,
} from "./settings";

const U = "local_tester@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-settings-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("readUserSettings returns defaults when no settings file exists", () => {
  assert.deepEqual(readUserSettings(U), DEFAULT_USER_SETTINGS);
});

test("writeUserSettings persists and round-trips; updateUserSettings merges", () => {
  writeUserSettings(U, { preferFreeProviders: false });
  assert.deepEqual(readUserSettings(U), { preferFreeProviders: false });
  assert.equal(userSettingsFilePath(U).startsWith(join(tempDir, "users")), true);

  updateUserSettings(U, { preferFreeProviders: true });
  assert.deepEqual(readUserSettings(U), DEFAULT_USER_SETTINGS);
});

test("settings files live per-user under the configured store directory", () => {
  const file = userSettingsFilePath(U);
  assert.ok(file.startsWith(join(tempDir, "users")), file);
  assert.equal(file.includes("tester@example.com"), false);
});

test("parseUserSettings and readUserSettings tolerate corrupt or malformed files", () => {
  assert.deepEqual(parseUserSettings(null), DEFAULT_USER_SETTINGS);
  assert.deepEqual(parseUserSettings({ preferFreeProviders: "yes" }), DEFAULT_USER_SETTINGS);
  const file = userSettingsFilePath(U);
  mkdirSync(require("node:path").dirname(file), { recursive: true });
  writeFileSync(file, "{ not json", "utf8");
  assert.deepEqual(readUserSettings(U), DEFAULT_USER_SETTINGS);
  writeFileSync(file, JSON.stringify({ preferFreeProviders: false }), "utf8");
  assert.deepEqual(readUserSettings(U), { preferFreeProviders: false });
});
