/**
 * gitAutoCommit user-settings tests: the per-user opt-in parses
 * defensively (boolean only), defaults to absent/off, and round-trips
 * through the settings file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureProviderStorePaths } from "./store";
import {
  gitAutoCommitEnabled,
  parseUserSettings,
  readUserSettings,
  updateUserSettings,
  writeUserSettings,
} from "./settings";

const U = "local_autocommit@example.com";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-settings-autocommit-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

test("absent by default: auto-commit is off until opted in", () => {
  const parsed = parseUserSettings({ preferFreeProviders: true });
  assert.equal(parsed.gitAutoCommit, undefined);
  assert.equal(gitAutoCommitEnabled(parsed), false);
  assert.equal(gitAutoCommitEnabled(readUserSettings(U)), false);
});

test("parses an explicit boolean both ways", () => {
  assert.equal(parseUserSettings({ gitAutoCommit: true }).gitAutoCommit, true);
  assert.equal(gitAutoCommitEnabled(parseUserSettings({ gitAutoCommit: true })), true);
  assert.equal(parseUserSettings({ gitAutoCommit: false }).gitAutoCommit, false);
  assert.equal(gitAutoCommitEnabled(parseUserSettings({ gitAutoCommit: false })), false);
});

test("drops non-boolean values instead of coercing them", () => {
  for (const bad of ["true", 1, 0, null, {}, []]) {
    const parsed = parseUserSettings({ gitAutoCommit: bad });
    assert.equal(parsed.gitAutoCommit, undefined, `value ${JSON.stringify(bad)} must be dropped`);
    assert.equal(gitAutoCommitEnabled(parsed), false);
  }
});

test("round-trips through the settings file and merges on update", () => {
  writeUserSettings(U, { preferFreeProviders: true, gitAutoCommit: true });
  assert.equal(readUserSettings(U).gitAutoCommit, true);
  assert.equal(gitAutoCommitEnabled(readUserSettings(U)), true);

  const next = updateUserSettings(U, { gitAutoCommit: false });
  assert.equal(next.gitAutoCommit, false);
  assert.equal(readUserSettings(U).gitAutoCommit, false);
  assert.equal(gitAutoCommitEnabled(readUserSettings(U)), false);
});
