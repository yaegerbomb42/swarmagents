/**
 * Decision Brain user-settings tests: the per-user `decisionBrain` field
 * parses defensively (known keys only, primitive types), round-trips
 * through the settings file, and defaults to absent (brain off).
 * Range/default validation itself lives in resolveDecisionBrainSettings
 * and is covered by the decision-brain suite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "./store";
import {
  parseUserSettings,
  readUserSettings,
  updateUserSettings,
  writeUserSettings,
} from "./settings";

const U = "local_brain@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-settings-brain-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("decisionBrain is absent by default (brain off)", () => {
  assert.equal(readUserSettings(U).decisionBrain, undefined);
  assert.equal(parseUserSettings({}).decisionBrain, undefined);
  assert.equal(parseUserSettings(null).decisionBrain, undefined);
});

test("parseUserSettings copies the known decisionBrain keys", () => {
  const parsed = parseUserSettings({
    preferFreeProviders: true,
    decisionBrain: {
      enabled: true,
      confidenceThreshold: 0.8,
      hookTimeoutMs: 900,
      maxTurns: 25,
    },
  });
  assert.deepEqual(parsed.decisionBrain, {
    enabled: true,
    confidenceThreshold: 0.8,
    hookTimeoutMs: 900,
    maxTurns: 25,
  });
});

test("parseUserSettings drops unknown keys and wrong-typed values", () => {
  const parsed = parseUserSettings({
    decisionBrain: {
      enabled: "yes",
      confidenceThreshold: "high",
      hookTimeoutMs: Number.NaN,
      maxTurns: 12,
      somethingElse: true,
    },
  });
  assert.deepEqual(parsed.decisionBrain, { maxTurns: 12 });
});

test("parseUserSettings ignores a non-object decisionBrain", () => {
  assert.equal(parseUserSettings({ decisionBrain: true }).decisionBrain, undefined);
  assert.equal(parseUserSettings({ decisionBrain: [1, 2] }).decisionBrain, undefined);
  assert.equal(parseUserSettings({ decisionBrain: "on" }).decisionBrain, undefined);
});

test("decisionBrain round-trips through the settings file", () => {
  writeUserSettings(U, {
    preferFreeProviders: true,
    decisionBrain: { enabled: true, maxTurns: 30 },
  });
  assert.deepEqual(readUserSettings(U).decisionBrain, { enabled: true, maxTurns: 30 });
});

test("updateUserSettings can flip the brain on without touching other settings", () => {
  writeUserSettings(U, { preferFreeProviders: false, perRunBudgetUsd: 5 });
  const next = updateUserSettings(U, { decisionBrain: { enabled: true } });
  assert.equal(next.preferFreeProviders, false);
  assert.equal(next.perRunBudgetUsd, 5);
  assert.deepEqual(readUserSettings(U).decisionBrain, { enabled: true });
});
