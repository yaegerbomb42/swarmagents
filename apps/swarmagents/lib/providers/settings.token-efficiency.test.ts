/**
 * Tests for the tokenEfficiency settings (lib/providers/settings.ts):
 * defensive parsing, default resolution, and the harness-options mapping.
 * Mirrors the temp-store setup of settings.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "./store";
import {
  DEFAULT_SYSTEM_BUDGET_TOKENS,
  parseUserSettings,
  readUserSettings,
  systemPackerOptionsFor,
  tokenEfficiencyFor,
  updateUserSettings,
} from "./settings";

const U = "local_tester@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-settings-te-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("absent tokenEfficiency resolves to everything off with the default budget", () => {
  const settings = readUserSettings(U);
  assert.equal(settings.tokenEfficiency, undefined);
  assert.deepEqual(tokenEfficiencyFor(settings), {
    packSystemPrompt: false,
    systemBudgetTokens: DEFAULT_SYSTEM_BUDGET_TOKENS,
    cacheFriendlyOrder: false,
  });
  assert.deepEqual(systemPackerOptionsFor(settings), {
    pack: false,
    budgetTokens: DEFAULT_SYSTEM_BUDGET_TOKENS,
    cacheFriendlyOrder: false,
  });
});

test("parseUserSettings keeps valid tokenEfficiency fields and drops junk", () => {
  const parsed = parseUserSettings({
    preferFreeProviders: true,
    tokenEfficiency: { packSystemPrompt: true, systemBudgetTokens: 8000, cacheFriendlyOrder: "yes" },
  });
  assert.deepEqual(parsed.tokenEfficiency, { packSystemPrompt: true, systemBudgetTokens: 8000 });
  // A non-object or all-junk tokenEfficiency is dropped entirely.
  assert.equal(parseUserSettings({ tokenEfficiency: "on" }).tokenEfficiency, undefined);
  assert.equal(parseUserSettings({ tokenEfficiency: { packSystemPrompt: 1 } }).tokenEfficiency, undefined);
});

test("systemBudgetTokens is clamped into the supported range", () => {
  assert.equal(
    parseUserSettings({ tokenEfficiency: { systemBudgetTokens: 5 } }).tokenEfficiency?.systemBudgetTokens,
    1000,
  );
  assert.equal(
    parseUserSettings({ tokenEfficiency: { systemBudgetTokens: 10_000_000 } }).tokenEfficiency
      ?.systemBudgetTokens,
    200_000,
  );
  assert.equal(
    parseUserSettings({ tokenEfficiency: { systemBudgetTokens: -3 } }).tokenEfficiency,
    undefined,
  );
});

test("tokenEfficiency round-trips through the settings file", () => {
  updateUserSettings(U, {
    tokenEfficiency: { packSystemPrompt: true, systemBudgetTokens: 12000, cacheFriendlyOrder: true },
  });
  const settings = readUserSettings(U);
  assert.deepEqual(settings.tokenEfficiency, {
    packSystemPrompt: true,
    systemBudgetTokens: 12000,
    cacheFriendlyOrder: true,
  });
  assert.deepEqual(systemPackerOptionsFor(settings), {
    pack: true,
    budgetTokens: 12000,
    cacheFriendlyOrder: true,
  });
});
